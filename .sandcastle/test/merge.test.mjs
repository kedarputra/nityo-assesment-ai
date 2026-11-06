import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureWorktree, markStage, stageOf } from "../lib/branch-state.mjs";
import { git, isAncestor, mergeInProgress } from "../lib/git.mjs";
import { mergeIntoCheckout } from "../lib/merge.mjs";
import { commitFile, head, makeRepo, status, write } from "./helpers.mjs";

const BASE = "feat/tt-1-effort";

function ticketBranch(repo, name, file, content) {
  const branch = `sandcastle/issue-${name}`;
  const { path } = ensureWorktree(repo, branch, BASE);
  commitFile(path, file, content);
  return branch;
}

test("a clean merge needs no model, and a second run finds it already merged", (t) => {
  const repo = makeRepo(t);
  const branch = ticketBranch(repo, "01-a", "a.txt", "a\n");

  const merged = mergeIntoCheckout(repo, branch);
  assert.equal(merged.status, "merged");
  assert.equal(merged.head, head(repo));
  assert.ok(isAncestor(repo, branch, "HEAD"));

  assert.equal(mergeIntoCheckout(repo, branch).status, "already-merged");
});

test("a conflict is aborted, the checkout left clean, and the files named", (t) => {
  const repo = makeRepo(t);
  const branch = ticketBranch(repo, "01-a", "README.md", "ticket\n");
  commitFile(repo, "README.md", "base moved\n");
  const before = head(repo);

  const result = mergeIntoCheckout(repo, branch);
  assert.equal(result.status, "conflict");
  assert.deepEqual(result.files, ["README.md"]);
  assert.equal(head(repo), before);
  assert.equal(mergeInProgress(repo), false);
  assert.equal(status(repo), "");
});

test("other git failures are errors, not conflicts, and change nothing", (t) => {
  const repo = makeRepo(t);
  assert.match(mergeIntoCheckout(repo, "sandcastle/issue-missing").detail, /does not exist/);

  // A developer's uncommitted edit in the way of the merge.
  const branch = ticketBranch(repo, "01-a", "a.txt", "ticket\n");
  write(repo, "a.txt", "developer's own edit\n");
  const before = head(repo);
  const result = mergeIntoCheckout(repo, branch);
  assert.equal(result.status, "error");
  assert.equal(head(repo), before);
  assert.match(status(repo), /a\.txt/, "the developer's edit is still there");
});

test("a merge someone else left in progress is reported, never aborted", (t) => {
  const repo = makeRepo(t);
  const theirs = ticketBranch(repo, "01-a", "README.md", "theirs\n");
  commitFile(repo, "README.md", "ours\n");
  git(repo, ["merge", theirs], { allowFail: true });
  assert.equal(mergeInProgress(repo), true);

  const mine = ticketBranch(repo, "02-b", "b.txt", "b\n");
  const result = mergeIntoCheckout(repo, mine);
  assert.equal(result.status, "error");
  assert.match(result.detail, /already in progress/);
  assert.equal(mergeInProgress(repo), true, "their merge is left for them");
});

test("an effort split across two repos merges per repo; one half can land alone", (t) => {
  const be = makeRepo(t);
  const web = makeRepo(t);
  const beHalf = ticketBranch(be, "04-api", "api.txt", "route\n");
  markStage(be, "reviewed", beHalf);
  const webHalf = ticketBranch(web, "05-screen", "README.md", "screen\n");
  markStage(web, "reviewed", webHalf);
  commitFile(web, "README.md", "web base moved\n");

  assert.equal(mergeIntoCheckout(be, beHalf).status, "merged");
  assert.equal(mergeIntoCheckout(web, webHalf).status, "conflict");

  // The backend half is integrated and can close; the web half stays open,
  // reviewed and unmerged, with its work on its branch.
  assert.ok(isAncestor(be, beHalf, "HEAD"));
  assert.equal(isAncestor(web, webHalf, "HEAD"), false);
  assert.equal(stageOf(web, webHalf), "reviewed");
});
