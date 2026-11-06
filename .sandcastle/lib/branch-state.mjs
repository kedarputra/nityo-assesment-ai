// A ticket branch's state on the host, read and repaired before any model runs.
//
// A run can stop part-way through a ticket: the allowance runs out, the machine
// sleeps, a sandbox dies. What it leaves is a branch, maybe a worktree with
// uncommitted edits, and no record of how far it got. This module turns that into
// something the next run can act on without redoing the work or merging it early:
//
//   - preserveWip     commits a worktree's uncommitted edits on the ticket branch
//   - syncWithBase    brings the branch up to the project checkout's branch
//   - stage markers   say whether the implementer and the reviewer each finished
//
// A stage marker is a ref, `refs/sandcastle/<stage>/<branch>`, set to the branch
// tip the stage finished on. It counts only while it still equals the tip: a later
// commit, WIP or otherwise, means the work moved on since that stage signed off.
// Refs live in the project's own git, so they survive the run, are visible to every
// worktree, and are never pushed by a plain `git push`.

import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  commitsAhead,
  git,
  identityArgs,
  isAncestor,
  mergeInProgress,
  revParse,
  unmergedPaths,
} from "./git.mjs";

export const STAGES = ["implemented", "reviewed"];

// Writes files into a worktree exactly as git stores them, LF for this code.
//
// The host is Windows with `core.autocrlf=true`, so a plain checkout writes CRLF.
// The sandbox's git, on Linux, has no such setting and reports every one of those
// files as modified: an implementer then resets them by hand, and tests fail only
// from CRLF. `verify.sh` takes its changed files from git, so it also checked all of
// them. Only the commands that write files into a worktree take this setting.
export const AS_STORED = ["-c", "core.autocrlf=false"];

