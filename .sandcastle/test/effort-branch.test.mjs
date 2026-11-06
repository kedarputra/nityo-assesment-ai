import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureWorktree } from "../lib/branch-state.mjs";
import {
  catchUpWithOrigin,
  fetchOrigin,
  moveToEffortBranch,
  needsEffortBranch,
  planEffortBranch,
  pushBranch,
  takeUpTicketBranch,
} from "../lib/effort-branch.mjs";
import { currentBranch, git, revParse } from "../lib/git.mjs";
import { commitFile, head, write } from "./helpers.mjs";

/**
 * A bare origin with `main`, and `clones` checkouts of it, each on `main`: one
 * machine per clone.
 */
function withOrigin(t, clones = 1) {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const origin = join(dir, "origin.git");
  git(dir, ["init", "--quiet", "--bare", "--initial-branch", "main", origin]);

  const clone = (name) => {
    const path = join(dir, name);
    // Set before the checkout: a host's autocrlf=true writes CRLF copies, which
    // read as uncommitted changes once autocrlf is turned off.
    git(dir, ["clone", "--quiet", "-c", "core.autocrlf=false", origin, path]);
    git(path, ["config", "user.name", "test"]);
    git(path, ["config", "user.email", "test@localhost"]);
    return path;
  };
  const seed = clone("seed");
  git(seed, ["switch", "--quiet", "-c", "main"]);
  commitFile(seed, "README.md", "base\n", "initial");
  git(seed, ["push", "--quiet", "origin", "main"]);
  const machines = Array.from({ length: clones }, (_, i) => clone(`machine-${i + 1}`));
  return { origin, seed, machines };
}

const onOrigin = (origin, ref) => revParse(origin, ref);

test("needsEffortBranch moves main, master and a detached HEAD, nothing else", () => {
  for (const branch of ["main", "master", null]) assert.equal(needsEffortBranch(branch), true);
  for (const branch of ["feat/tt-1-x", "docs/tt-1-x", "release"]) {
    assert.equal(needsEffortBranch(branch), false);
  }
});

test("a checkout on main moves to a new effort branch cut from origin/main, with no upstream", (t) => {
  const { seed, machines: [repo] } = withOrigin(t);
  commitFile(seed, "later.txt", "x\n");
  git(seed, ["push", "--quiet", "origin", "main"]); // this machine's main is now behind

  assert.equal(fetchOrigin(repo), null);
  const plan = planEffortBranch(repo, ["hp-15-order-intake"], "feat");
  assert.deepEqual(plan, {
    move: { from: "main", to: "feat/hp-15-order-intake", source: "new" },
  });
  moveToEffortBranch(repo, plan.move);

  assert.equal(currentBranch(repo), "feat/hp-15-order-intake");
  assert.equal(head(repo), head(repo, "origin/main"));
  assert.notEqual(head(repo, "main"), head(repo)); // the local main is left as it was
  assert.notEqual(git(repo, ["rev-parse", "--abbrev-ref", "@{upstream}"], { allowFail: true }).code, 0);
});

test("the effort branch is taken from this machine first, then from origin", (t) => {
  const { origin, machines: [a, b] } = withOrigin(t, 2);
  git(a, ["switch", "--quiet", "-c", "docs/tt-1-x"]);
  commitFile(a, "a.txt", "a\n");
  git(a, ["push", "--quiet", "-u", "origin", "docs/tt-1-x"]);
  git(a, ["switch", "--quiet", "main"]);

  assert.equal(planEffortBranch(a, ["tt-1-x"], "docs").move.source, "local");

  fetchOrigin(b);
  const plan = planEffortBranch(b, ["tt-1-x"], "docs");
  assert.equal(plan.move.source, "origin");
  moveToEffortBranch(b, plan.move);
  assert.equal(head(b), head(origin, "docs/tt-1-x"));
  assert.equal(git(b, ["rev-parse", "--abbrev-ref", "@{upstream}"]).stdout, "origin/docs/tt-1-x");
});

test("a checkout on main stays, with the reason, when the move would be a guess or lose work", (t) => {
  const { machines: [twoEfforts, dirty, unpushed, untracked] } = withOrigin(t, 4);
  write(dirty, "README.md", "changed\n");
  commitFile(unpushed, "local-only.txt", "x\n");
  write(untracked, "scratch.txt", "x\n");

  assert.match(planEffortBranch(twoEfforts, ["tt-1-a", "tt-2-b"], "feat").hold, /2 efforts.*--map/);
  assert.match(planEffortBranch(dirty, ["tt-1-a"], "feat").hold, /uncommitted changes/);
  assert.match(planEffortBranch(unpushed, ["tt-1-a"], "feat").hold, /1 commit\(s\) origin\/main does not have/);
  // An untracked file is no reason: a switch leaves it alone, or git refuses.
  assert.equal(planEffortBranch(untracked, ["tt-1-a"], "feat").move.source, "new");
  for (const repo of [twoEfforts, dirty, unpushed, untracked]) assert.equal(currentBranch(repo), "main");
});

