#!/usr/bin/env node
// Tears down the worktrees, branches and run logs a sandcastle run leaves behind.
//
// The worktrees and branches live in this repository: `.sandcastle/main.mts`
// anchors every run at its one project, whose `cwd` is this root, so git cuts each
// branch here and sandcastle writes each sandbox to `.sandcastle/worktrees/`.
//
// This is a Node script rather than a package.json one-liner because the shell
// pipeline it replaces could only ever run on macOS/Linux: npm on Windows runs
// scripts through cmd.exe, which has no `awk`, no `while read`, and treats `;` as
// a literal argument rather than a command separator. Node is the one interpreter
// both platforms are guaranteed to have here.
//
// Usage:
//   node .sandcastle/clean.mjs                     # sweep this repository
//   node .sandcastle/clean.mjs --dry-run

import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  rmdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { clearStages } from "./lib/branch-state.mjs";

const WORKSPACE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Where sandcastle puts every worktree it creates, and nothing else — it is
// gitignored scratch space (`worktrees/` in .sandcastle/.gitignore). Anything found
// here that git has no registration for is a leftover, not someone's work.
const worktreesDir = (repo) => join(repo, ".sandcastle", "worktrees");

// Where sandcastle writes one `<branch>-<role>.log` per agent run — also gitignored
// scratch (`logs/` sits beside `worktrees/` in .sandcastle/.gitignore and in each
// .sandcastle/.gitignore).
//
// Run records are in `.sandcastle/runs/`, not here, so a sweep keeps them.
const logsDir = (dir) => join(dir, ".sandcastle", "logs");

// Only branches under this hierarchy are touched. Sandcastle names every branch it
// creates `sandcastle/issue-<id>` (lib/selection.mjs fixes the format), so this prefix
// is what separates a disposable sandbox from the branch you are actually working
// on, such as `feat/hp-1-order-intake`.
const BRANCH_PREFIX = "refs/heads/sandcastle/";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const ONLY = args.filter((arg) => !arg.startsWith("-"));

/** Runs git inside `cwd`, returning stdout. Throws with git's stderr attached. */
function git(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const detail = String(error.stderr ?? "").trim();
    throw new Error(
      `git ${args.join(" ")} in ${basename(cwd)} failed${detail ? `: ${detail}` : ""}`,
    );
  }
}

/**
 * The repositories to sweep. Here that is this root alone: the application code
 * lives in this repository, and main.mts's one project has its `cwd` here, so
 * every worktree, `sandcastle/` branch and log a run makes is this root's. What
 * keeps the sweep safe is what it deletes: only branches under `sandcastle/`, and
 * only directories beneath `.sandcastle/worktrees/`.
 */
function childRepos() {
  if (ONLY.length > 0) {
    throw new Error(`this repository has one project, the root; run with no project name`);
  }
  return [WORKSPACE_ROOT];
}

/**
 * Parses `git worktree list --porcelain` into records.
 *
 * The format is stanzas separated by blank lines, one key-value per line
 * (`worktree <path>`, `HEAD <sha>`, `branch <ref>`), with valueless markers
 * (`bare`, `detached`, `locked`, `prunable`) on their own. Note that git prints
 * Windows paths with forward slashes (`D:/repo/.sandcastle/...`); `resolve()`
 * normalises them so the path comparisons below are not defeated by slash
 * direction alone.
 */
function listWorktrees(repo) {
  const worktrees = [];
  let current = null;

  for (const rawLine of git(repo, ["worktree", "list", "--porcelain"]).split(
    /\r?\n/,
  )) {
    const line = rawLine.trim();
    if (line === "") {
      current = null;
      continue;
    }

    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");

    if (key === "worktree") {
      current = { path: resolve(value), branch: null, locked: false };
      worktrees.push(current);
    } else if (current && key === "branch") {
      current.branch = value;
    } else if (current && key === "locked") {
      current.locked = true;
    }
  }

  return worktrees;
}

/**
 * Unlinks symlinked/junctioned entries at the top of a worktree before git is
 * allowed to delete it.
 *
 * `git worktree remove` deletes the directory tree, and on Windows that recurses
 * *through* a directory junction instead of removing the link — so a worktree whose
 * node_modules is a junction back to the project checkout takes the project's
 * node_modules with it. Sandcastle's own copyToWorktree makes real copies, but
 * anyone who has hand-linked a worktree to skip the 706MB copy has a live
 * foot-gun, and unlinking first costs nothing when there is nothing to unlink.
 *
 * Top level only: that is where the linked-in payloads live (`node_modules`,
 * `.env`), and walking 60k+ files to find nested links would cost more than the
 * removal itself.
 */
