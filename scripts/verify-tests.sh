#!/usr/bin/env bash
# The tests for one change, called by `make verify`. <file> lists the changed paths, one per line.
#
#   only files under src/      the tests that import them (vitest related)
#   only Markdown docs         no tests (DESIGN.md excepted: a test checks its tokens)
#   anything else              every test: config, migrations or dependencies reach them all
set -euo pipefail

changed_list=${1:?usage: verify-tests.sh <file listing the changed paths>}
mapfile -t changed < <(grep -v '^[[:space:]]*$' "$changed_list" || true)

if [ "${#changed[@]}" -eq 0 ]; then
  echo "verify-tests: no changed files, so no tests to run"
  exit 0
fi

source_files=()
other_files=()
for file in "${changed[@]}"; do
  case "$file" in
    src/*) source_files+=("$file") ;;
    DESIGN.md) other_files+=("$file") ;;
    *.md) ;;
    *) other_files+=("$file") ;;
  esac
done

if [ "${#other_files[@]}" -gt 0 ]; then
  echo "verify-tests: ${other_files[*]} changed, so every test runs"
  exec npx vitest run
fi

if [ "${#source_files[@]}" -gt 0 ]; then
  exec npx vitest related --run --passWithNoTests "${source_files[@]}"
fi

echo "verify-tests: only docs changed, so no tests to run"