/** Where sandcastle puts a branch's worktree, so it reuses one made here. */
export function managedWorktreePath(repo, branch) {
  return join(resolve(repo), ".sandcastle", "worktrees", branch.replace(/\//g, "-"));
}

/** The path of the worktree that has `branch` checked out, or null. */
export function findWorktree(repo, branch) {
  const listing = git(repo, ["worktree", "list", "--porcelain"]).stdout;
  for (const block of listing.split(/\r?\n\r?\n/)) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    const ref = block.match(/^branch (.+)$/m)?.[1];
    if (path && ref === `refs/heads/${branch}` && existsSync(path)) return path;
  }
  return null;
}

/**
 * The worktree for `branch`, made at sandcastle's own path when there is none.
 *
 * Made here rather than left to sandcastle so the WIP commit and the base sync
 * below have a checkout to work in before the sandbox starts. Sandcastle finds it
 * at its managed path and reuses it. A missing branch is cut from `base`, which is
 * what sandcastle would have cut it from.
 */
export function ensureWorktree(repo, branch, base) {
  const existing = findWorktree(repo, branch);
  if (existing) return { path: existing, created: false };

  // A registration whose directory is gone would make `worktree add` refuse.
  git(repo, ["worktree", "prune"]);
  const path = managedWorktreePath(repo, branch);
  const args = revParse(repo, `refs/heads/${branch}`)
    ? ["worktree", "add", path, branch]
    : ["worktree", "add", "-b", branch, path, base];
  git(repo, [...AS_STORED, ...args]);
  return { path, created: true };
}

/**
 * Rewrites, as git stores them, the files of a worktree that differ from their
 * committed copy in line endings alone, and returns them. A worktree made before
 * AS_STORED existed holds CRLF copies the sandbox reads as changes. A file with a
 * real change is never touched, whatever its line endings.
 */
export function restoreStoredLineEndings(worktree) {
  // Found by content, not by `git diff`. A file checked out as CRLF on the host
  // keeps the size and time git recorded, so the host's diff trusts its cache and
  // never reads it, so a diff finds none of the CRLF copies that the sandbox, with
  // other file stats, reads as changed. `ls-files --eol`
  // reads every file. Entries: "i/lf    w/crlf  attr/<attrs>\t<path>\0".
  const crlfCopies = [];
  for (const entry of git(worktree, [...AS_STORED, "ls-files", "--eol", "-z"]).stdout.split("\0")) {
    const match = entry.match(/^i\/lf\s+w\/(?:crlf|mixed)\s+attr\/([^\t]*)\t(.+)$/s);
    // A file whose attributes ask for CRLF in the worktree is as intended.
    if (match && !/eol=crlf/.test(match[1])) crlfCopies.push(match[2]);
  }
  if (crlfCopies.length === 0) return [];

  // A copy with a real change is never touched. The prepare step commits real
  // edits as WIP first, so this only guards a caller that did not. Lines changed
  // once CR is ignored, from `--numstat -z`: "<added>\t<deleted>\t<path>\0".
  const realChanges = new Set();
  const numstat = git(worktree, [...AS_STORED, "diff", "--numstat", "-z", "--ignore-cr-at-eol"]).stdout;
  for (const entry of numstat.split("\0")) {
    const match = entry.match(/^(\d+|-)\t(\d+|-)\t(.+)$/s);
    if (match && !(match[1] === "0" && match[2] === "0")) realChanges.add(match[3]);
  }
  const endingsOnly = crlfCopies.filter((file) => !realChanges.has(file));
  if (endingsOnly.length > 0) {
    // Deleted first: git skips writing a file its cache calls unchanged, even
    // with `-f` (git 2.39 and 2.52 alike), and `-u` updates that cache, or git
    // goes on reporting the file as changed. Each copy holds nothing the committed
    // file lacks, so git writes it straight back. Paths go on stdin:
    // a large repo has thousands, past a Windows command line's length.
    for (const file of endingsOnly) rmSync(join(worktree, file), { force: true });
    git(worktree, [...AS_STORED, "checkout-index", "-f", "-u", "-z", "--stdin"], {
      input: endingsOnly.join("\0"),
    });
  }
  return endingsOnly;
}

/**
 * Puts back each `package-lock.json` changed while its `package.json` was not,
 * and returns them. The sandbox's `npm install`, on Linux, can rewrite a lockfile
 * made on another platform with no dependency changed, and a WIP commit then
 * carried that noise into the ticket's diff. A lockfile that changed with its
 * manifest is a real dependency change, and stays.
 */
export function restoreUnrequestedLockfiles(worktree) {
  const changed = git(worktree, ["diff", "--name-only", "HEAD"]).stdout.split(/\r?\n/).filter(Boolean);
  const set = new Set(changed);
  const noise = changed.filter(
    (file) => /(^|\/)package-lock\.json$/.test(file) && !set.has(file.replace(/package-lock\.json$/, "package.json")),
  );
  if (noise.length > 0) git(worktree, [...AS_STORED, "checkout", "HEAD", "--", ...noise]);
  return noise;
}

/**
 * Commits a worktree's uncommitted edits as a WIP commit on its branch, and
 * returns the commit, or null when there was nothing to save.
 *
 * Everything in a ticket worktree is the ticket's own work, so it is staged as a
 * whole, minus env files: a credential an agent wrote must not reach a commit.
 * `node_modules` and the rest of the ignore rules apply as usual. Not a stash: one
 * stash is shared by every worktree of the repo, and the runner has several at once.
 */
export function preserveWip(worktree, message) {
  if (mergeInProgress(worktree)) {
    // A half-done merge cannot be committed as WIP without committing its
    // conflict markers. Leave it for a human; say so instead of guessing.
    throw new Error(`${worktree} has a merge in progress; resolve or abort it first`);
  }
  restoreUnrequestedLockfiles(worktree);
  if (!git(worktree, ["status", "--porcelain"]).stdout) return null;

  git(worktree, [
    "add",
    "--all",
    "--",
    ".",
    ":(exclude,glob)**/.env",
    ":(exclude,glob)**/.env.*",
    ":(exclude,glob)**/*.env",
  ]);
  if (git(worktree, ["diff", "--cached", "--quiet"], { allowFail: true }).code === 0) {
    return null;
  }
  git(worktree, [...identityArgs(worktree), "commit", "--no-verify", "-m", message]);
  return revParse(worktree, "HEAD");
}

/**
 * Brings the worktree's branch up to `base`:
 *
 *   up-to-date      base is already in the branch
 *   fast-forwarded  the branch had nothing of its own
 *   merged          base was merged in cleanly
 *   conflict        merging base conflicts; the merge is aborted and `files`
 *                   lists the conflicts, so the branch is exactly as it was
 *
 * Never a rebase or a reset: the branch keeps every commit it had.
 */
export function syncWithBase(worktree, base) {
  if (isAncestor(worktree, base, "HEAD")) return { status: "up-to-date" };
  if (isAncestor(worktree, "HEAD", base)) {
    git(worktree, [...AS_STORED, "merge", "--ff-only", base]);
    return { status: "fast-forwarded" };
  }

  const merge = git(
    worktree,
    [...AS_STORED, ...identityArgs(worktree), "merge", "--no-edit", "--no-verify", base],
    { allowFail: true },
  );
  if (merge.code === 0) return { status: "merged" };

  const files = unmergedPaths(worktree);
  if (mergeInProgress(worktree)) git(worktree, [...AS_STORED, "merge", "--abort"]);
  if (files.length > 0) return { status: "conflict", files };
  throw new Error(`merging ${base} into ${worktree} failed: ${merge.stderr || merge.stdout}`);
}

const stageRef = (stage, branch) => `refs/sandcastle/${stage}/${branch}`;

/** Records that `stage` finished on the branch's current tip. */
export function markStage(repo, stage, branch) {
  const tip = revParse(repo, `refs/heads/${branch}`);
  if (!tip) throw new Error(`cannot mark ${branch} ${stage}: the branch does not exist`);
  git(repo, ["update-ref", stageRef(stage, branch), tip]);
}

/**
 * How far the ticket on `branch` got, by its stage markers:
 *
 *   new          no branch yet
 *   in-progress  a branch, but the implementer has not signed off on its tip
 *   implemented  the implementer signed off on the tip; the reviewer has not
 *   reviewed     the reviewer signed off on the tip; ready to merge
 */
export function stageOf(repo, branch) {
  const tip = revParse(repo, `refs/heads/${branch}`);
  if (!tip) return "new";
  if (revParse(repo, stageRef("reviewed", branch)) === tip) return "reviewed";
  if (revParse(repo, stageRef("implemented", branch)) === tip) return "implemented";
  return "in-progress";
}

/** Deletes a branch's stage markers, as `clean.mjs` does with the branch. */
export function clearStages(repo, branch) {
  for (const stage of STAGES) {
    git(repo, ["update-ref", "-d", stageRef(stage, branch)], { allowFail: true });
  }
}

/**
 * The short account of a branch's progress the implementer is given: its own
 * commits beyond the base, and what is uncommitted. A resumed ticket starts from
 * this rather than from the project's unrelated history.
 */
export function branchProgress(worktree, base, { maxCommits = 30 } = {}) {
  const ahead = commitsAhead(worktree, base, "HEAD");
  if (ahead === 0) {
    return `No commits on this branch yet beyond \`${base}\`: this is a fresh start.`;
  }
  const log = git(worktree, [
    "log",
    `--max-count=${maxCommits}`,
    "--format=- %h %s",
    `${base}..HEAD`,
  ]).stdout;
  const more = ahead > maxCommits ? `\n- … and ${ahead - maxCommits} older commit(s)` : "";
  const status = git(worktree, ["status", "--short"]).stdout;
  return [
    `This branch already has ${ahead} commit(s) beyond \`${base}\` from an earlier run.`,
    "Resume from them: read what they did before you change anything, and do not redo it.",
    "",
    log + more,
    "",
    status ? `Uncommitted:\n${status}` : "Nothing uncommitted.",
  ].join("\n");
}