test("catchUpWithOrigin fast-forwards a branch another machine pushed to, and leaves a diverged one", (t) => {
  const { machines: [a, b] } = withOrigin(t, 2);
  for (const repo of [a, b]) git(repo, ["switch", "--quiet", "-c", "feat/tt-1-x", "--no-track", "origin/main"]);
  git(a, ["push", "--quiet", "-u", "origin", "feat/tt-1-x"]);
  assert.equal(catchUpWithOrigin(b), "no-remote"); // b has not fetched it yet

  fetchOrigin(b);
  assert.equal(catchUpWithOrigin(b), "up-to-date");
  commitFile(a, "a.txt", "a\n");
  git(a, ["push", "--quiet"]);
  fetchOrigin(b);
  assert.equal(catchUpWithOrigin(b), "caught-up");
  assert.equal(head(b), head(a));
  assert.equal(currentBranch(b), "feat/tt-1-x");

  commitFile(a, "a2.txt", "a\n");
  git(a, ["push", "--quiet"]);
  commitFile(b, "b.txt", "b\n");
  const mine = head(b);
  fetchOrigin(b);
  assert.equal(catchUpWithOrigin(b), "diverged");
  assert.equal(head(b), mine);
});

test("takeUpTicketBranch resumes a ticket another machine started, and never rewinds one", (t) => {
  const { machines: [a, b] } = withOrigin(t, 2);
  const BASE = "feat/tt-1-x";
  const TICKET = "sandcastle/issue-01-a";
  for (const repo of [a, b]) git(repo, ["switch", "--quiet", "-c", BASE, "--no-track", "origin/main"]);
  assert.equal(takeUpTicketBranch(b, TICKET, null), "no-remote");

  // Machine A starts the ticket and pushes it.
  const { path: wtA } = ensureWorktree(a, TICKET, BASE);
  commitFile(wtA, "one.txt", "1\n");
  git(a, ["push", "--quiet", "origin", TICKET]);

  // Machine B has no copy: it is created from origin's.
  fetchOrigin(b);
  assert.equal(takeUpTicketBranch(b, TICKET, null), "created");
  assert.equal(head(b, TICKET), head(wtA));
  assert.equal(takeUpTicketBranch(b, TICKET, null), "up-to-date");

  // A goes on. B's copy, with no worktree, is fast-forwarded.
  commitFile(wtA, "two.txt", "2\n");
  git(a, ["push", "--quiet", "origin", TICKET]);
  fetchOrigin(b);
  assert.equal(takeUpTicketBranch(b, TICKET, null), "caught-up");
  assert.equal(head(b, TICKET), head(wtA));

  // A goes on again. B's copy now has a clean worktree: it moves through it.
  const { path: wtB } = ensureWorktree(b, TICKET, BASE);
  commitFile(wtA, "three.txt", "3\n");
  git(a, ["push", "--quiet", "origin", TICKET]);
  fetchOrigin(b);
  assert.equal(takeUpTicketBranch(b, TICKET, wtB), "caught-up");
  assert.equal(head(wtB), head(wtA));

  // A dirty worktree is not moved, and neither is a branch with commits of its own.
  commitFile(wtA, "four.txt", "4\n");
  git(a, ["push", "--quiet", "origin", TICKET]);
  fetchOrigin(b);
  write(wtB, "half.txt", "half\n");
  const before = head(wtB);
  assert.equal(takeUpTicketBranch(b, TICKET, wtB), "diverged");
  assert.equal(head(wtB), before);
  git(wtB, ["add", "half.txt"]);
  git(wtB, ["commit", "--quiet", "-m", "own work"]);
  assert.equal(takeUpTicketBranch(b, TICKET, wtB), "diverged");
});

test("pushBranch pushes with an upstream, never a tag, never main or master, never forced", (t) => {
  const { origin, machines: [a, b] } = withOrigin(t, 2);
  git(a, ["config", "push.followTags", "true"]);
  git(a, ["switch", "--quiet", "-c", "feat/tt-1-x", "--no-track", "origin/main"]);
  commitFile(a, "a.txt", "a\n");
  git(a, ["tag", "-a", "v9.9.9", "-m", "a tag starts the staging deploy"]);

  assert.deepEqual(pushBranch(a, "feat/tt-1-x"), { status: "pushed" });
  assert.equal(onOrigin(origin, "feat/tt-1-x"), head(a));
  assert.equal(onOrigin(origin, "refs/tags/v9.9.9"), null);
  assert.equal(git(a, ["rev-parse", "--abbrev-ref", "@{upstream}"]).stdout, "origin/feat/tt-1-x");

  const mainOnOrigin = onOrigin(origin, "main");
  for (const branch of ["main", "master", null]) {
    if (branch) git(a, ["switch", "--quiet", "-C", branch]);
    if (branch) commitFile(a, `${branch}.txt`, "x\n");
    assert.equal(pushBranch(a, branch).status, "never");
  }
  assert.equal(onOrigin(origin, "main"), mainOnOrigin);
  assert.equal(onOrigin(origin, "master"), null);

  // Another machine pushed first: refused, and origin keeps its commits.
  fetchOrigin(b);
  git(b, ["switch", "--quiet", "--track", "-c", "feat/tt-1-x", "origin/feat/tt-1-x"]);
  commitFile(b, "b.txt", "b\n");
  git(b, ["push", "--quiet"]);
  git(a, ["switch", "--quiet", "feat/tt-1-x"]);
  commitFile(a, "a2.txt", "a\n");
  const result = pushBranch(a, "feat/tt-1-x");
  assert.equal(result.status, "refused");
  assert.ok(result.detail);
  assert.equal(onOrigin(origin, "feat/tt-1-x"), head(b));
});
