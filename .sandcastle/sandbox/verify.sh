#!/usr/bin/env bash
# The verify gate a sandbox runs before it commits: the checks for what changed.
#
#   bash ../.sandcastle-tools/verify.sh <project> <base>
#
# Mounted read-only into every ticket sandbox by main.mts. It checks the change
# against <base>, the branch the ticket merges into, and only that. What "the
# checks" are is the repository's own call, made in the root Makefile:
#
#   make verify BASE=<base> CHANGED=<file>
#
# where <file> lists the changed paths, one per line, without the tooling and
# notes this repository also holds (.sandcastle/, grilled/, .agents/, .claude/).
# The full suite and the build belong to `make check`, which full-check.sh runs
# on the checkout once a round's tickets are merged into it.
#
# Each check writes its whole output to /tmp/sandcastle-verify/<check>.log and
# prints one line, or the log's tail when it fails. The exit status is non-zero
# when any check failed, and it is the checks' own status, not a pipeline's.
#
# VERIFY_LIST_ONLY=1 prints the changed files `make verify` would get, and runs nothing.
#
# Each run records its result in /tmp/sandcastle-verify/result: the content of
# the working tree it checked, as a tree hash, and its exit status. The host runs
# this script itself after an agent says it is done, with VERIFY_REUSE=1: when
# the tree still has the content of a run that passed, it says so and runs
# nothing again. An agent checks, then commits, so the commit's tree is the tree
# it checked. The file lives in the sandbox's /tmp, so it ends with the sandbox,
# and a resumed ticket's first host check runs the checks again.

set -u

project=${1:?usage: verify.sh <project> <base>}
base=${2:?usage: verify.sh <project> <base>}
logs=/tmp/sandcastle-verify
mkdir -p "$logs"

fork=$(git merge-base "$base" HEAD) || {
  echo "verify: no merge base between $base and HEAD"
  exit 2
}

# The working tree's content, committed or not, untracked files included and
# ignored ones left out, without touching the real index.
tree_of_worktree() {
  local index
  index=$(mktemp -u)
  GIT_INDEX_FILE=$index git read-tree HEAD &&
    GIT_INDEX_FILE=$index git add --all &&
    GIT_INDEX_FILE=$index git write-tree
  rm -f "$index"
}
tree=$(tree_of_worktree)
result=$logs/result
if [ "${VERIFY_REUSE:-}" = 1 ] && [ -n "$tree" ] && [ "$(cat "$result" 2>/dev/null)" = "$tree 0" ]; then
  echo "PASS (these checks already passed on this exact content, tree $tree; not run again)"
  exit 0
fi

# Changed against the fork point: committed, staged, unstaged, and new files.
mapfile -t changed < <(
  {
    git diff --name-only --diff-filter=d "$fork"
    git ls-files --others --exclude-standard
  } | sort -u
)

failed=0
# shellcheck source=check.sh
source "$(dirname "$0")/check.sh"

# Changed against the fork point: committed, staged, unstaged, and new files,
# without the repository's tooling and notes, which no app check covers.
mapfile -t changed < <(
  {
    git diff --name-only --diff-filter=d "$fork"
    git ls-files --others --exclude-standard
  } | sort -u | grep -vE '^(\.sandcastle|grilled|\.agents|\.claude)/' || true
)

case "$project" in
  harbor-point)
    if [ "${VERIFY_LIST_ONLY:-}" = 1 ]; then printf '%s\n' "${changed[@]}"; exit 0; fi
    if [ "${#changed[@]}" -gt 0 ]; then
      list=$logs/changed.txt
      printf '%s\n' "${changed[@]}" >"$list"
      check make-verify make verify BASE="$base" CHANGED="$list"
    else
      echo "SKIP make-verify (no file outside the tooling and notes changed)"
    fi
    not_run="make check, the full suite and the build (the full check runs it after the merge)"
    ;;
  *)
    echo "verify: unknown project $project"
    exit 2
    ;;
esac

echo "Not run here: $not_run."
[ -n "$tree" ] && echo "$tree $failed" >"$result"
exit "$failed"
