# TASK

Fix issue {{TASK_ID}}: {{ISSUE_TITLE}}

The issue is reproduced in full below — it was read on the host and injected, so you do
not need to fetch it.

<issue>

{{ISSUE_BODY}}

</issue>

Its first line names the issue's own file, and the line after it names the **parent map**.
The map is the PRD: read the parts of it this issue relies on, and any sibling issue it links to.

Those paths start at `grilled/`. Your worktree has a `grilled/` as it was when your branch
was cut; the host's current copy is mounted one level up, **read-only**, so open the issue's
file, its parent map and the screenshots in its effort's `assets/` at `../grilled/…`. Look at
a screenshot the issue links rather than guessing from its name.

**You are already in the correct repository for this task** — `{{PROJECT}}`. This checkout is
a worktree of it, so your branch and commits belong here.

**Never change `grilled/`, `.sandcastle/`, `.agents/` or `.claude/`.** They are the tickets
and the tooling that runs you; the host owns them, and a change there merges into every later
ticket's base.

Only work on the issue specified.

**Never run `git worktree` or `git stash`.** This checkout's git metadata is shared with the
host and with every other sandbox working in this repository at the same time. The worktree
paths git recorded are host paths this container cannot see, so `git worktree add`, `remove`
or `prune` deletes the registration of checkouts it cannot find, this one included. And there
is one stash for all of them, so a `git stash pop` can apply another sandbox's changes. To
compare against a clean tree, use `git diff` or `git show <commit>:<path>` instead.

Work on branch {{BRANCH}}. It merges into `{{BASE}}`.

# PROGRESS

{{BRANCH_PROGRESS}}

{{SYNC_NOTE}}

# PROJECT RULES

This repository's root `CLAUDE.md` is already loaded as your instructions; do not read it
again. Read a `CLAUDE.md` or `AGENTS.md` in a directory you are about to change, and the docs
they link for the area you touch, at the section that applies. They are the authority on this
codebase — its architecture, its component library, its conventions — and they override the
issue text and your own defaults. If the issue asks for something they forbid, follow the repo
docs and say so in your commit message.

The shared standards for every project here follow. Hold your code to them as you write it,
not after; the reviewer checks against the same text.

<coding-standards>

{{CODING_STANDARDS}}

</coding-standards>

If the `clean-code` skill is available to you, invoke it before you write code, and hold your
code to it as well. Where it disagrees with the repo docs or the standards above — on comments,
function length, or test-first — the repo docs and the standards win.

# EXPLORATION

Read what the task needs, not the whole repository. Search for the symbols, routes and tables
the issue names, then read the code around each match and the tests that cover it. Widen only
when the change reaches further. Run independent searches and reads together, in one step.

# EXECUTION

If applicable, use RGR to complete the task.

1. RED: write one test
2. GREEN: write the implementation to pass that test
3. REPEAT until done
4. REFACTOR the code

**Commit as you go.** When a step works — a passing test, a finished layer — commit it with a
`RALPH(wip):` message that says what it did. A run can stop at any moment, when the usage
allowance runs out for example, and the next run resumes from your commits. Uncommitted work is
saved for you as a WIP commit when a run stops, but a commit you wrote says more.

Before the final commit, re-read your diff against the repo's `CLAUDE.md` / `AGENTS.md` and the
coding standards above, and fix anything that breaks them.

# FEEDBACK LOOPS

Before the final commit, run this project's verify gate, in the foreground, and make it pass:

```sh
{{VERIFY_COMMAND}}
```

It runs the repository's `make verify` on what you changed. It writes each check's full output
to `/tmp/sandcastle-verify/` and prints a short result, so do not pipe it through `tail` or
`grep`: its exit status is the result. While you work, run single test files directly. Do not
run `make check`: the runner runs it once your branch is merged.

**Then run the tests elsewhere that name what you changed.** A test in another folder that pins
the old behaviour fails first in the full check after the merge, and costs the run a fixer
round. Search the test files for each source file you changed, and for each field, function,
tool or route you renamed, removed or reshaped, by its old name, with `git grep -lF`. Run each
test file the search lists, and fix each failure: in your code if it is a defect, or in the test
if the test pins what the issue changed on purpose.

**Never call a paid model API from a test or a check.** The sandbox has no API key for the app,
and a test that needs one fails in CI too. Put the model behind an interface and test with a
fake; a live-model evaluation is a script a human runs, never part of `make verify`.

# COMMIT

Make the final git commit. The commit message must:

1. Start with `RALPH:` prefix
2. Include task completed + PRD reference
3. Key decisions made
4. Files changed
5. Blockers or notes for next iteration

Keep it short.

If you find that the work is already in `{{BASE}}`, change nothing. Make one empty commit
(`git commit --allow-empty`) whose `RALPH:` message names the commit or PR the work landed in
and how you checked each acceptance criterion.

# FINISHING

The issue file is read-only and the host closes it, so do not try to edit or comment on it.

Output <promise>COMPLETE</promise> only when every acceptance criterion holds, the verify gate
passes and the work is committed. If you cannot finish, commit what you have with a
`RALPH(wip):` message that says what is left, and stop without the promise: the next run
resumes from there.

# FINAL RULES

ONLY WORK ON A SINGLE TASK. Keep your final report short.
