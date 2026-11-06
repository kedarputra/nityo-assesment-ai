// The full check's state, the branch it runs on, and what a fixer leaves there.
//
// The full check (sandbox/full-check.sh) runs CI's own steps on a project's
// checkout. Two refs per checkout branch say where it stands, so a run never
// checks the same commit twice and a stopped run picks up where it stopped:
//
//   refs/sandcastle/checked/<base>        the last commit that passed
//   refs/sandcastle/check-pending/<base>  a commit the runner's own merges made,
//                                         not yet passed: set at the merge,
//                                         cleared when it passes, or when a
//                                         fixer's whole turn could not fix it
//
// A tip that is neither was moved by someone else (a developer, another
// machine), or has never been checked. Like the stage markers, the refs live in
// the project's own git, survive the run, and are never pushed.
//
// A tip that is origin/main's own tip, as a branch fresh cut from origin/main
// is, needs no check: CI ran these same steps on it when it was pushed to main.
//
// A sandbox needs a branch of its own, and the checkout's branch is already
// checked out there, so the check runs on `sandcastle/check-<base>`, set to the
// checkout's HEAD. When the check is red, the fixer commits on that branch, and a
// green fix is merged into the checkout. What a fixer left there unmerged is never
// reset away: it is kept as `sandcastle/fix-attempt-<base>-<sha>`, and the run
// pushes it, or the next fixer on the same tip goes on from it.

import { AS_STORED, ensureWorktree } from "./branch-state.mjs";
import { commitsAhead, git, isAncestor, mergeInProgress, revParse } from "./git.mjs";

const dashed = (base) => base.replace(/\//g, "-");
const checkedRef = (base) => `refs/sandcastle/checked/${base}`;
const pendingRef = (base) => `refs/sandcastle/check-pending/${base}`;

/** The check branch for the checkout on `base`. */
export const checkBranchFor = (base) => `sandcastle/check-${dashed(base)}`;

/**
 * Where `base`'s tip stands:
 *
 *   passed     the full check passed on it; nothing to run
 *   pending    the runner's own merges made it; check it, and fix it when red
 *   main       it is origin/main's tip, as a fresh cut is; CI on main checked
 *              it, so nothing to run
 *   unchecked  someone else moved it, or it was never checked; check it, and
 *              when red, leave it to a human: no ticket of a run caused it
 */
export function checkState(repo, base) {
  const tip = revParse(repo, `refs/heads/${base}`);
  if (tip && revParse(repo, checkedRef(base)) === tip) return "passed";
  if (tip && revParse(repo, pendingRef(base)) === tip) return "pending";
  if (tip && revParse(repo, "refs/remotes/origin/main") === tip) return "main";
  return "unchecked";
}

/** Records that the runner's merges moved `base` and its new tip awaits the check. */
export function markCheckPending(repo, base) {
  git(repo, ["update-ref", pendingRef(base), revParse(repo, `refs/heads/${base}`)]);
}

/** Records that the full check passed on `base`'s tip. */
export function markCheckPassed(repo, base) {
  git(repo, ["update-ref", checkedRef(base), revParse(repo, `refs/heads/${base}`)]);
  git(repo, ["update-ref", "-d", pendingRef(base)], { allowFail: true });
}

/**
 * Forgets that the runner made `base`'s tip, so it reads as unchecked: a red
 * that a whole fixer turn could not fix is a human's, and the next run must hold
 * the project's tickets rather than send another fixer.
 */
export function clearCheckPending(repo, base) {
  git(repo, ["update-ref", "-d", pendingRef(base)], { allowFail: true });
}

/**
 * What `base` gained since its last passed check, one line per first-parent
 * commit, so each ticket's merge is one line. The fixer starts from this.
 */
export function changesSinceCheck(repo, base, { max = 30 } = {}) {
  const passed = revParse(repo, checkedRef(base));
  const range = passed && isAncestor(repo, passed, base) ? `${passed}..${base}` : base;
  const log = git(repo, ["log", "--first-parent", `--max-count=${max}`, "--format=- %h %s", range])
    .stdout;
  const since = passed ? `since ${passed.slice(0, 8)}, the last commit that passed` : "(no commit has passed yet; the latest commits)";
  return `${since}:\n${log || "(none)"}`;
}

/**
 * Keeps the check branch's commits that `base` does not have as a branch of
 * their own, and returns its name, or null when there were none. Uncommitted
 * edits are not kept: the fixer is told to commit, and `npm install` in the
 * sandbox can leave a rewritten lockfile that is no one's work.
 */
export function keepFixAttempt(repo, base) {
  const branch = checkBranchFor(base);
  const tip = revParse(repo, `refs/heads/${branch}`);
  if (!tip || commitsAhead(repo, base, branch) === 0) return null;
  const attempt = `sandcastle/fix-attempt-${dashed(base)}-${tip.slice(0, 8)}`;
  if (!revParse(repo, `refs/heads/${attempt}`)) git(repo, ["branch", attempt, tip]);
  return attempt;
}

/**
 * The check branch's worktree, with nothing uncommitted and nothing untracked
 * but what the ignore rules keep (node_modules), at the checkout's HEAD.
 *
 * With `resume`, a fixer's commits made on top of that same HEAD are kept and the
 * branch stays at them, so a fixer a run stopped (allowance spent, network down)
 * goes on from its own work: `resumed` is then true. Otherwise any commits of an
 * earlier fixer are kept on a branch of their own, named in `attempt`, and the
 * check branch goes back to the HEAD.
 */
export function prepareCheckBranch(repo, base, { resume = false } = {}) {
  const branch = checkBranchFor(base);
  const { path: worktree } = ensureWorktree(repo, branch, base);
  // A fixer stopped mid-merge; the merge was never committed, so nothing is lost.
  if (mergeInProgress(worktree)) git(worktree, ["merge", "--abort"]);

  const onTop = isAncestor(repo, base, branch) && commitsAhead(repo, base, branch) > 0;
  let attempt = null;
  let target = revParse(repo, base);
  if (resume && onTop) {
    target = revParse(repo, `refs/heads/${branch}`);
  } else {
    attempt = keepFixAttempt(repo, base);
  }
  git(worktree, [...AS_STORED, "reset", "--quiet", "--hard", target]);
  git(worktree, ["clean", "--quiet", "-d", "--force"]);
  return { branch, worktree, attempt, resumed: resume && onTop };
}