function unlinkTopLevelLinks(worktreePath) {
  let entries;
  try {
    entries = readdirSync(worktreePath, { withFileTypes: true });
  } catch {
    return; // Directory already gone — prune will reap the registration.
  }

  for (const entry of entries) {
    // Node reports Windows directory junctions as symbolic links, which is what
    // makes this check work on both platforms.
    if (!entry.isSymbolicLink()) continue;

    const link = join(worktreePath, entry.name);
    if (DRY_RUN) {
      console.log(`  would unlink ${entry.name} (symlink/junction)`);
      continue;
    }

    try {
      unlinkSync(link);
    } catch {
      // Windows needs RemoveDirectory for a directory reparse point; Node's
      // unlink handles that itself, but fall back rather than abort the cleanup.
      try {
        rmdirSync(link);
      } catch (error) {
        console.error(
          `  warning: could not unlink ${entry.name}: ${error.message}`,
        );
      }
    }
    console.log(`  unlinked ${entry.name} (symlink/junction)`);
  }
}

function removeWorktree(repo, worktree) {
  console.log(
    `  ${DRY_RUN ? "would remove" : "removing"} worktree ${relative(worktree.path)}`,
  );
  unlinkTopLevelLinks(worktree.path);
  if (DRY_RUN) return true;

  try {
    // --force twice: the first allows a dirty worktree (a sandbox always is), the
    // second is what git requires to remove a *locked* worktree, which is the state
    // a run killed mid-setup tends to leave behind.
    git(repo, ["worktree", "remove", "--force", "--force", worktree.path]);
    return true;
  } catch (error) {
    console.error(`    ${error.message}`);
  }

  // Windows in particular refuses the delete while any file is still open — an
  // orphaned container, a watcher, an editor. Drop the directory ourselves and let
  // prune reconcile git's registration.
  try {
    if (existsSync(worktree.path)) {
      rmSync(worktree.path, { recursive: true, force: true, maxRetries: 3 });
    }
    git(repo, ["worktree", "prune"]);
    console.log(`    removed by hand after git declined`);
    return true;
  } catch (error) {
    console.error(`    giving up on ${worktree.path}: ${error.message}`);
    return false;
  }
}

/**
 * Directories under `<repo>/.sandcastle/worktrees/` that git has no worktree
 * registration for.
 *
 * A run killed during sandbox setup leaves the directory on disk with its `.git`
 * pointer file never written, so `git worktree list` does not report it and
 * `git worktree prune` will not reap it — the previous shell version of this script
 * iterated git's list alone and therefore reported "nothing to do" while several
 * hundred megabytes of half-copied node_modules stayed behind. Those leftovers are
 * not inert: `cp -R src dest` copies *into* an existing `dest`, so the next run
 * nests a fresh node_modules underneath the stale one instead of resuming it.
 */
function orphanedWorktreeDirs(repo, registeredPaths) {
  const dir = worktreesDir(repo);
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name))
    .filter((path) => !registeredPaths.has(resolve(path)));
}

