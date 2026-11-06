// The git calls main.mts makes on the host, with the exit code kept.
//
// The runner has to tell a conflict from a permission error, a missing branch or
// a dirty checkout, and execFileSync's thrown error flattens all of those into
// one message. So every call returns { code, stdout, stderr }, and only throws
// when the caller did not expect it to fail.

import { spawnSync } from "node:child_process";

/**
 * Runs git in `cwd`. Throws on a non-zero exit unless `allowFail` is set. `input`
 * goes to git's stdin, for path lists too long for a Windows command line.
 */
export function git(cwd, args, { allowFail = false, input } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = {
    code: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? result.error?.message ?? "").trim(),
  };
  if (!allowFail && out.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd} (exit ${out.code})${out.stderr ? `: ${out.stderr}` : ""}`,
    );
  }
  return out;
}

/** The commit `ref` names, or null when it names none. */
export function revParse(cwd, ref) {
  const result = git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    allowFail: true,
  });
  return result.code === 0 ? result.stdout : null;
}

/** Whether `ancestor` is reachable from `descendant`. */
export function isAncestor(cwd, ancestor, descendant) {
  return git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant], { allowFail: true })
    .code === 0;
}

/** The branch checked out in `cwd`, or null on a detached HEAD. */
export function currentBranch(cwd) {
  return git(cwd, ["branch", "--show-current"]).stdout || null;
}

/** Commits on `branch` that `base` does not have. */
export function commitsAhead(cwd, base, branch) {
  const result = git(cwd, ["rev-list", "--count", `${base}..${branch}`], { allowFail: true });
  return result.code === 0 ? Number(result.stdout) : 0;
}

/** Paths git reports as unmerged, which is what a merge conflict leaves. */
export function unmergedPaths(cwd) {
  return git(cwd, ["diff", "--name-only", "--diff-filter=U"], { allowFail: true })
    .stdout.split(/\r?\n/)
    .filter(Boolean);
}

/** Whether a merge is in progress in `cwd`. */
export function mergeInProgress(cwd) {
  return revParse(cwd, "MERGE_HEAD") !== null;
}

/**
 * The `-c` flags that let a commit go through when the repo has no identity,
 * as a sandbox-made worktree may not.
 */
export function identityArgs(cwd) {
  if (git(cwd, ["config", "user.email"], { allowFail: true }).stdout) return [];
  return ["-c", "user.name=sandcastle", "-c", "user.email=sandcastle@localhost"];
}
