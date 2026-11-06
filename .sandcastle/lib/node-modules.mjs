// Whether a worktree's node_modules is whole, or only what a stopped copy left.
//
// Sandcastle copies the host's node_modules into a new worktree with `cp -R`,
// straight into `<worktree>/node_modules`, and then runs `npm install` in the
// sandbox. A run that stops in the middle (a crash, a reboot, Ctrl-C) leaves the
// folder half made, say 216 of 776 packages. The runner used to skip the copy whenever
// the folder existed, so the next run would have used the half copy.
//
// So the folder counts only with a marker that the runner writes after the
// sandbox is set up, which is after both the copy and `npm install`. The marker
// lives in the worktree's own git directory, so it is never a file in the tree
// an agent could commit, and it goes away with the worktree.
//
// A worktree made before the marker existed has no marker, so its node_modules
// is copied again once.

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.mjs";

const MARKER = "sandcastle-node-modules-ready";

const markerPath = (worktree) =>
  join(git(worktree, ["rev-parse", "--absolute-git-dir"]).stdout, MARKER);

/**
 * Gets the worktree ready for its sandbox's copy of node_modules. Returns
 * `{ copy, removed }`: `copy` is true when sandcastle must copy node_modules in,
 * and `removed` is true when a folder without the marker was deleted first.
 */
export function prepareNodeModules(worktree) {
  const folder = join(worktree, "node_modules");
  if (!existsSync(folder)) return { copy: true, removed: false };
  if (existsSync(markerPath(worktree))) return { copy: false, removed: false };
  // `cp -R` copies into a folder that exists, so a half copy must go first.
  rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  return { copy: true, removed: true };
}

/** Records that the worktree's sandbox setup, the copy and `npm install`, finished. */
export function markNodeModulesReady(worktree) {
  writeFileSync(markerPath(worktree), `${new Date().toISOString()}\n`);
}
