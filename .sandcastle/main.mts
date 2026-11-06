// Sandcastle runner — scripted selection, implement + review per ticket, git merge
//
// Each iteration:
//   Select   (host, no model)  `tracker list` gives the open tickets; the rules in
//                               lib/selection.mjs pick the ones that can start now.
//   Prepare  (host, no model)  Each ticket's worktree is made or reused, edits an
//                               interrupted run left are saved as a WIP commit, and
//                               the branch is brought up to its base.
//   Implement + review         An implementer, then a reviewer, in one sandbox per
//                               ticket, at most PARALLEL at a time. Stage markers
//                               (lib/branch-state.mjs) record each one finishing, so
//                               a ticket stopped part-way resumes where it stopped.
//   Merge    (host, git)       A reviewed branch is merged into its project's
//                               checkout with plain git. Only a conflict calls a
//                               model: a resolver on the ticket's own branch.
//   Close    (host, tracker)   A ticket is closed once its branch is in the checkout.
//   Check    (sandbox, no model) No ticket starts on a checkout whose tip has not
//                               passed the full check, its CI's own steps
//                               (sandbox/full-check.sh); each tip once, so a round's
//                               merges are checked before the next round's tickets,
//                               and the last round's when the loop ends. A red tip
//                               the runner's merges made goes to a fixer, then the
//                               check again; still red, the run stops. A red tip
//                               someone else made holds that project's tickets.
//   Push     (host, git)       Each checkout's branch, and each unmerged ticket
//                               branch, goes to origin, so the work can be taken up
//                               on another machine. Again when the run ends, also
//                               on an error or Ctrl-C.
//
// Before selection, a checkout on `main` that a ticket waits on is moved to the
// effort's branch (lib/effort-branch.mjs), `feat/<effort>`. A checkout on any other
// branch stays.
//
// This repository is its own one project (PROJECTS below): the tickets under
// `grilled/`, this runner and the application code share one git, so the root is
// the checkout a ticket merges into and the place `tracker close` commits.
//
// With SANDCASTLE_SLACK_WEBHOOK_URL set, each event (a round's start and end, a
// ticket's failure, a full check, the run's end or stop) also goes to Slack
// (lib/notify.mjs).
//
// The loop repeats, up to `--rounds` (MAX_ITERATIONS by default), so tickets unblocked by this round's
// merges start in the next. A ticket is attempted once per invocation, and when the
// usage allowance runs out no further model call is started.
//
// Usage:
//   npm run sandcastle -- [--map <effort>]... [--parallel <N>] [--rounds <N>] [--dry-run]
//                          [--no-push]

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import {
  branchProgress,
  clearStages,
  ensureWorktree,
  findWorktree,
  markStage,
  preserveWip,
  restoreStoredLineEndings,
  stageOf,
  syncWithBase,
} from "./lib/branch-state.mjs";
import {
  changesSinceCheck,
  checkState,
  clearCheckPending,
  keepFixAttempt,
  markCheckPassed,
  markCheckPending,
  prepareCheckBranch,
} from "./lib/check-branch.mjs";
import {
  catchUpWithOrigin,
  fetchOrigin,
  moveToEffortBranch,
  needsEffortBranch,
  planEffortBranch,
  pushBranch,
  takeUpTicketBranch,
} from "./lib/effort-branch.mjs";
import { commitsAhead, currentBranch, git, isAncestor, revParse } from "./lib/git.mjs";
import { mergeIntoCheckout } from "./lib/merge.mjs";
import { markNodeModulesReady, prepareNodeModules } from "./lib/node-modules.mjs";
import { createNotifier, slackSettings } from "./lib/notify.mjs";
import { reviewDiff } from "./lib/review-diff.mjs";
import { RunRecord } from "./lib/run-record.mjs";
import { rootHoldReason, selectTickets } from "./lib/selection.mjs";
import { afterTurn } from "./lib/turns.mjs";
import { collectRunUsage, isAllowanceSpent, totalUsage } from "./lib/usage.mjs";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of select→implement→merge cycles before stopping.
const MAX_ITERATIONS = 10;

// How many ticket pipelines run at once when `--parallel` does not say. Each one
// is a sandbox of its own, and a web sandbox takes 2GB or more at its peak (a
// `next build`) against Docker's ~9.7GB VM. Five at once were all killed
// together on 2026-10-05, and one of four ran out of memory in its review build
// on 2026-10-06. Three leaves room for the local stack.
const DEFAULT_PARALLEL = 3;

// The model for each role: Opus for every one. Each must be a model the image's
// pinned Claude Code accepts.
const MODELS = {
  implementer: "claude-opus-5-5[1m]",
  reviewer: "claude-opus-5-5[1m]",
  resolver: "claude-opus-5-5[1m]",
  fixer: "claude-opus-5-5[1m]",
} as const;

// An implementer turn is one Claude Code session. A turn that ends without the
// completion promise is resumed, in the same session, up to this many turns in all;
// two turns in a row with no new commit and no new edit stop the ticket early.
// The work is kept either way and the next invocation resumes it. (The old limit
// was 100 iterations, each a fresh session that re-read the repository.)
const MAX_IMPLEMENT_TURNS = 4;
const MAX_IDLE_TURNS = 2;

// The verify gate prints nothing until each check exits, and sandcastle fails a
// run that is silent for its idle timeout, 600s by default. Affected checks are
// short, but three sandboxes running a typecheck at once are not.
const IDLE_TIMEOUT_SECONDS = 1_200;

// Claude Code moves a Bash command to the background after two minutes, and the
// agents then spent turns polling its output file with sleep loops (2026-10-30).
// These let the verify gate run in the foreground for as long as it needs.
const AGENT_SHELL_ENV = {
  BASH_DEFAULT_TIMEOUT_MS: "1800000",
  BASH_MAX_TIMEOUT_MS: "3600000",
};

const DRY_RUN = process.argv.includes("--dry-run");

// A run pushes its work so it can be taken up on another machine. `--no-push` is
// for the smoke test only: its branches are throwaway, and cleanup.sh deletes
// them here but could not delete them on origin.
const PUSH = !process.argv.includes("--no-push");

/**
 * This root's .env, as an env map to launch every sandbox with.
 *
 * Sandcastle does not read this file on most runs. Its resolver reads
 * `<cwd>/.sandcastle/.env` and consults process.env *only for the keys that file
 * already names* — so with `cwd` set to a project directory, and those
 * deliberately having no .env, it resolves to nothing at all: the container is
 * started with no credentials and every iteration ends at `Not logged in ·
 * Please run /login`. Exporting the token first does not help either, for the
 * same reason.
 *
 * Passing this map to `docker({ env })` is what fixes that: provider env is
 * merged in on every path, `run()` and `createSandbox()` alike, and wins over the
 * resolver — so this one file is the credentials for every sandbox.
 *
 * Values are also mirrored into process.env for host-side child processes, and
 * an already-exported value wins over the file.
 */
function loadRootEnv(): Record<string, string> {
  const env: Record<string, string> = {};

  let contents: string;
  try {
    contents = readFileSync("./.sandcastle/.env", "utf8");
  } catch {
    return env; // No file — rely on whatever is already exported.
  }

  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue; // Comment, blank, or malformed.
    const [, key, rawValue] = match;
    const value = rawValue!.trim().replace(/^(['"])(.*)\1$/, "$2");
    if (value && process.env[key!] === undefined) process.env[key!] = value;
    // Read back rather than using `value`: an exported override wins, and a key
    // left blank in the file still picks up an exported value.
    const resolved = process.env[key!];
    if (resolved) env[key!] = resolved;
  }

  return env;
}

// Settings for the host alone stay out of the sandbox: an agent has no use for
// the Slack webhook, and with it could post to the channel.
const HOST_ONLY_ENV = /^SANDCASTLE_SLACK_/;

const SANDBOX_ENV = {
  ...Object.fromEntries(Object.entries(loadRootEnv()).filter(([key]) => !HOST_ONLY_ENV.test(key))),
  ...AGENT_SHELL_ENV,
};

/**
 * The efforts this run is limited to, or none for every effort:
 *
 *   npm run sandcastle -- --map hp-1-order-intake
 *
 * `--map` is repeatable, or comma-separated; an exported SANDCASTLE_MAPS works
 * too. The names are effort directories under `grilled/`. The host-side
 * `tracker list` reads the selection from SANDCASTLE_MAPS.
 */
function selectedMaps(argv: string[]): string[] {
  const fromArgs: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--map") fromArgs.push(argv[++index] ?? "");
    else if (arg.startsWith("--map=")) fromArgs.push(arg.slice("--map=".length));
  }
  const raw =
    fromArgs.length > 0 ? fromArgs.join(",") : (process.env.SANDCASTLE_MAPS ?? "");
  return raw
    .split(",")
    .map((map) => map.trim())
    .filter(Boolean);
}

const MAPS = selectedMaps(process.argv.slice(2));
if (MAPS.length > 0) process.env.SANDCASTLE_MAPS = MAPS.join(",");

/**
 * A whole-number flag, `--<name> 5` or `--<name>=5`, else the exported variable,
 * else `fallback`. Anything but a whole number of 1 or more stops the run.
 */
function wholeNumberFlag(argv: string[], name: string, variable: string, fallback: number): number {
  let raw = process.env[variable] || undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === `--${name}`) raw = argv[++index] ?? "";
    else if (arg.startsWith(`--${name}=`)) raw = arg.slice(`--${name}=`.length);
  }
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`--${name} takes a whole number of 1 or more, not "${raw}".`);
    process.exit(1);
  }
  return value;
}

