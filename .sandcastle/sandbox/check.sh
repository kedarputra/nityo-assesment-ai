# The one helper verify.sh and full-check.sh share, sourced by both:
#
#   logs=/tmp/<dir>; failed=0; source "$(dirname "$0")/check.sh"
#   check <name> <command> [args...]
#
# Runs the command with its whole output in $logs/<name>.log, and prints one line,
# or the log's tail when it fails. A failure sets `failed=1`; the caller exits with
# it, so the exit status is the checks' own, not a pipeline's.

check() {
  local name=$1
  shift
  local log="$logs/$name.log"
  local start=$SECONDS
  "$@" >"$log" 2>&1
  local code=$?
  local took=$((SECONDS - start))
  if [ "$code" -eq 0 ]; then
    echo "PASS $name (${took}s)"
  else
    echo "FAIL $name (exit $code, ${took}s); last 60 lines of $log:"
    tail -n 60 "$log"
    failed=1
  fi
}

# `bash -n` on each file given. Not `bash -n "$@"`: bash reads only the first
# file and takes the rest as its arguments, so a broken second script passed.
bash_syntax() {
  local file code=0
  for file in "$@"; do
    bash -n "$file" || code=1
  done
  return "$code"
}
