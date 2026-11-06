import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  changesSinceCheck,
  checkBranchFor,
  checkState,
  keepFixAttempt,
  markCheckPassed,
  markCheckPending,
  prepareCheckBranch,
} from "../lib/check-branch.mjs";
import { git, mergeInProgress } from "../lib/git.mjs";
import { mergeIntoCheckout } from "../lib/merge.mjs";
import { commitFile, head, makeRepo, status, write } from "./helpers.mjs";

const BASE = "feat/tt-1-effort";

test("the check branch is named for the checkout's branch, under sandcastle/", () => {
  assert.equal(checkBranchFor(BASE), "sandcastle/check-feat-tt-1-effort");
});

test("a new check branch starts at the checkout's HEAD", (t) => {
  const repo = makeRepo(t);
  commitFile(repo, "a.txt", "merged ticket\n");

  const { branch, worktree, attempt } = prepareCheckBranch(repo, BASE);
  assert.equal(branch, checkBranchFor(BASE));
  assert.equal(head(worktree), head(repo));
  assert.equal(attempt, null);
});

test("each check moves the branch to the checkout's new HEAD and clears leftovers", (t) => {
  const repo = makeRepo(t);
  const { worktree } = prepareCheckBranch(repo, BASE);
  // What a sandbox can leave: a rewritten tracked file and an untracked one.
  write(worktree, "README.md", "lockfile rewritten by npm install\n");
  write(worktree, "stray.txt", "left by a check\n");
  commitFile(repo, "b.txt", "the next round's merge\n");

  const again = prepareCheckBranch(repo, BASE);
  // git lists the path with `/`, node made it with `\` on Windows.
  assert.equal(resolve(again.worktree), resolve(worktree), "the worktree is reused");
  assert.equal(head(worktree), head(repo));
  assert.equal(status(worktree), "");
  assert.equal(again.attempt, null, "uncommitted leftovers are no fix attempt");
});

test("a fix that was merged leaves nothing to keep", (t) => {
  const repo = makeRepo(t);
  const { branch, worktree } = prepareCheckBranch(repo, BASE);
  commitFile(worktree, "fix.txt", "the fixer's green fix\n");
  assert.equal(mergeIntoCheckout(repo, branch).status, "merged");

  assert.equal(keepFixAttempt(repo, BASE), null);
  assert.equal(prepareCheckBranch(repo, BASE).attempt, null);
  assert.equal(head(worktree), head(repo));
});

test("a red fixer's commits are kept on their own branch before the reset", (t) => {
  const repo = makeRepo(t);
  const { worktree } = prepareCheckBranch(repo, BASE);
  const fix = commitFile(worktree, "fix.txt", "a fix that stayed red\n");

  const attempt = keepFixAttempt(repo, BASE);
  assert.equal(attempt, `sandcastle/fix-attempt-feat-tt-1-effort-${fix.slice(0, 8)}`);
  assert.equal(head(repo, attempt), fix);
  assert.equal(keepFixAttempt(repo, BASE), attempt, "keeping it twice makes no second branch");

  const again = prepareCheckBranch(repo, BASE);
  assert.equal(again.attempt, attempt);
  assert.equal(head(worktree), head(repo), "the check branch is back at the checkout's HEAD");
  assert.equal(head(repo, attempt), fix, "the attempt survives the reset");
  assert.equal(existsSync(join(worktree, "fix.txt")), false);
});

test("a merge a fixer left in progress is aborted first", (t) => {
  const repo = makeRepo(t);
  const { worktree } = prepareCheckBranch(repo, BASE);
  commitFile(worktree, "README.md", "fixer\n");
  commitFile(repo, "README.md", "checkout\n");
  git(worktree, ["merge", BASE], { allowFail: true });
  assert.equal(mergeInProgress(worktree), true);

  const again = prepareCheckBranch(repo, BASE);
  assert.equal(mergeInProgress(worktree), false);
  assert.match(again.attempt, /^sandcastle\/fix-attempt-/);
  assert.equal(head(worktree), head(repo));
});

test("the check state follows the tip: unchecked, pending after a merge, passed after a pass", (t) => {
  const repo = makeRepo(t);
  assert.equal(checkState(repo, BASE), "unchecked", "never checked");

  markCheckPassed(repo, BASE);
  assert.equal(checkState(repo, BASE), "passed");

  commitFile(repo, "dev.txt", "a developer's commit\n");
  assert.equal(checkState(repo, BASE), "unchecked", "moved by someone else");

  markCheckPending(repo, BASE);
  assert.equal(checkState(repo, BASE), "pending", "moved by the runner's merge");

  markCheckPassed(repo, BASE);
  assert.equal(checkState(repo, BASE), "passed");
  commitFile(repo, "dev2.txt", "another commit\n");
  assert.equal(checkState(repo, BASE), "unchecked", "a pass clears the pending ref");
});

test("a tip that is origin/main's tip needs no check; one commit on top does", (t) => {
  const repo = makeRepo(t);
  git(repo, ["update-ref", "refs/remotes/origin/main", head(repo)]);
  assert.equal(checkState(repo, BASE), "main", "a fresh cut from origin/main");

  commitFile(repo, "dev.txt", "a commit main does not have\n");
  assert.equal(checkState(repo, BASE), "unchecked");

  markCheckPending(repo, BASE);
  assert.equal(checkState(repo, BASE), "pending");
});

test("the fixer's changes list starts after the last commit that passed", (t) => {
  const repo = makeRepo(t);
  commitFile(repo, "old.txt", "old\n", "old work");
  markCheckPassed(repo, BASE);
  commitFile(repo, "new.txt", "new\n", "merge of ticket 03");

  const changes = changesSinceCheck(repo, BASE);
  assert.match(changes, /merge of ticket 03/);
  assert.doesNotMatch(changes, /old work/);
});

test("a resumed fixer goes on from its own commits on the same tip", (t) => {
  const repo = makeRepo(t);
  const { worktree } = prepareCheckBranch(repo, BASE);
  const fix = commitFile(worktree, "fix.txt", "half a fix\n");
  write(worktree, "scratch.txt", "uncommitted\n");

  const again = prepareCheckBranch(repo, BASE, { resume: true });
  assert.equal(again.resumed, true);
  assert.equal(again.attempt, null);
  assert.equal(head(worktree), fix, "the branch stays at the fixer's commit");
  assert.equal(status(worktree), "", "uncommitted leftovers are cleared");
});

test("a resume after the tip moved keeps the old attempt and starts from the tip", (t) => {
  const repo = makeRepo(t);
  const { worktree } = prepareCheckBranch(repo, BASE);
  const fix = commitFile(worktree, "fix.txt", "a fix for the old tip\n");
  commitFile(repo, "dev.txt", "a developer fixed it another way\n");

  const again = prepareCheckBranch(repo, BASE, { resume: true });
  assert.equal(again.resumed, false);
  assert.equal(head(repo, again.attempt), fix);
  assert.equal(head(worktree), head(repo));
});
