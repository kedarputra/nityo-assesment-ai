// What the reviewer is shown of a branch: a bounded diff of the source it changed.
//
// The reviewer used to get `git diff <base>...<branch>` whole. A branch that
// regenerates an API client or a migration snapshot puts tens of thousands of
// lines in front of it that no one reviews by eye, and a branch cut from the
// wrong base handed one reviewer ~676k tokens (2026-10-22). So the diff leaves out
// lockfiles, generated code and migration snapshots, the file list still names
// them, and a diff past the limit is cut with a note saying so and naming what
// was cut.

import { git } from "./git.mjs";

// Left out of the diff, never out of the file list. `_journal.json` stays in: a
// migration's journal entry is small and is where a numbering clash shows.
export const NOT_REVIEWED_INLINE = [
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/drizzle/**/meta/*_snapshot.json",
  "**/src/api/**",
  "**/*.snap",
];

const excludes = NOT_REVIEWED_INLINE.map((glob) => `:(exclude,glob)${glob}`);

export function reviewDiff(worktree, base, { limitBytes = 200_000 } = {}) {
  const range = `${base}...HEAD`;
  const commits = git(worktree, ["log", "--format=- %h %s", `${base}..HEAD`]).stdout;
  const summary = git(worktree, ["diff", "--stat=120", range]).stdout;
  const full = git(worktree, ["diff", range, "--", ".", ...excludes]).stdout;

  if (full.length <= limitBytes) {
    return {
      commits: commits || "(none)",
      summary: summary || "(no changes)",
      diff: full,
      note: "The diff below is complete for every file it covers.",
    };
  }

  // Cut on a file boundary, so no file is shown half.
  const cut = full.lastIndexOf("\ndiff --git ", limitBytes);
  const shown = cut > 0 ? full.slice(0, cut) : full.slice(0, limitBytes);
  const rest = [...full.slice(shown.length).matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]);
  return {
    commits: commits || "(none)",
    summary,
    diff: shown,
    note:
      `The diff below is cut at ${shown.length} of ${full.length} bytes. Read the rest, one file ` +
      `at a time, with \`git diff ${range} -- <path>\`: ${rest.join(", ")}.`,
  };
}
