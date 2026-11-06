# TASK

Review the code changes on branch `{{BRANCH}}` and improve code clarity, consistency, and maintainability while preserving exact functionality.

The branch implements issue {{TASK_ID}}: {{ISSUE_TITLE}}

# CONTEXT

## The issue

The issue is reproduced in full below, read on the host and injected, so you do not need to
fetch it. It is what the implementer was given, and it is the intent the change is reviewed
against.

<issue>

{{ISSUE_BODY}}

</issue>

Paths it names start at `grilled/`. The host's current copy is mounted one level up,
**read-only**: open a screenshot the issue links at `../grilled/…` rather than guessing from its
name. A change under `grilled/`, `.sandcastle/`, `.agents/` or `.claude/` is a defect: revert it.

**Never run `git worktree` or `git stash`.** This checkout's git metadata is shared with the
host and with every other sandbox working in this repository at the same time. The worktree
paths git recorded are host paths this container cannot see, so `git worktree add`, `remove`
or `prune` deletes the registration of checkouts it cannot find, this one included. And there
is one stash for all of them, so a `git stash pop` can apply another sandbox's changes. To
compare against a clean tree, use `git diff` or `git show <commit>:<path>` instead.

## Commits on this branch

{{COMMITS}}

## Files changed against `{{BASE}}`

{{DIFF_SUMMARY}}

## Source diff

{{DIFF_NOTE}}

```diff
{{DIFF}}
```

# REVIEW PROCESS

1. **Understand the change**: Read the issue, then the commits and diff above, to understand what was asked and what was built. The diff leaves out lockfiles, generated code and migration snapshots, but the file list names them: open one with `git diff {{BASE}}...HEAD -- <path>` when it bears on correctness, such as a migration's journal entry.

2. **Analyze for improvements**: Look for opportunities to:
   - Reduce unnecessary complexity and nesting
   - Eliminate redundant code and abstractions
   - Improve readability through clear variable and function names
   - Consolidate related logic
   - Remove unnecessary comments that describe obvious code
   - Avoid nested ternary operators - prefer switch statements or if/else chains
   - Choose clarity over brevity - explicit code is often better than overly compact code

3. **Check correctness**:
   - Does the implementation do what the issue asks — every acceptance criterion, and nothing it rules out of scope? Are edge cases handled?
   - Are new/changed behaviours covered by tests?
   - Are there unsafe casts, `any` types, or unchecked assumptions?
   - Does the change introduce injection vulnerabilities, credential leaks, or other security issues?

4. **Maintain balance**: Avoid over-simplification that could:
   - Reduce code clarity or maintainability
   - Create overly clever solutions that are hard to understand
   - Combine too many concerns into single functions or components
   - Remove helpful abstractions that improve code organization
   - Make the code harder to debug or extend

5. **Apply project standards**: the root `CLAUDE.md` is already loaded as your instructions;
   read any `CLAUDE.md` or `AGENTS.md` in a directory the diff touches, and follow the coding
   standards below.
   Check every changed line against both. A violation of either is a defect to fix, not a
   suggestion.

<coding-standards>

{{CODING_STANDARDS}}

</coding-standards>

   If the `clean-code` skill is available to you, invoke it and review the diff against it too.
   Where it disagrees with the repo docs or the standards above — on comments, function length,
   or test-first — the repo docs and the standards win.

6. **Preserve functionality**: Never change what the code does - only how it does it. All original features, outputs, and behaviors must remain intact. There is one exception, step 3: where the code does not do what the issue asks, make it do so — the issue is the contract, not the implementer's reading of it.

# EXECUTION

If you find improvements to make:

1. Make the changes directly on this branch
2. Run this project's verify gate, in the foreground, to ensure nothing is broken. Its exit
   status is the result, so do not pipe it through `tail` or `grep`:

   ```sh
   {{VERIFY_COMMAND}}
   ```

3. Commit describing the refinements

If the code is already clean and well-structured, do nothing, and do not run the gate: the
implementer ran it on this same commit.

Once complete, output <promise>COMPLETE</promise>. Keep your final report to a few lines.
