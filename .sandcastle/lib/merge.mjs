// Merging a finished ticket branch into its project's checkout, with git alone.
//
// A clean merge needs no model, so this is the whole merge phase for most tickets.
// Only a conflict goes to an agent, and not here: main.mts hands it to a sandbox on
// the ticket's own branch, which merges the base in and resolves it there. The
// checkout is never left mid-merge, and no sandbox ever runs `npm install` against
// it, which is how the old merger left Linux-only binaries in its node_modules.

import { git, identityArgs, isAncestor, mergeInProgress, revParse, unmergedPaths } from "./git.mjs";

/**
 * Merges `branch` into the branch checked out at `repo`:
 *
 *   already-merged  the checkout already has every commit of the branch
 *   merged          merged now; `head` is the new tip
 *   conflict        it conflicts; the merge this call started is aborted, and
 *                   `files` lists the conflicts
 *   error           git refused for another reason (a missing branch, a dirty
 *                   file in the way, a merge someone else left in progress);
 *                   nothing was changed, and `detail` says why
 */
export function mergeIntoCheckout(repo, branch) {
  if (!revParse(repo, `refs/heads/${branch}`)) {
    return { status: "error", detail: `branch ${branch} does not exist` };
  }
  if (isAncestor(repo, branch, "HEAD")) return { status: "already-merged" };
  if (mergeInProgress(repo)) {
    // Not ours to abort: someone, or something, is in the middle of it.
    return { status: "error", detail: `a merge is already in progress in ${repo}` };
  }

  const merge = git(repo, [...identityArgs(repo), "merge", "--no-edit", branch], {
    allowFail: true,
  });
  if (merge.code === 0) return { status: "merged", head: revParse(repo, "HEAD") };

  const files = unmergedPaths(repo);
  if (files.length > 0 && mergeInProgress(repo)) {
    git(repo, ["merge", "--abort"]);
    return { status: "conflict", files };
  }
  return { status: "error", detail: merge.stderr || merge.stdout };
}
