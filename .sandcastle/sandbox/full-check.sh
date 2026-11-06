#!/usr/bin/env bash
# The full check of a project's checkout, once a round has merged tickets into it.
#
#   bash ../.sandcastle-tools/full-check.sh <project>
#
# `make check` in the root Makefile, which CI runs too, so a green check here is a
# green CI on the effort's PR. Sandcastle merges into the effort's branch and opens
# no PR: without this, nothing ran the full suite or the build between a ticket's
# merge and the effort's PR, and two tickets that each passed verify.sh could
# break each other unseen while later tickets built on the break.
#
# main.mts runs it in a sandbox on `sandcastle/check-<base>`, a runner-owned branch
# set to the checkout's HEAD, and the fixer runs it again after a fix. Each check's
# whole output is in /tmp/sandcastle-full-check/.

set -u

project=${1:?usage: full-check.sh <project>}
logs=/tmp/sandcastle-full-check
mkdir -p "$logs"
failed=0
# shellcheck source=check.sh
source "$(dirname "$0")/check.sh"

case "$project" in
  harbor-point)
    check make-check make check
    ;;
  *)
    echo "full-check: unknown project $project"
    exit 2
    ;;
esac

exit "$failed"
