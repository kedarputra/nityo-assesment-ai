import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  branchProgress,
  clearStages,
  ensureWorktree,
  findWorktree,
  managedWorktreePath,
  markStage,
  preserveWip,
  restoreStoredLineEndings,
  restoreUnrequestedLockfiles,
  stageOf,
  syncWithBase,
} from "../lib/branch-state.mjs";
import { git } from "../lib/git.mjs";
import { commitFile, head, makeRepo, status, write } from "./helpers.mjs";

const BASE = "feat/tt-1-effort";
const BRANCH = "sandcastle/issue-01-thing";

test("ensureWorktree cuts a new branch from the base at sandcastle's path, then reuses it", (t) => {
  const repo = makeRepo(t);
  const made = ensureWorktree(repo, BRANCH, BASE);
  assert.equal(made.created, true);
  assert.equal(resolve(made.path), managedWorktreePath(repo, BRANCH));
  assert.equal(head(made.path), head(repo));

  const again = ensureWorktree(repo, BRANCH, BASE);
  assert.equal(again.created, false);
  assert.equal(resolve(again.path), resolve(made.path));
  assert.equal(stageOf(repo, BRANCH), "in-progress");
});

test("ensureWorktree writes files as stored, even where the host converts to CRLF", (t) => {
  const repo = makeRepo(t);
  git(repo, ["config", "core.autocrlf", "true"]);
  const { path } = ensureWorktree(repo, BRANCH, BASE);
  assert.equal(readFileSync(join(path, "README.md"), "utf8"), "base\n");
  // As the sandbox's git sees it: no setting, so any CRLF would be a change.
  assert.equal(git(path, ["-c", "core.autocrlf=false", "status", "--porcelain"]).stdout, "");
});

test("restoreStoredLineEndings rewrites line-ending-only copies, never a real change", (t) => {
  const repo = makeRepo(t);
  commitFile(repo, "other.txt", "one\n");
  const { path } = ensureWorktree(repo, BRANCH, BASE);
  write(path, "README.md", "base\r\n");
  write(path, "other.txt", "one\r\ntwo\r\n");

  assert.deepEqual(restoreStoredLineEndings(path), ["README.md"]);
  assert.equal(readFileSync(join(path, "README.md"), "utf8"), "base\n");
  assert.equal(readFileSync(join(path, "other.txt"), "utf8"), "one\r\ntwo\r\n");
  assert.deepEqual(restoreStoredLineEndings(path), [], "a second call has nothing to do");
});

test("restoreStoredLineEndings finds CRLF copies the host's git calls unchanged", (t) => {
  // A worktree as the old runner made it: a plain checkout on a CRLF host. Its
  // file stats match git's cache, so the host's `git diff` reports nothing.
  const repo = makeRepo(t);
  git(repo, ["config", "core.autocrlf", "true"]);
  const path = join(repo, ".sandcastle", "worktrees", "old-style");
  git(repo, ["worktree", "add", "--quiet", "-b", BRANCH, path, BASE]);
  write(path, ".gitattributes", "*.bat text eol=crlf\n");
  git(path, ["-c", "core.autocrlf=false", "add", ".gitattributes"]);
  git(path, ["commit", "--quiet", "-m", "attributes"]);
  commitFile(path, "run.bat", "echo hi\n");
  rmSync(join(path, "run.bat"));
  git(path, ["checkout-index", "--force", "-u", "--", "run.bat"]);
  assert.equal(readFileSync(join(path, "run.bat"), "utf8"), "echo hi\r\n");
  assert.equal(readFileSync(join(path, "README.md"), "utf8"), "base\r\n");
  assert.equal(git(path, ["status", "--porcelain"]).stdout, "", "the host sees nothing");

  assert.deepEqual(restoreStoredLineEndings(path), ["README.md"]);
  assert.equal(readFileSync(join(path, "README.md"), "utf8"), "base\n");
  assert.equal(readFileSync(join(path, "run.bat"), "utf8"), "echo hi\r\n", "CRLF asked for stays");
  assert.equal(git(path, ["-c", "core.autocrlf=false", "status", "--porcelain"]).stdout, "");
});

test("ensureWorktree checks out an existing branch that has no worktree", (t) => {
  const repo = makeRepo(t);
  git(repo, ["branch", BRANCH]);
  const made = ensureWorktree(repo, BRANCH, BASE);
  assert.equal(made.created, true);
  assert.equal(git(made.path, ["branch", "--show-current"]).stdout, BRANCH);
});

test("preserveWip commits interrupted edits on the branch and keeps env files out", (t) => {
  const repo = makeRepo(t);
  const { path } = ensureWorktree(repo, BRANCH, BASE);
  assert.equal(preserveWip(path, "WIP"), null, "nothing to save in a clean worktree");

  write(path, "src/half-done.ts", "export const x = 1;\n");
  write(path, "README.md", "edited\n");
  write(path, ".env", "SECRET=1\n");
  write(path, "config/local.env", "SECRET=2\n");
  const sha = preserveWip(path, "RALPH(wip): saved");

  assert.ok(sha);
  assert.equal(head(repo, BRANCH), sha, "the commit is on the ticket branch");
  const committed = git(path, ["show", "--name-only", "--format=", sha]).stdout.split("\n").sort();
  assert.deepEqual(committed, ["README.md", "src/half-done.ts"]);
  assert.match(status(path), /\.env/, "env files stay uncommitted");
  assert.equal(head(repo, BASE), head(repo), "the base is untouched");
});

