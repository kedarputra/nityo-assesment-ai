// Putting a checkout on its effort's branch, and getting a run's commits to origin.
//
// Sandcastle cuts a ticket branch from the project checkout and merges it back
// into that checkout, so the checkout's branch is where a run's work lands. On
// `main` nothing may land (AGENTS.md, "Branches"), and lib/selection.mjs holds the
// ticket. Rather than wait for someone to switch it, the runner moves a checkout
// on `main`, or on a detached HEAD, to the effort's branch itself: `feat/<effort>`
// in a project, `docs/<effort>` at the workspace root, where `tracker close`
// commits. A checkout on any other branch stays where the developer put it.
//
// A run's work is also pushed, so the developer can go on from another machine:
// each checkout's branch, and each ticket branch with commits the checkout has
// not merged. Never `main` or a tag, since those start a workflow.

import { commitsAhead, currentBranch, git, isAncestor, revParse } from "./git.mjs";

/** Whether the runner moves a checkout on `branch` (null: a detached HEAD). */
export function needsEffortBranch(branch) {
  return branch === null || branch === "main" || branch === "master";
}

/**
 * Branches a run never pushes. A push to one starts a workflow in the project
 * repo: the production deploy on `main` (Vercel's Git integration), and CI. A
 * tag can start a release workflow, so no tag is pushed
 * either. A run pushes only so its work can be taken up on another machine.
 */
export const NEVER_PUSHED = new Set(["main", "master"]);

/** Fetches origin. Returns null, or why it failed. */
export function fetchOrigin(repo) {
  const result = git(repo, ["fetch", "--quiet", "origin"], { allowFail: true });
  return result.code === 0 ? null : result.stderr || `git fetch exited ${result.code}`;
}

/**
 * How a checkout reaches its effort's branch, `<prefix>/<effort>`, or why it
 * cannot. Changes nothing, and reads origin's refs as last fetched:
 *
 *   { move: { from, to, source } }  source is where `to` comes from: the local
 *                                   branch, origin's (pushed from another
 *                                   machine), or a new one cut from origin/main
 *   { hold: reason }                the checkout stays where it is
 */
export function planEffortBranch(repo, efforts, prefix) {
  const from = currentBranch(repo) ?? "a detached HEAD";
  if (efforts.length !== 1) {
    return {
      hold:
        `is on ${from}, and its tickets come from ${efforts.length} efforts ` +
        `(${efforts.join(", ")}); run with --map <effort>`,
    };
  }
  // Tracked files only. A switch carries uncommitted changes onto the effort
  // branch, where the next merge into the checkout can take them along.
  if (git(repo, ["status", "--porcelain", "--untracked-files=no"]).stdout) {
    return {
      hold: `is on ${from} with uncommitted changes; commit or stash them, or switch it yourself`,
    };
  }

  const to = `${prefix}/${efforts[0]}`;
  if (revParse(repo, `refs/heads/${to}`)) return { move: { from, to, source: "local" } };
  if (revParse(repo, `refs/remotes/origin/${to}`)) return { move: { from, to, source: "origin" } };
  if (!revParse(repo, "refs/remotes/origin/main")) {
    return { hold: `is on ${from}, and has no origin/main to cut ${to} from` };
  }
  // A new branch from origin/main leaves behind what only the local `main` holds.
  // At the workspace root that can be the tickets themselves.
  const unpushed = commitsAhead(repo, "origin/main", "HEAD");
  if (unpushed > 0) {
    return {
      hold:
        `is on ${from} with ${unpushed} commit(s) origin/main does not have, which a new ` +
        `${to} would leave behind; push them through a PR, or switch it yourself`,
    };
  }
  return { move: { from, to, source: "new" } };
}

/** Switches the checkout as `planEffortBranch` decided. */
export function moveToEffortBranch(repo, { to, source }) {
  if (source === "new") {
    // --no-track: the new branch has no upstream until its first push, so a bare
    // `git push` can never reach origin/main from it.
    git(repo, ["switch", "--quiet", "--no-track", "-c", to, "origin/main"]);
  } else if (source === "origin") {
    git(repo, ["switch", "--quiet", "--track", "-c", to, `origin/${to}`]);
  } else {
    git(repo, ["switch", "--quiet", to]);
  }
}

/**
 * Fast-forwards the checkout's branch to origin's copy of it, when another
 * machine pushed to it since this one last did. Without it, the run builds on
 * the old copy and origin refuses its push. The checkout stays on its branch.
 *
 *   no-remote | up-to-date | caught-up | diverged (left as it is)
 */
export function catchUpWithOrigin(repo) {
  const branch = currentBranch(repo);
  if (!branch || !revParse(repo, `refs/remotes/origin/${branch}`)) return "no-remote";
  if (isAncestor(repo, `origin/${branch}`, "HEAD")) return "up-to-date";
  const merge = git(repo, ["merge", "--ff-only", "--quiet", `origin/${branch}`], {
    allowFail: true,
  });
  return merge.code === 0 ? "caught-up" : "diverged";
}

/**
 * Takes up a ticket branch another machine pushed, before its worktree is made
 * or reused: the branch is created from origin's when this machine has none, and
 * fast-forwarded when it is behind. The implementer then goes on from that work.
 *
 *   no-remote | up-to-date | created | caught-up | diverged (left as it is)
 *
 * `worktree` is the branch's worktree, if it has one: a checked-out branch moves
 * only through it, and only while it is clean. A dirty one is saved as WIP next,
 * and its push reports the divergence.
 */
export function takeUpTicketBranch(repo, branch, worktree) {
  const remote = `origin/${branch}`;
  if (!revParse(repo, `refs/remotes/${remote}`)) return "no-remote";
  if (!revParse(repo, `refs/heads/${branch}`)) {
    git(repo, ["branch", "--quiet", "--track", branch, remote]);
    return "created";
  }
  if (isAncestor(repo, remote, branch)) return "up-to-date";
  if (!isAncestor(repo, branch, remote)) return "diverged";

  if (worktree) {
    if (git(worktree, ["status", "--porcelain"]).stdout) return "diverged";
    git(worktree, ["merge", "--ff-only", "--quiet", remote]);
  } else {
    git(repo, ["branch", "--force", branch, remote]);
  }
  return "caught-up";
}

/**
 * Pushes `branch` to origin and makes it the upstream. Never forced, and never a
 * tag, even where `push.followTags` is set.
 *
 *   { status: "pushed" }
 *   { status: "never", detail }     a branch in NEVER_PUSHED, or no branch at all
 *   { status: "refused", detail }   origin refused it, e.g. it has diverged
 */
export function pushBranch(repo, branch) {
  if (!branch || NEVER_PUSHED.has(branch)) {
    return { status: "never", detail: `${branch ?? "a detached HEAD"} is never pushed` };
  }
  const result = git(
    repo,
    ["push", "--quiet", "--no-follow-tags", "--set-upstream", "origin", branch],
    { allowFail: true },
  );
  return result.code === 0
    ? { status: "pushed" }
    : { status: "refused", detail: result.stderr || `git push exited ${result.code}` };
}
