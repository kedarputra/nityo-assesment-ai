// Throwaway git repositories for the runner's tests. Each lives in the OS temp
// directory and is removed by the test that made it.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git } from "../lib/git.mjs";

export function makeRepo(t, { branch = "feat/tt-1-effort", dir } = {}) {
  const root = dir ?? mkdtempSync(join(tmpdir(), "sandcastle-test-"));
  mkdirSync(root, { recursive: true });
  if (!dir) t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));

  git(root, ["init", "--quiet", "--initial-branch", "main"]);
  git(root, ["config", "user.name", "test"]);
  git(root, ["config", "user.email", "test@localhost"]);
  git(root, ["config", "core.autocrlf", "false"]);
  // As in each real project: sandcastle's worktrees and logs are excluded locally.
  writeFileSync(join(root, ".git", "info", "exclude"), ".sandcastle/\n");
  commitFile(root, "README.md", "base\n", "initial");
  git(root, ["checkout", "--quiet", "-b", branch]);
  return root;
}

export function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

export function commitFile(root, path, content, message = `edit ${path}`) {
  write(root, path, content);
  git(root, ["add", "--", path]);
  git(root, ["commit", "--quiet", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]).stdout;
}

export const head = (root, ref = "HEAD") => git(root, ["rev-parse", ref]).stdout;
export const status = (root) => git(root, ["status", "--porcelain"]).stdout;