test("syncWithBase: up to date, fast-forward, clean merge", (t) => {
  const repo = makeRepo(t);
  const { path } = ensureWorktree(repo, BRANCH, BASE);
  assert.equal(syncWithBase(path, BASE).status, "up-to-date");

  commitFile(repo, "base-1.txt", "1\n");
  assert.equal(syncWithBase(path, BASE).status, "fast-forwarded");
  assert.equal(head(path), head(repo));

  commitFile(path, "ticket.txt", "ticket\n");
  commitFile(repo, "base-2.txt", "2\n");
  assert.equal(syncWithBase(path, BASE).status, "merged");
  assert.ok(existsSync(join(path, "base-2.txt")));
  assert.ok(existsSync(join(path, "ticket.txt")));
});

test("syncWithBase aborts a conflicting merge and leaves the branch as it was", (t) => {
  const repo = makeRepo(t);
  const { path } = ensureWorktree(repo, BRANCH, BASE);
  const ticketTip = commitFile(path, "README.md", "ticket side\n");
  commitFile(repo, "README.md", "base side\n");

  const result = syncWithBase(path, BASE);
  assert.equal(result.status, "conflict");
  assert.deepEqual(result.files, ["README.md"]);
  assert.equal(head(path), ticketTip);
  assert.equal(status(path), "");
});

test("stage markers count only while they still name the tip", (t) => {
  const repo = makeRepo(t);
  assert.equal(stageOf(repo, BRANCH), "new");
  const { path } = ensureWorktree(repo, BRANCH, BASE);
  commitFile(path, "a.txt", "a\n");

  markStage(repo, "implemented", BRANCH);
  assert.equal(stageOf(repo, BRANCH), "implemented");

  commitFile(path, "b.txt", "review refinement\n");
  assert.equal(stageOf(repo, BRANCH), "in-progress", "a later commit voids the sign-off");

  markStage(repo, "reviewed", BRANCH);
  assert.equal(stageOf(repo, BRANCH), "reviewed");

  write(path, "c.txt", "interrupted\n");
  preserveWip(path, "WIP");
  assert.equal(stageOf(repo, BRANCH), "in-progress", "a WIP commit is never a finished state");

  clearStages(repo, BRANCH);
  assert.equal(git(repo, ["for-each-ref", "refs/sandcastle"]).stdout, "");
});

test("branchProgress lists the branch's own commits and what is uncommitted", (t) => {
  const repo = makeRepo(t);
  const { path } = ensureWorktree(repo, BRANCH, BASE);
  assert.match(branchProgress(path, BASE), /fresh start/);

  commitFile(path, "a.txt", "a\n", "RALPH(wip): schema");
  write(path, "b.txt", "b\n");
  const progress = branchProgress(path, BASE);
  assert.match(progress, /1 commit\(s\)/);
  assert.match(progress, /RALPH\(wip\): schema/);
  assert.match(progress, /\?\? b\.txt/);
});

test("a nested, independent repository is worked on alone; its parent is untouched", (t) => {
  const parent = makeRepo(t, { branch: "docs/tt-1-effort" });
  write(parent, ".gitignore", "/child/\n");
  git(parent, ["add", ".gitignore"]);
  git(parent, ["commit", "--quiet", "-m", "ignore the child"]);
  const parentTip = head(parent);

  const child = makeRepo(t, { dir: join(parent, "child") });
  const { path } = ensureWorktree(child, BRANCH, BASE);
  write(path, "work.txt", "child work\n");
  preserveWip(path, "WIP");
  markStage(child, "implemented", BRANCH);

  assert.equal(findWorktree(parent, BRANCH), null, "the parent has no such worktree");
  assert.equal(head(parent), parentTip);
  assert.equal(status(parent), "");
  assert.equal(git(parent, ["for-each-ref", "refs/sandcastle"]).stdout, "");
  assert.equal(stageOf(child, BRANCH), "implemented");
});

test("preserveWip drops a lockfile npm rewrote alone, and keeps one that came with its manifest", (t) => {
  const repo = makeRepo(t);
  commitFile(repo, "package.json", '{"dependencies":{}}\n');
  commitFile(repo, "package-lock.json", "lock v1\n");
  commitFile(repo, "app/package.json", '{"dependencies":{}}\n');
  commitFile(repo, "app/package-lock.json", "app lock v1\n");
  const { path } = ensureWorktree(repo, "sandcastle/issue-01-a", BASE);

  write(path, "package-lock.json", "lock rewritten by npm install\n");
  write(path, "app/package.json", '{"dependencies":{"left-pad":"1"}}\n');
  write(path, "app/package-lock.json", "app lock with left-pad\n");
  write(path, "src.ts", "work\n");

  assert.deepEqual(restoreUnrequestedLockfiles(path), ["package-lock.json"]);
  const sha = preserveWip(path, "RALPH(wip): test");
  const files = git(path, ["show", "--name-only", "--format=", sha]).stdout.split("\n").sort();
  assert.deepEqual(files, ["app/package-lock.json", "app/package.json", "src.ts"]);
  assert.equal(readFileSync(join(path, "package-lock.json"), "utf8"), "lock v1\n");
});
