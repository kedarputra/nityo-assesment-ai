import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ensureWorktree } from "../lib/branch-state.mjs";
import { markNodeModulesReady, prepareNodeModules } from "../lib/node-modules.mjs";
import { makeRepo, status, write } from "./helpers.mjs";

const BASE = "feat/tt-1-effort";
const BRANCH = "sandcastle/issue-01-thing";

const worktreeOf = (t) => ensureWorktree(makeRepo(t), BRANCH, BASE).path;

test("a worktree with no node_modules gets the copy", (t) => {
  const worktree = worktreeOf(t);
  assert.deepEqual(prepareNodeModules(worktree), { copy: true, removed: false });
});

test("node_modules a stopped copy left, with no marker, is deleted and copied again", (t) => {
  const worktree = worktreeOf(t);
  write(worktree, "node_modules/half/index.js", "");
  assert.deepEqual(prepareNodeModules(worktree), { copy: true, removed: true });
  assert.equal(existsSync(join(worktree, "node_modules")), false);
});

test("node_modules with the marker is kept, and the copy is skipped", (t) => {
  const worktree = worktreeOf(t);
  write(worktree, "node_modules/whole/index.js", "");
  markNodeModulesReady(worktree);
  assert.deepEqual(prepareNodeModules(worktree), { copy: false, removed: false });
  assert.equal(existsSync(join(worktree, "node_modules", "whole", "index.js")), true);
});

test("the marker alone does not stand for a node_modules that is gone", (t) => {
  const worktree = worktreeOf(t);
  markNodeModulesReady(worktree);
  assert.deepEqual(prepareNodeModules(worktree), { copy: true, removed: false });
});

test("the marker is not a file in the worktree's tree", (t) => {
  const worktree = worktreeOf(t);
  markNodeModulesReady(worktree);
  assert.equal(status(worktree), "");
});
