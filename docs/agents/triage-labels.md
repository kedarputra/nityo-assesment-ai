# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual
label strings used in this repository's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label
string from this table.

## How a label is written

There is no label API here — the tracker is markdown files (see
[`issue-tracker.md`](./issue-tracker.md)). A label is the value of the ticket's `Status` field, in
whichever of the two conventions the file already uses:

```markdown
Status: ready-for-agent
```

```markdown
**Status:** ready-for-agent
```

```markdown
| **Status** | ready-for-agent |
```

Applying a label means rewriting that one line. Don't add a second `Status` line, and don't switch a
file from one convention to the other.

## What the tracker reads back

[`tracker.mjs`](../../.sandcastle/tracker.mjs) classifies a ticket from the **first word** of its
`Status` value, so the labels above interact with it as follows:

- `wontfix` is **not** closed by that rule — it is a first word the tracker does not recognise, so a
  `wontfix` ticket stays in the open list. If it should leave the runner's queue, close it as well:
  `Status: closed — wontfix, <stamp>`, with the [stamp](./issue-tracker.md#ticket-fields) any close
  carries.
- `ready-for-human` is open and would be offered to an agent. Prefix it with a parked marker —
  `◐`, `awaiting`, `on hold`, `paused`, or `needs human` — to keep it open but withheld from `list`,
  which is what "requires human implementation" actually means here.
- `needs-triage`, `needs-info` and `ready-for-agent` are all open, which is correct: only
  `ready-for-agent` should be reachable by the runner, and the other two are filtered by the
  triaging skill rather than by the tracker.

Edit the right-hand column if the vocabulary ever changes.
