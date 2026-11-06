# TASK

Branch `{{BRANCH}}` implements issue {{TASK_ID}}: {{ISSUE_TITLE}}. It is finished and
reviewed, but it conflicts with `{{BASE}}`, the branch it merges into. Make it merge cleanly.

You are on `{{BRANCH}}`, in a worktree of this repository. Merge the base into it:

```sh
git merge {{BASE}} --no-edit
```

These files conflict:

{{CONFLICTS}}

Resolve each conflict by reading both sides and keeping the intent of both: what `{{BASE}}`
gained since this branch was cut, and what this branch adds for the issue. Read the code around
each conflict, not the whole repository.

- **A generated file** — a migration journal or snapshot, an API client, a lockfile — is never
  merged by hand. Take the base's copy, then regenerate it with the repository's own command
  (see its `AGENTS.md`). For a database migration, keep both migrations and order this
  branch's after every migration the base has.
- **Never run `git worktree` or `git stash`**, and never `git rebase` or `git reset`: the branch
  keeps every commit it has.

Then run this project's verify gate, in the foreground, and make it pass. Its exit status is
the result, so do not pipe it through `tail` or `grep`:

```sh
{{VERIFY_COMMAND}}
```

Commit the merge. Then output <promise>COMPLETE</promise>. If you cannot resolve a conflict
without guessing at intent, run `git merge --abort`, say which conflict and why, and stop
without the promise: a human resolves it.

Do not close or edit the issue; the host does that once the branch is merged.
