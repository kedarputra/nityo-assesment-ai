# TASK

The full check of `{{BASE}}` in `{{PROJECT}}` is red. Make it green.

`{{BASE}}` is the effort's branch. Sandcastle merged tickets into it, each after it passed its
own checks on its own branch. After those merges, the full check — the same steps as this
repository's CI — failed. What `{{BASE}}` gained {{CHANGES}}

A merge line names its ticket branch, `sandcastle/issue-<id>`; the ticket's file is under
`../grilled/`, which is mounted read-only.

You are on `{{BRANCH}}`, a worktree of `{{PROJECT}}` at the tip of `{{BASE}}`. If it already has
commits beyond that tip, an earlier fixer made them and was stopped: read them, and go on from
them. Your commits here are merged into `{{BASE}}` once the check is green.

## What failed

```text
{{FAILURES}}
```

Each check's whole output is in `/tmp/sandcastle-full-check/<check>.log`. "TIMED OUT" means
the check ran past its time limit and was stopped: look for a test or a build step that hangs.

# HOW TO FIX IT

1. Find the cause before you change anything. Read the failing log, then `git show` the merges
   listed above. A red check here is most often two tickets that each passed alone and break
   each other, or a change that broke a test or an importer in another folder.
2. Fix the cause in the code, the smallest change that keeps the intent of every ticket.
3. A test fails because a ticket changed the behaviour it checks on purpose: update the test to
   the new behaviour, and say which ticket in the commit message. Never skip, delete or loosen
   a test only to make it pass, and never switch a check off.

This repository's root `CLAUDE.md` is already loaded as your instructions. Read a `CLAUDE.md`
or `AGENTS.md` in a directory you change. The shared standards for every project here:

<coding-standards>

{{CODING_STANDARDS}}

</coding-standards>

**Never run `git worktree` or `git stash`**, and never `git rebase` or `git reset`. This
checkout's git metadata is shared with the host and with other sandboxes: `git worktree prune`
deletes checkouts it cannot see, and a `git stash pop` can apply another sandbox's changes.

# FEEDBACK LOOP

While you work, run single test files and single steps directly. Before your final commit,
run the full check, in the foreground, and make it pass. Its exit status is the result, so do
not pipe it through `tail` or `grep`:

```sh
{{FULL_CHECK_COMMAND}}
```

The host runs it again after you finish, and merges your commits only when it is green.

# COMMIT

Commit each step that works. The final commit message starts with `RALPH: fix the full check`
and says what was red, the cause, which tickets it involved, and the files changed. Keep it
short.

Output <promise>COMPLETE</promise> only when the full check passes and your work is committed.
If you cannot make it green, commit what you have with a `RALPH(wip):` message that says what
is still red and why, and stop without the promise: a human takes it from there.