// How many ticket pipelines run at once: `--parallel 5`, or SANDCASTLE_PARALLEL.
// Every ready ticket is queued; the rest wait for a free slot.
const PARALLEL = wholeNumberFlag(process.argv.slice(2), "parallel", "SANDCASTLE_PARALLEL", DEFAULT_PARALLEL);

// How many rounds run before the runner stops: `--rounds 1`, or SANDCASTLE_ROUNDS.
// One round finishes the tickets ready now, and starts none they unblock.
const ROUNDS = wholeNumberFlag(process.argv.slice(2), "rounds", "SANDCASTLE_ROUNDS", MAX_ITERATIONS);

/**
 * The flags the hint below repeats, rebuilt from what was parsed rather than
 * copied from argv, so a stray positional argument (a bare `10` on Windows)
 * never lands in the command: a run limited with `--map` stays limited when
 * rerun, and nothing else is carried over.
 */
function rerunFlags(): string[] {
  return MAPS.flatMap((map) => ["--map", map]);
}

/**
 * Slack, from SANDCASTLE_SLACK_* in .sandcastle/.env (lib/notify.mjs). A wrong
 * value stops the run here, on a dry run too; a dry run sends nothing.
 */
const slack = (() => {
  try {
    const settings = slackSettings(process.env);
    return createNotifier(DRY_RUN ? null : settings, { efforts: MAPS });
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
})();

// Set when the run-start message is sent, and when the run ends normally: a
// process that exits between the two sends `run-stopped`, with `stopCause`.
let runStarted = false;
let runEnded = false;
let stopCause: string | null = null;

// The round in progress, for the messages a ticket's failure sends.
let currentRound = 0;

// Printed first, under make's "[+] Docker is running". The run then waits
// STARTUP_DELAY_SECONDS before it starts, so there is time to stop and rerun.
console.log(`[+] Up to ${PARALLEL} job(s) run in parallel`);
if (slack.enabled) console.log(`[+] Slack: ${slack.events.join(", ")}`);
console.log(
  `    To change it, stop now (Ctrl-C) and run: npm run sandcastle -- ${[
    ...rerunFlags(),
    "--parallel",
    "<N>",
  ].join(" ")}`,
);

/**
 * Promise.allSettled over `items`, with at most `limit` runs in flight. A slot
 * frees as soon as its run settles, and results keep the order of `items`, so
 * `settled[i]` is still `items[i]`'s.
 */
async function allSettledWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const settled: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      try {
        settled[index] = { status: "fulfilled", value: await run(items[index]!) };
      } catch (reason) {
        settled[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return settled;
}

// The one project, and where its work is committed: this repository's root.
// `cwd` anchors the git operations and sandcastle's `.sandcastle/worktrees/` and
// `.sandcastle/logs/`, which .sandcastle/.gitignore hides. `aliases` are the
// spellings a ticket's Repo field may use, and lib/selection.mjs routes by them;
// a Repo field naming none of them, or `n/a — operational`, holds the ticket.
//
// `cwd` must be the real directory, never a symlink to it: sandcastle mounts
// `<cwd>/.git` at that same absolute path, while `git worktree add` records the
// path it resolved to, and a mismatch fails every sandbox with `fatal: not a git
// repository`. `realpathSync` keeps that true wherever this folder is moved.
const PROJECTS = {
  "harbor-point": {
    cwd: realpathSync("."),
    aliases: ["app", "api", "web", "infra", "harbor-point-app"],
  },
} as const;

// The root takes the effort's branch with the project, so it never needs a
// branch of its own (putCheckoutsOnEffortBranches).
const ROOT_IS_PROJECT = Object.values(PROJECTS).some((project) => project.cwd === realpathSync("."));

type ProjectName = keyof typeof PROJECTS;

interface Ticket {
  id: string;
  title: string;
  map: string;
  project: ProjectName;
  base: string;
  branch: string;
}

/** A ticket selection holds. `project` and `checkout` are set when it waits only for its effort's branch. */
interface Held {
  id: string;
  map: string;
  reason: string;
  project?: ProjectName;
  checkout?: string | null;
}

type Outcome = "complete" | "incomplete" | "failed" | "not-started";

/** The branch a project's checkout is on, or null when it is absent or detached. */
function checkoutBranch(project: ProjectName): string | null {
  const cwd = PROJECTS[project].cwd;
  if (!existsSync(join(cwd, ".git"))) return null;
  try {
    return currentBranch(cwd);
  } catch {
    return null;
  }
}

/**
 * The verify gate, as the command a sandbox runs. The script itself is
 * `.sandcastle/sandbox/verify.sh`: what each project checks, and what it leaves
 * to CI, is written there.
 */
const verifyCommand = (ticket: Ticket) =>
  `bash ../.sandcastle-tools/verify.sh ${ticket.project} ${ticket.base}`;

// Past these, a full check is red with "timed out": a hung test must not hold the
// run forever.
const FULL_CHECK_MINUTES: Record<ProjectName, number> = {
  "harbor-point": 30,
};

/** The full check of a checkout, as the command a sandbox runs: `sandbox/full-check.sh`. */
const fullCheckCommand = (project: ProjectName) =>
  `timeout --kill-after=60 ${FULL_CHECK_MINUTES[project]}m bash ../.sandcastle-tools/full-check.sh ${project}`;

// Read once from this root and injected into the implementer's and the reviewer's
// prompts. The implementer needs it as much as the reviewer: a rule only the
// reviewer sees is a rule the code is first written against, and the reviewer is
// told to preserve behaviour, so it may leave the violation in place. (That is how
// a stock `<button>` reached a branch in place of `<Button original>`.) Injecting it
// rather than letting an agent open `.sandcastle/CODING_STANDARDS.md` in its
// worktree means the host's current copy wins over the one its branch was cut
// with.
const CODING_STANDARDS = readFileSync(
  "./.sandcastle/CODING_STANDARDS.md",
  "utf8",
);

// What a ticket sandbox sees beyond its worktree, mounted read-only one level up.
//
// The worktree has its own `grilled/`, as committed when its branch was cut. The
// host's current copy is mounted at /home/agent/grilled, so `../grilled/…` shows
// a ticket, its map and its effort's `assets/` as they are now, which is where the
// prompt sends the agent. `.sandcastle/sandbox/` holds the verify gate, mounted the
// same way so the host's copy runs, not the branch's.
//
// Only these. Mounting the root itself would expose `.sandcastle/.env` and the
// other worktrees. Read-only, so a run cannot edit a ticket; `close` runs on the
// host. Relative host paths resolve from process.cwd(), which is this root, like
// `./.sandcastle/.env` above.
const SANDBOX_MOUNTS = [
  { hostPath: "./grilled", sandboxPath: "/home/agent/grilled", readonly: true },
  {
    hostPath: "./.sandcastle/sandbox",
    sandboxPath: "/home/agent/.sandcastle-tools",
    readonly: true,
  },
] as const;

/**
 * Runs the tracker from this root and returns its stdout.
 *
 * Always from the root, never from inside a sandbox: the root tracker is the
 * only one that can see every project's notes, and `close` commits the ticket
 * file into whichever repository owns it.
 */
function tracker(...args: string[]): string {
  return execFileSync("node", [".sandcastle/tracker.mjs", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // `list` prints every open ticket's whole body, and execFileSync's default
    // cap is 1 MB: past it the child is killed and the run dies with ENOBUFS.
    // 28 long tickets can pass 1.4 MB.
    maxBuffer: 64 * 1024 * 1024,
  });
}

// Hooks run inside the sandbox before the agent starts.
//
// `make setup` is the repository's own install step (the root Makefile), so the
// runner needs no knowledge of the stack: whatever the app adds, npm workspaces or
// a Python environment, goes there. A failing hook aborts the sandbox before the
// implementer starts, so a broken install fails the run rather than a later check.
const hooks = {
  sandbox: {
    onSandboxReady: [
      {
        command: "make setup",
        timeoutMs: 900_000,
      },
    ],
  },
};

// Copy node_modules from the host into a new worktree before its sandbox starts.
// Avoids a full npm install from scratch; the hook above handles platform-specific
// binaries and any packages added since the last copy.
//
// Only into a worktree that has none, or whose copy never finished
// (lib/node-modules.mjs). Sandcastle copies with `cp -R src dest`, which copies
// *into* `dest` when it exists: a reused worktree got node_modules/node_modules,
// 706MB more per resume. Skipping the copy also skips the ~43s it takes on NTFS,
// where `--reflink=auto` is a full copy.
//
// A path missing on the host is skipped rather than an error.
const COPY_TO_WORKTREE = ["node_modules"];

// A stuck-process guard for that copy, not a pacing mechanism: a full copy takes
// ~43s uncontended on this host, and several at once took ~83s each on macOS.
const timeouts = { copyToWorktreeMs: 3_600_000 };

/**
 * What sandcastle copies into `worktree`: nothing when its node_modules is whole.
 * A folder that a stopped run left half copied is deleted here, so it is copied
 * again. Call markNodeModulesReady once the sandbox is set up.
 */
function copyToWorktreeFor(worktree: string, label: string): string[] {
  const { copy, removed } = prepareNodeModules(worktree);
  if (removed) {
    console.log(`  ${label}: node_modules had no finished copy, so it is deleted and copied again`);
  }
  return copy ? COPY_TO_WORKTREE : [];
}

// On Windows, teach MSYS `cp` to create real symlinks, or the copy above fails
// outright — every branch, on a clean worktree, before an agent starts.
//
// Sandcastle shells out to `cp` (execFile, so it inherits this process's env), and
// on Windows that resolves to Git for Windows' MSYS2 coreutils. Its default
// `winsymlinks` mode cannot create a Windows symlink at all: `symlink()` is
// emulated by *copying the link target*, which needs the target to already exist at
// the destination. `node_modules/.bin` is readdir entry 0 and `node_modules/sshpk`
// is entry 636, so when cp reaches `.bin/sshpk-sign -> ../sshpk/bin/sshpk-sign`
// nothing has been copied there yet:
//
//   cp: cannot create symbolic link '.../node_modules/.bin/sshpk-sign':
//       No such file or directory
//
// `nativestrict` makes MSYS use the real Win32 call. It needs Developer Mode (or
// SeCreateSymbolicLinkPrivilege), which this host has; `native` would silently fall
// back to the broken copy emulation, so the strict mode is deliberate — if the
// privilege is ever lost, the failure says so instead of coming back as this.
if (
  process.platform === "win32" &&
  !/winsymlinks:/.test(process.env.MSYS ?? "")
) {
  process.env.MSYS =
    `${process.env.MSYS ?? ""} winsymlinks:nativestrict`.trim();
}

// A wrong effort name fails here, on the host, before any container starts.
// The tracker throws on a name that matches no effort, rather than reporting an
// empty backlog that would read as "nothing to do".
if (MAPS.length > 0) {
  try {
    tracker("list");
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? String(error);
    console.error(stderr.trim());
    process.exit(1);
  }
  console.log(`Limited to: ${MAPS.join(", ")}`);
}

// A stale image fails here, before any container starts, rather than at the
// first agent with "API Error: 400 Claude Code <old> does not support this model".
// Nothing rebuilds the image on a run, so bumping CLAUDE_CODE_VERSION in the
// Dockerfile changes nothing until `npm run sandcastle:build-image` is run —
// which is how 2026-10-20's run started on 2.1.223 under a 2.1.280 pin.
// Named here and in package.json's `sandcastle:build-image`, not derived from
// the folder's name, so the folder can move or be renamed.
const IMAGE = "sandcastle:harbor-point";

function assertImageMatchesDockerfile(): void {
  const pinned = readFileSync("./.sandcastle/Dockerfile", "utf8").match(
    /^ARG CLAUDE_CODE_VERSION=(\S+)/m,
  )?.[1];
  if (!pinned) return; // Unpinned: nothing to compare against.

  let installed: string;
  try {
    installed = execFileSync(
      "docker",
      ["run", "--rm", "--entrypoint", "claude", IMAGE, "--version"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim().split(/\s+/)[0]!;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? String(error);
    console.error(`Could not read Claude Code's version from ${IMAGE}:`);
    console.error(`  ${stderr.trim()}`);
    console.error(`Build it with: npm run sandcastle:build-image`);
    process.exit(1);
  }

  if (installed !== pinned) {
    console.error(
      `${IMAGE} has Claude Code ${installed}, but .sandcastle/Dockerfile pins ${pinned}.`,
    );
    console.error(`Rebuild it with: npm run sandcastle:build-image`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// One ticket: prepare, implement, review
// ---------------------------------------------------------------------------

const record = new RunRecord({
  dir: DRY_RUN ? null : "./.sandcastle/runs",
  settings: {
    parallel: PARALLEL,
    rounds: ROUNDS,
    maps: MAPS,
    models: MODELS,
    dryRun: DRY_RUN,
    validation:
      "sandbox: `make verify` on the change (.sandcastle/sandbox/verify.sh); " +
      "after each round's merges: `make check` on the checkout (.sandcastle/sandbox/full-check.sh)",
  },
});

// Set by the first agent that fails on a spent allowance. No model call starts
// after it; host-side work (WIP commits, clean merges, closes) carries on.
let allowanceSpent = false;

function spendAllowance(): void {
  if (allowanceSpent) return;
  allowanceSpent = true;
  slack.notify("allowance-spent", {});
}

const agentFor = (role: keyof typeof MODELS) => sandcastle.claudeCode(MODELS[role]);

const sandboxProvider = () =>
  docker({ imageName: IMAGE, env: SANDBOX_ENV, mounts: SANDBOX_MOUNTS });

/**
 * Claude Code can also end with exit 0 and the allowance message as its last
 * words, and then sandcastle returns normally. Raised as the error the exit-1
 * path gives, so both reach the same handling.
 */
function throwIfAllowanceSpent(result: { stdout?: string }): void {
  const tail = (result.stdout ?? "").slice(-1000);
  if (isAllowanceSpent(tail)) throw new Error(tail.trim());
}

/** What a worktree holds that is not committed, as a string to compare. */
const uncommitted = (worktree: string) => git(worktree, ["status", "--porcelain"]).stdout;

interface Prepared {
  worktree: string;
  stage: string;
  syncNote: string;
}

/**
 * The host's part before a sandbox starts: the worktree exists, nothing an earlier
 * run left uncommitted is lost, and the branch has its base. No model is involved.
 */
function prepare(ticket: Ticket): Prepared {
  const repo = PROJECTS[ticket.project].cwd;
  // First, so a ticket another machine started goes on from its work.
  const fromOrigin = takeUpTicketBranch(repo, ticket.branch, findWorktree(repo, ticket.branch));
  if (fromOrigin === "created" || fromOrigin === "caught-up") {
    console.log(`  ${ticket.id}: took up ${ticket.branch} from origin`);
  }
  const priorStage = stageOf(repo, ticket.branch);
  const { path: worktree } = ensureWorktree(repo, ticket.branch, ticket.base);

  const wipCommit = preserveWip(
    worktree,
    `RALPH(wip): ${ticket.id}: edits an interrupted run left uncommitted\n\n` +
      `Saved by the sandcastle runner before resuming. Not a finished state.`,
  );
  // After the WIP commit, so every real edit is already saved.
  const lineEndingsRestored = restoreStoredLineEndings(worktree).length;
  const ahead = commitsAhead(repo, ticket.base, ticket.branch);
  const stage = stageOf(repo, ticket.branch);

  // Only unfinished work is brought up to the base. A branch whose implementer
  // already signed off keeps the tip it signed off on; a conflict there surfaces
  // at merge time and goes to the resolver.
  let syncNote = "";
  let sync = "not needed";
  if (stage === "in-progress") {
    const result = syncWithBase(worktree, ticket.base);
    sync = result.status;
    if (result.status === "conflict") {
      syncNote =
        `**\`${ticket.base}\` has moved, and merging it into this branch conflicts** in:\n\n` +
        result.files.map((file: string) => `- \`${file}\``).join("\n") +
        `\n\nStart by running \`git merge ${ticket.base} --no-edit\`, resolve those ` +
        `conflicts keeping the intent of both sides, and commit the merge. Never rebase or reset.`;
    } else if (result.status === "merged") {
      syncNote = `\`${ticket.base}\` was merged into this branch before you started; it merged cleanly.`;
    }
  }

  record.note(ticket, {
    priorStage,
    fromOrigin,
    resumed: priorStage !== "new" && (ahead > 0 || wipCommit !== null),
    commitsBeforeRun: ahead,
    wipCommit,
    lineEndingsRestored,
    sync,
  });
  return { worktree, stage, syncNote };
}

/**
 * The ticket's checks, run by the host in the ticket's sandbox after an agent
 * says it is done: its own word is not the evidence. With VERIFY_REUSE, verify.sh
 * runs nothing when the tree still has the exact content of a run that passed, as
 * it does when the agent ran the checks and then committed; otherwise it runs
 * them. `output` is the tail of what it printed, for the agent's next turn.
 */
async function confirmChecks(
  sandbox: sandcastle.Sandbox,
  ticket: Ticket,
): Promise<{ green: boolean; output: string }> {
  const result = await sandbox.exec(`VERIFY_REUSE=1 ${verifyCommand(ticket)}`);
  const output = `${result.stdout}\n${result.stderr}`.trim().slice(-8000);
  if (result.exitCode !== 0) console.log(`  · ${ticket.id}: the ticket's checks fail on the signed-off work`);
  return { green: result.exitCode === 0, output };
}

/** The implementer's turns. True when it signed off with work on the branch. */
async function implement(
  sandbox: sandcastle.Sandbox,
  ticket: Ticket,
  prepared: Prepared,
  report: (usage: unknown) => void,
): Promise<boolean> {
  const repo = PROJECTS[ticket.project].cwd;
  const seen = new Map();
  const promptArgs = () => ({
    TASK_ID: ticket.id,
    ISSUE_TITLE: ticket.title,
    BRANCH: ticket.branch,
    BASE: ticket.base,
    PROJECT: ticket.project,
    // Read on the host and injected: the sandbox cannot see every project's notes.
    ISSUE_BODY: tracker("view", ticket.id),
    CODING_STANDARDS,
    VERIFY_COMMAND: verifyCommand(ticket),
    BRANCH_PROGRESS: branchProgress(prepared.worktree, ticket.base),
    SYNC_NOTE: prepared.syncNote,
  });

  try {
    let idle = 0;
    let before = { tip: revParse(prepared.worktree, "HEAD"), dirty: uncommitted(prepared.worktree) };
    let result = await sandbox.run({
      name: "implementer",
      maxIterations: 1,
      agent: agentFor("implementer"),
      promptFile: "./.sandcastle/implement-prompt.md",
      promptArgs: promptArgs(),
      idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
    });

    for (let turn = 1; ; turn++) {
      collectRunUsage(result, seen);
      throwIfAllowanceSpent(result);

      // The promise alone is not the evidence: the work must be on the branch,
      // and the ticket's checks must pass on it when the host runs them.
      let signed = Boolean(result.completionSignal);
      let failedChecks = "";
      if (signed) {
        if (commitsAhead(repo, ticket.base, ticket.branch) === 0) {
          record.note(ticket, { stopReason: "signalled complete with no commit on the branch" });
          return false;
        }
        const checks = await confirmChecks(sandbox, ticket);
        if (!checks.green) {
          signed = false;
          failedChecks = checks.output;
        }
      }

      const after = { tip: revParse(prepared.worktree, "HEAD"), dirty: uncommitted(prepared.worktree) };
      const decision = afterTurn(
        {
          turn,
          idle,
          completed: signed,
          progressed: after.tip !== before.tip || after.dirty !== before.dirty,
        },
        { maxTurns: MAX_IMPLEMENT_TURNS, maxIdle: MAX_IDLE_TURNS },
      );
      idle = decision.idle;
      before = after;

      if (decision.action === "done") return true;
      if (decision.action === "stop") {
        const reason = failedChecks ? `${decision.reason}; the ticket's checks fail on its work` : decision.reason;
        record.note(ticket, { stopReason: reason });
        return false;
      }
      if (allowanceSpent) return false;

      // The same session, so what it already read stays read.
      const prompt = failedChecks
        ? "You output <promise>COMPLETE</promise>, but the host ran the ticket's checks on " +
          `your work, and they fail:\n\n\`\`\`text\n${failedChecks}\n\`\`\`\n\nFix the cause, ` +
          `commit, and output <promise>COMPLETE</promise> only when \`${verifyCommand(ticket)}\` ` +
          "passes."
        : "You stopped without <promise>COMPLETE</promise>. Continue the same task from " +
          "where you are. Commit progress as you go. Output <promise>COMPLETE</promise> " +
          "only when every acceptance criterion holds, the ticket's checks pass and the " +
          "work is committed.";
      result = result.resume
        ? await result.resume(prompt, {
            name: "implementer",
            // resume() spreads the first run's options, promptArgs included, then
            // swaps in this inline prompt; sandcastle rejects args on an inline prompt.
            promptArgs: {},
            idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
          })
        : await sandbox.run({
            name: "implementer",
            maxIterations: 1,
            agent: agentFor("implementer"),
            promptFile: "./.sandcastle/implement-prompt.md",
            promptArgs: promptArgs(),
            idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
          });
    }
  } finally {
    report(seen.size > 0 ? totalUsage(seen) : null);
  }
}

/** The reviewer's one turn. True when it signed off. */
async function review(
  sandbox: sandcastle.Sandbox,
  ticket: Ticket,
  worktree: string,
  report: (usage: unknown) => void,
): Promise<boolean> {
  const diff = reviewDiff(worktree, ticket.base);
  const seen = new Map();
  const before = revParse(worktree, "HEAD")!;
  try {
    const result = await sandbox.run({
      name: "reviewer",
      maxIterations: 1,
      agent: agentFor("reviewer"),
      promptFile: "./.sandcastle/review-prompt.md",
      promptArgs: {
        TASK_ID: ticket.id,
        ISSUE_TITLE: ticket.title,
        BRANCH: ticket.branch,
        BASE: ticket.base,
        // The same ticket the implementer was given. Without it the reviewer
        // could only infer the intent from the diff and the commit messages,
        // so code that missed the ticket read as code that met it.
        ISSUE_BODY: tracker("view", ticket.id),
        CODING_STANDARDS,
        VERIFY_COMMAND: verifyCommand(ticket),
        COMMITS: diff.commits,
        DIFF_SUMMARY: diff.summary,
        DIFF_NOTE: diff.note,
        DIFF: diff.diff,
      },
      idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
    });
    collectRunUsage(result, seen);
    throwIfAllowanceSpent(result);

    // Whether Review earns its turn: how often it changes anything, and how much.
    const reviewerCommits = commitsAhead(worktree, before, "HEAD");
    record.note(ticket, {
      reviewerCommits,
      reviewerChange: reviewerCommits > 0 ? git(worktree, ["diff", "--shortstat", before, "HEAD"]).stdout : "",
    });

    if (!result.completionSignal) {
      record.note(ticket, { stopReason: "the reviewer did not sign off" });
      return false;
    }
    if (!(await confirmChecks(sandbox, ticket)).green) {
      // The tip is red, so it is no longer the implemented work: the next run
      // starts the implementer on it, which sees the failure in its own checks.
      clearStages(PROJECTS[ticket.project].cwd, ticket.branch);
      record.note(ticket, { stopReason: "the ticket's checks fail after the review" });
      return false;
    }
    return true;
  } finally {
    report(seen.size > 0 ? totalUsage(seen) : null);
  }
}

/** Opens a sandbox on the ticket's worktree, runs `work` in it, and closes it. */
async function inSandbox<T>(
  ticket: Ticket,
  worktree: string,
  work: (sandbox: sandcastle.Sandbox) => Promise<T>,
): Promise<T> {
  const sandbox = await record.phase(ticket, "sandbox-setup", async () => {
    const opened = await sandcastle.createSandbox({
      branch: ticket.branch,
      sandbox: sandboxProvider(),
      hooks,
      copyToWorktree: copyToWorktreeFor(worktree, ticket.id),
      cwd: PROJECTS[ticket.project].cwd,
      timeouts,
    });
    markNodeModulesReady(worktree);
    return opened;
  });
  try {
    return await work(sandbox);
  } finally {
    await sandbox.close().catch((error: unknown) => {
      console.error(`  ✗ ${ticket.id}: closing its sandbox failed: ${error}`);
    });
  }
}

/** Saves what a stopped ticket left uncommitted, so the next run resumes it. */
function saveWip(ticket: Ticket, outcome: Outcome): void {
  const worktree = findWorktree(PROJECTS[ticket.project].cwd, ticket.branch);
  if (!worktree) return;
  try {
    const sha = preserveWip(
      worktree,
      `RALPH(wip): ${ticket.id}: saved when the run stopped (${outcome})\n\n` +
        `Saved by the sandcastle runner. Not a finished state.`,
    );
    if (sha) record.note(ticket, { wipCommit: sha });
  } catch (error) {
    console.error(`  ✗ ${ticket.id}: could not save its uncommitted work: ${error}`);
  }
}

async function runTicket(ticket: Ticket): Promise<Outcome> {
  const repo = PROJECTS[ticket.project].cwd;
  let outcome: Outcome = "incomplete";

  if (allowanceSpent) {
    record.note(ticket, { outcome: "not-started", reason: "usage allowance spent" });
    return "not-started";
  }

  try {
    const prepared = await record.phase(ticket, "prepare", async () => prepare(ticket));
    if (prepared.stage === "reviewed") {
      outcome = "complete";
      return outcome;
    }

    await inSandbox(ticket, prepared.worktree, async (sandbox) => {
      if (prepared.stage !== "implemented") {
        const implemented = await record.phase(ticket, "implement", (report) =>
          implement(sandbox, ticket, prepared, report),
        );
        if (!implemented) return;
        markStage(repo, "implemented", ticket.branch);
      }
      if (allowanceSpent) return;

      const reviewed = await record.phase(ticket, "review", (report) =>
        review(sandbox, ticket, prepared.worktree, report),
      );
      if (!reviewed) return;
      markStage(repo, "reviewed", ticket.branch);
      outcome = "complete";
    });
    return outcome;
  } catch (error) {
    if (isAllowanceSpent(error)) {
      spendAllowance();
      outcome = "incomplete";
      record.note(ticket, { stopReason: "usage allowance spent" });
      console.error(`  ✗ ${ticket.id}: the usage allowance is spent; no further model calls start.`);
    } else {
      outcome = "failed";
      record.note(ticket, { error: String(error).slice(0, 4000) });
      console.error(`  ✗ ${ticket.id} (${ticket.branch}) failed: ${error}`);
      slack.notify("round-error", { round: currentRound, ticket, reason: `failed: ${error}` });
    }
    return outcome;
  } finally {
    if (outcome !== "complete") saveWip(ticket, outcome);
    record.note(ticket, { outcome, ended: new Date().toISOString() });
    console.log(`  ${outcome === "complete" ? "✓" : "·"} ${ticket.id}: ${outcome}`);
  }
}

// ---------------------------------------------------------------------------
// Merge and close
// ---------------------------------------------------------------------------

/**
 * Has a resolver merge the base into a reviewed branch that conflicts with it,
 * on the ticket's own worktree. True when the branch now contains the base.
 */
async function resolveConflict(ticket: Ticket, files: string[]): Promise<boolean> {
  const repo = PROJECTS[ticket.project].cwd;
  const { path: worktree } = ensureWorktree(repo, ticket.branch, ticket.base);

  try {
    const signed = await inSandbox(ticket, worktree, (sandbox) =>
      record.phase(ticket, "resolve-conflict", async (report) => {
        const seen = new Map();
        try {
          const result = await sandbox.run({
            name: "resolver",
            maxIterations: 1,
            agent: agentFor("resolver"),
            promptFile: "./.sandcastle/merge-prompt.md",
            promptArgs: {
              TASK_ID: ticket.id,
              ISSUE_TITLE: ticket.title,
              BRANCH: ticket.branch,
              BASE: ticket.base,
              CONFLICTS: files.map((file) => `- \`${file}\``).join("\n"),
              VERIFY_COMMAND: verifyCommand(ticket),
            },
            idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
          });
          collectRunUsage(result, seen);
          throwIfAllowanceSpent(result);
          if (!result.completionSignal) return false;
          return (await confirmChecks(sandbox, ticket)).green;
        } finally {
          report(seen.size > 0 ? totalUsage(seen) : null);
        }
      }),
    );
    if (!signed || !isAncestor(repo, ticket.base, ticket.branch)) return false;
    markStage(repo, "reviewed", ticket.branch);
    return true;
  } catch (error) {
    if (isAllowanceSpent(error)) spendAllowance();
    console.error(`  ✗ ${ticket.id}: resolving its conflict failed: ${error}`);
    return false;
  }
}

/**
 * Merges each complete ticket into its checkout, then closes it once it is in.
 * Returns the tickets this call merged, closed or not, for the full check.
 */
async function mergeAndClose(tickets: Ticket[]): Promise<Ticket[]> {
  const merged: Ticket[] = [];
  // Prints why a ticket did not merge or close, and sends it to Slack.
  const fail = (ticket: Ticket, what: string) => {
    console.error(`  ✗ ${ticket.id} ${what}`);
    record.note(ticket, { mergeProblem: what });
    slack.notify("round-error", { round: currentRound, ticket, reason: what });
  };
  for (const ticket of tickets) {
    const repo = PROJECTS[ticket.project].cwd;

    // The checkout is the developer's, and may have been switched during the run.
    if (checkoutBranch(ticket.project) !== ticket.base) {
      const detail = `${ticket.project} is no longer on ${ticket.base}`;
      record.merge(ticket, { status: "error", detail });
      fail(ticket, `not merged: ${detail}`);
      continue;
    }

    let result = mergeIntoCheckout(repo, ticket.branch);
    if (result.status === "conflict") {
      record.merge(ticket, result);
      console.log(`  ${ticket.id} conflicts with ${ticket.base} in ${result.files.length} file(s)`);
      if (allowanceSpent || !(await resolveConflict(ticket, result.files))) {
        fail(
          ticket,
          `left open: its conflict with ${ticket.base} in ${result.files.join(", ")} is not resolved; ` +
            `the branch keeps the work`,
        );
        continue;
      }
      result = mergeIntoCheckout(repo, ticket.branch);
    }
    record.merge(ticket, result);

    if (result.status === "error") {
      fail(ticket, `not merged: ${result.detail}`);
      continue;
    }
    if (result.status === "merged") merged.push(ticket);
    // Closed only once git confirms the branch is in the checkout: a closed
    // ticket is never selected again, so closing early loses it.
    if (!isAncestor(repo, ticket.branch, "HEAD")) {
      fail(ticket, `left open: ${ticket.branch} is not in ${ticket.project}'s HEAD`);
      continue;
    }
    try {
      console.log(`  ${tracker("close", ticket.id).trim()}`);
      record.note(ticket, { closed: true });
    } catch (error) {
      // The code is merged; an unclosed ticket is found merged on the next run
      // (its stage is `reviewed` and the merge reports already-merged), and closed then.
      const detail = String((error as { stderr?: string }).stderr ?? error).trim();
      fail(ticket, `is merged, but could not be closed: ${detail}`);
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// The full check of a checkout: CI's own steps, before tickets build on it
// ---------------------------------------------------------------------------

/** Fix attempts that stayed red, branch to project: pushed for a human to read. */
const fixAttempts = new Map<string, ProjectName>();

/** Check worktrees with a fixer at work: what it left uncommitted is saved if the run stops. */
const fixerWorktrees = new Set<string>();

/**
 * Commits what a stopped fixer left uncommitted on the check branch, so the next
 * fixer on the same tip goes on from it: the check branch keeps its commits, but
 * the next run clears anything uncommitted.
 */
function saveFixerWip(worktree: string, when: string): void {
  try {
    const sha = preserveWip(worktree, `RALPH(wip): fix the full check: saved when ${when}`);
    if (sha) console.log(`  saved the fixer's uncommitted work on its check branch`);
  } catch (error) {
    console.error(`  ✗ could not save the fixer's uncommitted work in ${worktree}: ${error}`);
  }
}

function keepAttempt(project: ProjectName, branch: string, what: string): void {
  fixAttempts.set(branch, project);
  console.log(`  ${project}: ${what} kept on ${branch}`);
}

type CheckOutcome = { status: "passed" } | { status: "held" | "stop"; reason: string };

/**
 * Takes a green check branch into the checkout, and records the pass. Returns
 * null, or why it could not.
 */
function takeGreenCheck(project: ProjectName, base: string, branch: string): string | null {
  const repo = PROJECTS[project].cwd;
  if (commitsAhead(repo, base, branch) === 0) {
    markCheckPassed(repo, base);
    return null;
  }
  const merge = mergeIntoCheckout(repo, branch);
  if (merge.status !== "merged" && merge.status !== "already-merged") {
    const why = merge.status === "conflict" ? `conflicts in ${merge.files.join(", ")}` : merge.detail;
    return `the fixer's commits in ${project} are green, but did not merge into ${base}: ${why}`;
  }
  if (revParse(repo, "HEAD") !== revParse(repo, `refs/heads/${branch}`)) {
    // Not a fast-forward: someone committed to the checkout meanwhile, so what
    // is there now was never checked. The next run checks it, fixer and all.
    markCheckPending(repo, base);
    return `${base} in ${project} moved while its fix was checked; run again to check the merged result`;
  }
  markCheckPassed(repo, base);
  console.log(`  ✓ ${project}: the fixer's commits are green and merged into ${base}`);
  return null;
}

/**
 * Makes sure `project`'s checkout passed the full check on its current tip, so
 * no ticket builds on a break. By the tip's state (lib/check-branch.mjs):
 *
 *   passed     nothing runs
 *   main       origin/main's tip, as a fresh cut is: CI on main checked it, so
 *              nothing runs. It is recorded as passed, so a fixer's list of
 *              changes later starts after it.
 *   pending    the runner's own merges made it: it is checked, and when red the
 *              fixer fixes it and the host checks again. Still red: the run stops,
 *              and the tip is left to a human. A run stopped part-way (allowance,
 *              network) leaves it pending, and the next run goes on from there.
 *   unchecked  someone else moved it, or it was never checked: it is checked, and
 *              when red its tickets are held for a human. No fixer runs, since no
 *              ticket of a run caused it.
 */
async function ensureChecked(project: ProjectName, final = false): Promise<CheckOutcome> {
  const repo = PROJECTS[project].cwd;
  const base = checkoutBranch(project);
  // A checkout on `main` takes no ticket, so there is nothing to protect.
  if (!base || needsEffortBranch(base)) return { status: "passed" };
  const state = checkState(repo, base);
  if (state === "passed") return { status: "passed" };
  if (state === "main") {
    markCheckPassed(repo, base);
    console.log(`  ${project}: ${base} is origin/main's tip, which CI checked; no full check runs`);
    return { status: "passed" };
  }
  const fixable = state === "pending";

  const round = final ? null : currentRound;
  const entry = record.check({ project, base, head: revParse(repo, "HEAD"), state, final, round });
  slack.notify("full-check-start", { project, base, state, final, round, minutes: FULL_CHECK_MINUTES[project] });
  let status = "red";
  let reason: string | null = null;
  const seen = new Map();
  try {
    const { branch, worktree, attempt, resumed } = prepareCheckBranch(repo, base, { resume: fixable });
    if (attempt) keepAttempt(project, attempt, "an earlier fixer's commits, for an older tip, are");
    if (resumed) console.log(`  ${project}: an earlier fixer's commits on ${branch} are checked first`);

    const sandbox = await sandcastle.createSandbox({
      branch,
      sandbox: sandboxProvider(),
      hooks,
      copyToWorktree: copyToWorktreeFor(worktree, project),
      cwd: repo,
      timeouts,
    });
    markNodeModulesReady(worktree);
    try {
      const runCheck = async () => {
        const result = await sandbox.exec(fullCheckCommand(project), {
          onLine: (line) => console.log(`    ${line}`),
        });
        // `timeout` exits 124, and 137 when its kill follows.
        const timedOut = result.exitCode === 124 || result.exitCode === 137;
        const limit = FULL_CHECK_MINUTES[project];
        if (timedOut) console.log(`    TIMED OUT after ${limit} min`);
        const note = timedOut ? `\nTIMED OUT: the check ran past ${limit} min and was stopped.` : "";
        return { green: result.exitCode === 0, output: `${result.stdout.trim()}${note}`.slice(-12000) };
      };

      console.log(`  ${project}: the full check of ${base} (${state})...`);
      const first = await runCheck();
      if (first.green) {
        reason = takeGreenCheck(project, base, branch);
        if (reason) return { status: "stop", reason };
        status = "green";
        return { status: "passed" };
      }
      if (!fixable) {
        reason =
          `the full check of ${base} in ${project} is red, and no merge of a run made it so: ` +
          `its tickets are held until a human fixes it`;
        return { status: "held", reason };
      }
      if (allowanceSpent) {
        reason = `the full check of ${base} in ${project} is red, and the usage allowance is spent; the next run fixes it`;
        return { status: "stop", reason };
      }

      console.log(`  ${project}: the full check is red; the fixer starts on ${branch}`);
      fixerWorktrees.add(worktree);
      const result = await sandbox.run({
        name: "fixer",
        maxIterations: 1,
        agent: agentFor("fixer"),
        promptFile: "./.sandcastle/fix-prompt.md",
        promptArgs: {
          PROJECT: project,
          BRANCH: branch,
          BASE: base,
          CHANGES: changesSinceCheck(repo, base),
          FAILURES: first.output,
          CODING_STANDARDS,
          FULL_CHECK_COMMAND: fullCheckCommand(project),
        },
        idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
      });
      collectRunUsage(result, seen);
      throwIfAllowanceSpent(result);
      // The check below must test exactly what a merge would bring in.
      preserveWip(worktree, `RALPH(wip): fix the full check: edits the fixer left uncommitted`);
      fixerWorktrees.delete(worktree);

      console.log(`  ${project}: the full check again, after the fixer`);
      if ((await runCheck()).green) {
        reason = takeGreenCheck(project, base, branch);
        if (!reason) {
          status = "fixed";
          return { status: "passed" };
        }
      } else {
        reason = `the full check of ${base} in ${project} is still red after the fixer`;
        // A whole fixer turn did not fix it: the next run does not try again, but
        // holds the project's tickets until a human has.
        clearCheckPending(repo, base);
      }
      const kept = keepFixAttempt(repo, base);
      if (kept) keepAttempt(project, kept, "the fixer's attempt is");
      return { status: "stop", reason };
    } finally {
      await sandbox.close().catch((error: unknown) => {
        console.error(`  ✗ ${project}: closing the check's sandbox failed: ${error}`);
      });
    }
  } catch (error) {
    // The check, or the fixer, did not finish: the network, the allowance, a
    // sandbox that would not start. The state is unchanged, so the next run
    // checks the same tip again, and a pending one goes on from the fixer's commits.
    for (const worktree of fixerWorktrees) saveFixerWip(worktree, "it stopped");
    fixerWorktrees.clear();
    if (isAllowanceSpent(error)) spendAllowance();
    reason = `the full check of ${base} in ${project} did not finish: ${String(error).slice(0, 500)}`;
    return { status: fixable ? "stop" : "held", reason };
  } finally {
    record.endCheck(entry, { status, reason, fixerUsage: seen.size > 0 ? totalUsage(seen) : null });
    slack.notify("full-check", { project, base, status, reason, final, seconds: entry.seconds });
  }
}

// ---------------------------------------------------------------------------
// Effort branches, and the push to origin
// ---------------------------------------------------------------------------

/**
 * The repository root, where `tracker close` commits every closed ticket, on its
 * current branch. Here it is also the one project's checkout (ROOT_IS_PROJECT).
 */
const WORKSPACE = { name: "workspace root", cwd: "." };

/** Repositories this run fetched: each is fetched once. */
const fetched = new Set<string>();

/** Repositories this run commits to, `cwd` to name: their branches are pushed. */
const touched = new Map<string, string>();

/** Every ticket this run started: its branch is pushed while it is unmerged. */
const startedTickets = new Map<string, Ticket>();

/** What is only on this machine, by branch, with why: the run's last lines. */
const notOnOrigin = new Map<string, string>();

/**
 * Fetches origin once per repository, a dry run too: what a run would move a
 * checkout to depends on origin's branches, and a fetch moves no branch.
 */
function fetchOnce(name: string, cwd: string): void {
  if (fetched.has(cwd)) return;
  fetched.add(cwd);
  const failure = fetchOrigin(cwd);
  if (failure) console.error(`  ✗ ${name}: could not fetch origin: ${failure}`);
}

/**
 * Moves one checkout to `<prefix>/<effort>`, or says what a run would do on a
 * dry run. Returns null, or why it stays where it is.
 */
function switchToEffortBranch(
  name: string,
  cwd: string,
  efforts: string[],
  prefix: "feat" | "docs",
): string | null {
  fetchOnce(name, cwd);
  const plan = planEffortBranch(cwd, efforts, prefix);
  if (plan.hold) {
    console.log(`  ${name} ${plan.hold}`);
    return plan.hold;
  }
  const move = plan.move!;
  const { from, to, source } = move;
  const where =
    source === "new" ? ", cut from origin/main" : source === "origin" ? `, from origin/${to}` : "";
  if (DRY_RUN) {
    console.log(`  ${name}: a run moves it from ${from} to ${to}${where}`);
    return null;
  }
  moveToEffortBranch(cwd, move);
  console.log(`  ${name}: ${from} -> ${to}${where}`);
  return null;
}

/**
 * Moves each project checkout on `main` that a ticket waits on to its effort's
 * branch, and then the workspace root, which takes the closes of every ticket
 * that can run. Returns whether a checkout moved, so selection runs again, and
 * why the root cannot take the closes, if it cannot: it stays on `main`, or it is
 * on another effort's branch. Then no ticket may close, so none starts.
 */
function putCheckoutsOnEffortBranches(
  ready: Ticket[],
  held: Held[],
): { moved: boolean; rootHold: string | null } {
  const waiting = new Map<ProjectName, Set<string>>();
  for (const ticket of held) {
    if (!ticket.project || !needsEffortBranch(ticket.checkout ?? null)) continue;
    // An absent checkout reads as no branch too; there is nothing to move.
    if (!existsSync(join(PROJECTS[ticket.project].cwd, ".git"))) continue;
    waiting.set(ticket.project, (waiting.get(ticket.project) ?? new Set<string>()).add(ticket.map));
  }

  let moved = false;
  const runnable = new Set(ready.map((ticket) => ticket.map));
  for (const [project, maps] of waiting) {
    const efforts = [...maps].sort();
    if (switchToEffortBranch(project, PROJECTS[project].cwd, efforts, "feat") === null) {
      for (const map of maps) runnable.add(map);
      moved ||= !DRY_RUN;
    }
  }

  if (runnable.size === 0) return { moved, rootHold: null };
  // The project's move above was the root's own, and selection already holds
  // every ticket whose effort is not the branch the root is on.
  if (ROOT_IS_PROJECT) return { moved, rootHold: null };
  const rootBranch = currentBranch(WORKSPACE.cwd);
  if (!needsEffortBranch(rootBranch)) {
    // On a branch already: it stays, and must be every running effort's own.
    const hold = rootHoldReason(rootBranch, runnable);
    if (hold) console.log(`  ${WORKSPACE.name} ${hold}`);
    return { moved, rootHold: hold };
  }
  const rootHold = switchToEffortBranch(WORKSPACE.name, WORKSPACE.cwd, [...runnable].sort(), "docs");
  return { moved: moved || (rootHold === null && !DRY_RUN), rootHold };
}

/**
 * Fast-forwards a checkout's effort branch to origin's copy, and says so. A
 * checkout on `main` is left alone: the run never changes `main`.
 */
function catchUp(name: string, cwd: string): void {
  const branch = currentBranch(cwd);
  if (needsEffortBranch(branch)) return;
  fetchOnce(name, cwd);
  const result = catchUpWithOrigin(cwd);
  if (result === "caught-up") console.log(`  ${name}: caught up with origin/${branch}`);
  if (result === "diverged") {
    console.error(
      `  ✗ ${name}: ${branch} could not fast-forward to origin/${branch} (it has diverged, ` +
        `or a local change is in the way); the run goes on, and origin refuses its push ` +
        `until you reconcile them`,
    );
  }
}

function pushOne(name: string, cwd: string, branch: string | null): void {
  const key = `${name}: ${branch ?? "a detached HEAD"}`;
  const result = pushBranch(cwd, branch);
  if (result.status === "pushed") {
    notOnOrigin.delete(key);
    console.log(`  ${name}: pushed ${branch}`);
  } else {
    notOnOrigin.set(key, result.detail!);
    console.error(`  ✗ ${key} not pushed: ${result.detail}`);
  }
}

/**
 * Pushes what this run committed: the branch of each repository it committed
 * to, each fix attempt that stayed red, and each ticket branch whose commits its
 * checkout has not merged (a ticket left incomplete, a conflict left open, or a
 * run stopped first). A merged ticket branch is not pushed: its commits are in
 * the checkout's branch. The check branch is never pushed.
 */
function pushEverything(): void {
  if (!PUSH) {
    console.log("  --no-push: nothing pushed");
    return;
  }
  for (const [cwd, name] of touched) pushOne(name, cwd, currentBranch(cwd));
  for (const [branch, project] of fixAttempts) pushOne(project, PROJECTS[project].cwd, branch);
  for (const ticket of startedTickets.values()) {
    const repo = PROJECTS[ticket.project].cwd;
    if (!revParse(repo, `refs/heads/${ticket.branch}`)) continue;
    if (isAncestor(repo, ticket.branch, "HEAD")) continue;
    pushOne(ticket.project, repo, ticket.branch);
  }
}

/**
 * The end of every run that touched a repository, however it ends: the loop's
 * end, an error, or Ctrl-C. Saves what a stopped agent left uncommitted, pushes
 * everything, and lists what is still only on this machine. Runs once.
 *
 * Ctrl-C is the case the per-ticket save misses: sandcastle's own handler calls
 * `process.exit()`, so no `finally` in runTicket runs.
 */
let finished = false;
function finish(): void {
  if (finished || DRY_RUN || touched.size === 0) return;
  finished = true;

  console.log("\nSaving and pushing everything this run made, for any machine to take up:");
  for (const ticket of startedTickets.values()) {
    const worktree = findWorktree(PROJECTS[ticket.project].cwd, ticket.branch);
    if (!worktree) continue;
    try {
      const sha = preserveWip(
        worktree,
        `RALPH(wip): ${ticket.id}: saved when the run ended\n\n` +
          `Saved by the sandcastle runner. Not a finished state.`,
      );
      if (sha) console.log(`  ${ticket.id}: saved its uncommitted work`);
    } catch (error) {
      notOnOrigin.set(`${ticket.project}: ${ticket.branch}, uncommitted work`, String(error));
      console.error(`  ✗ ${ticket.id}: could not save its uncommitted work: ${error}`);
    }
  }
  for (const worktree of fixerWorktrees) saveFixerWip(worktree, "the run ended");
  pushEverything();

  if (notOnOrigin.size > 0) {
    console.error(`\n${notOnOrigin.size} item(s) are only on this machine; push them by hand:`);
    for (const [what, why] of notOnOrigin) console.error(`  ${what} (${why})`);
  }
}

// `exit` covers the loop's end, an uncaught error, and every `process.exit()`,
// sandcastle's Ctrl-C handler among them. Its listeners must be synchronous, and
// every git call here is. Sandcastle has a Ctrl-C handler only while a sandbox is
// open, so these two make Ctrl-C reach `exit` at any other time.
process.on("exit", finish);
process.on("SIGINT", () => {
  stopCause ??= "Ctrl-C";
  process.exit(130);
});
process.on("SIGTERM", () => {
  stopCause ??= "SIGTERM";
  process.exit(143);
});
// A monitor only records the error: Node still prints it and exits as before.
process.on("uncaughtExceptionMonitor", (error) => {
  stopCause ??= `an error: ${error?.stack ?? error}`;
});
// After finish(), so the message can list what it could not push. An `exit`
// listener cannot wait for a promise, so this one message is sent synchronously.
process.on("exit", (code) => {
  if (!runStarted || runEnded) return;
  slack.notifySync("run-stopped", {
    reason: stopCause ?? `the process exited with code ${code}`,
    record: record.path,
    notOnOrigin: [...notOnOrigin],
  });
});

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

/** One line per ready ticket, saying what a run would do with it. Changes nothing. */
function describe(ticket: Ticket): string {
  const repo = PROJECTS[ticket.project].cwd;
  const stage = stageOf(repo, ticket.branch);
  const worktree = findWorktree(repo, ticket.branch);
  const parts = [`${ticket.project}:${ticket.branch} ← ${ticket.base}`, `stage ${stage}`];
  if (stage !== "new") {
    parts.push(`${commitsAhead(repo, ticket.base, ticket.branch)} commit(s) ahead`);
    parts.push(isAncestor(repo, ticket.base, ticket.branch) ? "has its base" : "behind its base");
  }
  if (worktree) parts.push(uncommitted(worktree) ? "worktree has uncommitted edits" : "worktree clean");
  return `  ${ticket.id}: ${parts.join("; ")}`;
}

if (!DRY_RUN) {
  assertImageMatchesDockerfile();
  // The pause the parallel hint promises: time to stop and rerun with another
  // --parallel. It comes after the checks above, so a wrong flag still fails at once.
  const STARTUP_DELAY_SECONDS = 5;
  console.log(`    Starting in ${STARTUP_DELAY_SECONDS} seconds...`);
  await new Promise((resolve) => setTimeout(resolve, STARTUP_DELAY_SECONDS * 1000));
  runStarted = true;
  slack.notify("run-start", { parallel: PARALLEL, rounds: ROUNDS });
}

const attempted = new Set<string>();

// Why a full check stopped the run, or null: a red the fixer could not fix, or a
// check or fix that did not finish (the network, the allowance).
let checkStop: string | null = null;

/**
 * The full check of each project, one at a time: a full build and test suite
 * takes several GB, and no ticket runs meanwhile. Returns the projects whose
 * tickets it holds, with why. A stop sets `checkStop` and checks no further.
 */
async function runFullChecks(projects: ProjectName[], final = false): Promise<Map<ProjectName, string>> {
  const holds = new Map<ProjectName, string>();
  for (const project of projects) {
    const outcome = await ensureChecked(project, final);
    if (outcome.status === "passed") continue;
    console.error(`  ✗ ${outcome.reason}`);
    if (outcome.status === "stop") {
      checkStop = outcome.reason;
      break;
    }
    holds.set(project, outcome.reason);
  }
  return holds;
}

const checkStateOf = (project: ProjectName) => {
  const base = checkoutBranch(project);
  return base ? checkState(PROJECTS[project].cwd, base) : "unchecked";
};

for (let iteration = 1; iteration <= ROUNDS; iteration++) {
  if (allowanceSpent) break;
  currentRound = iteration;
  console.log(`\n=== Iteration ${iteration}/${ROUNDS} ===\n`);

  // The root first: another machine may have closed or added tickets.
  if (!DRY_RUN) catchUp(WORKSPACE.name, WORKSPACE.cwd);

  const select = () =>
    selectTickets(JSON.parse(tracker("list")), {
      projects: PROJECTS,
      checkoutBranch,
      attempted,
    }) as { ready: Ticket[]; held: Held[] };
  let { ready, held } = select();

  const branches = putCheckoutsOnEffortBranches(ready, held);
  if (branches.moved) ({ ready, held } = select());
  if (branches.rootHold) {
    const reason = `the workspace root ${branches.rootHold}`;
    held = [...held, ...ready.map((ticket) => ({ id: ticket.id, map: ticket.map, reason }))];
    ready = [];
  }

  // Finished work lands first. A round merges only after every ticket in it ends,
  // so a reviewed ticket beside new ones would wait for them, and the new ones
  // would build on a base without it. A round with a reviewed ticket runs only
  // the reviewed ones; the rest start next round, on the merged base.
  const isReviewed = (ticket: Ticket) =>
    stageOf(PROJECTS[ticket.project].cwd, ticket.branch) === "reviewed";
  if (ready.some(isReviewed)) {
    const reason = "waits one round, for the reviewed tickets to merge first";
    held = [
      ...held,
      ...ready.filter((ticket) => !isReviewed(ticket)).map((ticket) => ({ id: ticket.id, map: ticket.map, reason })),
    ];
    ready = ready.filter(isReviewed);
  }

  // No ticket builds on a checkout that has not passed the full check on its
  // tip. A tip is checked once, so this is where a round's merges are checked,
  // before the next round's tickets; the last round's are checked after the loop.
  const projects = [...new Set(ready.map((ticket) => ticket.project))];
  if (DRY_RUN) {
    for (const project of projects) {
      const state = checkStateOf(project);
      const plan =
        state === "passed"
          ? "passed; no check runs"
          : state === "main"
            ? "origin/main's tip, which CI checked; no check runs"
            : `${state}; the full check runs first`;
      console.log(`  ${project}: the full check of ${checkoutBranch(project)}: ${plan}`);
    }
  } else if (projects.length > 0) {
    for (const project of projects) {
      catchUp(project, PROJECTS[project].cwd);
      touched.set(PROJECTS[project].cwd, project);
    }
    const checkRuns = (state: string) => state === "pending" || state === "unchecked";
    if (projects.some((project) => checkRuns(checkStateOf(project)))) {
      console.log("\nThe full check, before tickets build on a checkout:");
    }
    const holds = await runFullChecks(projects);
    if (checkStop) break;
    held = [
      ...held,
      ...ready
        .filter((ticket) => holds.has(ticket.project))
        .map((ticket) => ({ id: ticket.id, map: ticket.map, reason: holds.get(ticket.project)! })),
    ];
    ready = ready.filter((ticket) => !holds.has(ticket.project));
  }

  for (const { id, reason } of held) console.log(`  held ${id}: ${reason}`);
  slack.notify("round-start", {
    round: iteration,
    rounds: ROUNDS,
    ready: ready.map((ticket) => ({
      id: ticket.id,
      title: ticket.title,
      project: ticket.project,
      stage: stageOf(PROJECTS[ticket.project].cwd, ticket.branch),
    })),
    held: held.map(({ id, reason }) => ({ id, reason })),
  });
  if (ready.length === 0) {
    console.log("No ticket can start now.");
    break;
  }
  console.log(`\n${ready.length} ticket(s) ready, at most ${PARALLEL} at a time:`);
  for (const ticket of ready) console.log(describe(ticket));

  if (DRY_RUN) {
    console.log("\nDry run: nothing was started, committed or merged.");
    break;
  }

  for (const ticket of ready) {
    attempted.add(ticket.id);
    startedTickets.set(ticket.id, ticket);
  }
  touched.set(WORKSPACE.cwd, WORKSPACE.name);
  const entry = record.iteration(iteration, { ready, held });

  const settled = await allSettledWithLimit(ready, PARALLEL, runTicket);
  const complete = ready.filter(
    (_, i) => settled[i]!.status === "fulfilled" && (settled[i] as PromiseFulfilledResult<Outcome>).value === "complete",
  );

  console.log(`\n${complete.length} of ${ready.length} ticket(s) complete. Merging...`);
  // The new tips are the runner's own, so a red check of them may send the
  // fixer, now or, if this run stops first, in the next run.
  for (const ticket of await mergeAndClose(complete)) {
    markCheckPending(PROJECTS[ticket.project].cwd, ticket.base);
  }

  // Every round, so a machine that dies mid-run loses at most the round in
  // progress. finish() pushes once more when the run ends.
  console.log("\nPushing:");
  pushEverything();
  record.endIteration(entry);
  slack.notify("round-end", {
    round: iteration,
    rounds: ROUNDS,
    seconds: entry.seconds,
    tickets: ready.map((ticket) => {
      const result = record.data.tickets[ticket.id] ?? {};
      return {
        id: ticket.id,
        title: ticket.title,
        outcome: result.outcome,
        closed: Boolean(result.closed),
        detail: result.mergeProblem ?? result.stopReason ?? result.error,
      };
    }),
  });
}

// The merges no later round's tickets waited on: the last round's, and those in
// a project no later round touched.
if (!DRY_RUN && !checkStop) {
  const pending = (Object.keys(PROJECTS) as ProjectName[]).filter(
    (project) => touched.has(PROJECTS[project].cwd) && checkStateOf(project) === "pending",
  );
  if (pending.length > 0) {
    console.log(
      `\nThe final full check: ${pending.join(", ")} ${pending.length === 1 ? "holds" : "hold"} ` +
        "merges that no round checked yet, " +
        "so the run checks them before it ends:",
    );
    await runFullChecks(pending, true);
  }
}

if (checkStop) {
  console.error(
    `\nThe run stopped: ${checkStop}. Tickets already merged stay merged and closed. ` +
      "If a fixer's attempt is named above, start from it.",
  );
}

if (allowanceSpent) {
  console.log(
    "\nThe usage allowance is spent. Work in progress is committed on each ticket's branch; " +
      "run again after the allowance resets and those tickets resume.",
  );
}
finish();
if (!DRY_RUN) {
  console.log("");
  const lines = record.finish({ allowanceSpent, checkStop });
  for (const line of lines) console.log(line);
  runEnded = true;
  slack.notify("run-end", {
    summary: record.data.summary,
    roundsRun: record.data.iterations.length,
    rounds: ROUNDS,
    tickets: [...startedTickets.values()].map((ticket) => {
      const result = record.data.tickets[ticket.id] ?? {};
      return {
        id: ticket.id,
        title: ticket.title,
        outcome: result.outcome,
        closed: Boolean(result.closed),
        detail: result.mergeProblem ?? result.stopReason ?? result.error,
      };
    }),
    checks: record.data.checks.map(({ project, base, status, final, round, seconds }) => ({
      project,
      base,
      status,
      final,
      round,
      seconds,
    })),
    record: record.path,
    checkStop,
    allowanceSpent,
    notOnOrigin: [...notOnOrigin],
  });
  await slack.flush();
}