function removeOrphan(path) {
  console.log(
    `  ${DRY_RUN ? "would delete" : "deleting"} orphaned directory ${relative(path)}`,
  );
  unlinkTopLevelLinks(path);
  if (DRY_RUN) return true;

  try {
    // maxRetries covers the transient Windows sharing violations that an antivirus
    // scanner or a lingering handle produces partway through 60k+ files.
    rmSync(path, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
    return true;
  } catch (error) {
    console.error(`    giving up on ${path}: ${error.message}`);
    return false;
  }
}

/**
 * Empties `<dir>/.sandcastle/logs/`.
 *
 * Everything in it, whatever the extension and whether file or directory: the
 * directory is gitignored scratch that sandcastle creates on demand — it did not
 * exist until a run needed it — so there is no such thing as a
 * file in here that a sweep should preserve. Keeping anything back would only mean
 * `clean` leaves the tree in a state that is neither the run's nor a fresh clone's.
 *
 * The directory itself goes too when the sweep is complete, so a clean workspace
 * looks like one; a failure leaves it in place holding whatever survived.
 *
 * Returns `{ failed, count }` like deleteBranches, so a repo whose only leftover is
 * a log does not print "nothing to clean".
 */
function deleteLogs(dir) {
  const logs = logsDir(dir);
  if (!existsSync(logs)) return { failed: 0, count: 0 };

  const entries = readdirSync(logs, { withFileTypes: true }).map((entry) =>
    join(logs, entry.name),
  );

  let failed = 0;
  for (const entry of entries) {
    if (DRY_RUN) {
      console.log(`  would delete log ${relative(entry)}`);
      continue;
    }
    try {
      // recursive: covers a subdirectory as readily as a file, so nothing in here
      // needs to be classified before it can be removed.
      rmSync(entry, { recursive: true, force: true, maxRetries: 3 });
      console.log(`  deleted log ${relative(entry)}`);
    } catch (error) {
      // A run still in flight holds its log open on Windows; that is a reason to
      // report the file and carry on, not to abort the sweep.
      console.error(`    could not delete ${relative(entry)}: ${error.message}`);
      failed += 1;
    }
  }

  if (!DRY_RUN && failed === 0 && entries.length > 0) {
    try {
      rmdirSync(logs);
    } catch {
      // Left behind because something reappeared in it — the next run's log, most
      // likely. Harmless: the files this pass was asked to remove are gone.
    }
  }

  return { failed, count: entries.length };
}

function deleteBranches(repo) {
  // A bare hierarchy name matches every ref beneath it, so this lists
  // `sandcastle/issue-01-…`, `sandcastle/issue-02-…`, and so on.
  const branches = git(repo, [
    "for-each-ref",
    "--format=%(refname:short)",
    BRANCH_PREFIX.replace(/\/$/, ""),
  ])
    .split(/\r?\n/)
    .filter((branch) => branch !== "");

  let failed = 0;
  for (const branch of branches) {
    if (DRY_RUN) {
      console.log(`  would delete branch ${branch}`);
      continue;
    }
    try {
      git(repo, ["branch", "-D", branch]);
      console.log(`  deleted branch ${branch}`);
      // The runner's stage markers (lib/branch-state.mjs) name the branch; a new
      // branch of the same name must not inherit them.
      clearStages(repo, branch);
    } catch (error) {
      // Most likely still claimed by a worktree we could not remove above.
      console.error(`    ${error.message}`);
      failed += 1;
    }
  }

  return { failed, count: branches.length };
}

/** Workspace-relative path, so the per-repo output stays readable. */
function relative(path) {
  const prefix = resolve(WORKSPACE_ROOT) + sep;
  const normalised = resolve(path);
  return normalised.startsWith(prefix)
    ? normalised.slice(prefix.length)
    : normalised;
}

/** Sweeps one repository, logging what it does. Returns the failure count. */
function cleanRepo(repo) {
  // Clears registrations whose directory a previous cleanup (or an interrupted
  // run) already deleted, so the listing below reflects what is really on disk.
  git(repo, ["worktree", "prune"]);

  const repoPath = resolve(repo);
  const scratch = resolve(worktreesDir(repo));

  const targets = listWorktrees(repo).filter(
    (worktree) =>
      // Belt-and-braces: never delete a project's own checkout, whatever branch it
      // happens to be on.
      worktree.path !== repoPath &&
      // Either marker is enough. The branch prefix catches a sandbox wherever it
      // sits; the path catches one that has no branch at all, which is what a run
      // killed before it finished checking out leaves registered — and since the
      // scratch directory is gitignored and sandcastle-owned, a worktree inside it
      // is disposable by construction.
      //
      // The `+ sep` matters: a bare prefix test would also match a sibling named
      // `worktrees-keep`. Both sides went through resolve(), so the separator is
      // the platform's regardless of the forward slashes git printed.
      (worktree.branch?.startsWith(BRANCH_PREFIX) ||
        worktree.path.startsWith(scratch + sep)),
  );

  let failed = targets.filter(
    (worktree) => !removeWorktree(repo, worktree),
  ).length;

  // Every path git still claims, including the project checkout and any worktree
  // this pass did not target — those must survive even if they live under
  // .sandcastle/worktrees/.
  const stillRegistered = new Set(
    listWorktrees(repo)
      .map((worktree) => worktree.path)
      .concat(repoPath),
  );

  const orphans = orphanedWorktreeDirs(repo, stillRegistered);
  failed += orphans.filter((path) => !removeOrphan(path)).length;

  const branches = deleteBranches(repo);
  failed += branches.failed;

  const logs = deleteLogs(repo);
  failed += logs.failed;

  if (
    targets.length === 0 &&
    orphans.length === 0 &&
    branches.count === 0 &&
    logs.count === 0
  ) {
    console.log("  nothing to clean");
  }
  return failed;
}

// ---------------------------------------------------------------------------

try {
  // Resolved first, because an unmatched name in ONLY is a typo that should abort
  // before anything is deleted.
  const repos = childRepos();

  let failed = 0;

  // One stanza per repository, headed by its name. cleanRepo logs as it goes, so the
  // header is printed before it runs; a repo that turns out to be clean costs the
  // two lines below, which is worth paying to show that it *was* visited — silence
  // is what the root-only version of this script offered, and it read as success.
  for (const repo of repos) {
    console.log(`\n${basename(repo)}`);
    try {
      failed += cleanRepo(repo);
    } catch (error) {
      console.error(`  ${error.message}`);
      failed += 1;
    }
  }

  if (failed > 0) {
    console.error(
      `\nsandcastle:clean finished with ${failed} failure(s). Stop anything still holding ` +
        `those files (check \`docker ps\` for orphaned sandcastle-* containers) and re-run.`,
    );
    process.exit(1);
  }

  console.log(DRY_RUN ? "\nDry run complete." : "\nClean.");
} catch (error) {
  console.error(`sandcastle:clean: ${error.message}`);
  process.exit(1);
}
