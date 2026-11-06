# Harbor Point: agent-native order-to-cash

The take-home for the AI Engineer assessment: an agent that reads Harbor Point Supply Co.'s order
inbox and acts in its ERP through tools, with a person approving anything risky. The brief is
[`docs/brief/assessment.md`](docs/brief/assessment.md); the data pack and its business rules are
[`data/harbor_point_data_pack/`](data/harbor_point_data_pack/README.md). Read both before a grilling
or a ticket.

This is **one repository** for everything: the app, the tickets under `grilled/`, and the tooling
that builds the app with AI agents (`.sandcastle/`, `.agents/skills/`, `.claude/skills/`). The
tickets are themselves a deliverable ("Task breakdown", brief item 2), so they are committed here
beside the code they produced.

## Where each deliverable lives

| Brief item | Lives at |
| --- | --- |
| 1. Product brief, with the assumptions list | `docs/product-brief.md` |
| 2. Task breakdown | `grilled/<effort>/tickets/`, as `/to-tickets` wrote them and sandcastle ran them |
| 3. Repository and README | this repository; `README.md` |
| 4. Live URL and login | `README.md`, "Live" |
| 5. Results and agent log | `docs/results.md`; sandcastle's run records are in `.sandcastle/runs/` (local) |

A file in the table that does not exist yet is not an instruction to write it. Write one when the
developer asks.

## The data pack is read-only

`data/harbor_point_data_pack/` is the pack exactly as delivered. Never edit it: the ingest loads it
into the app's own database, and every change the agent makes lands there. A fix to bad data in the
pack is a product decision, made in the ingest and listed in the product brief's assumptions.

## Branches

**Never commit to `main`.** A push to `main` deploys production (see "Deployment"). Every change
lands through a PR from its own branch.

A branch is named for the effort it serves, `feat/hp-<n>-<slug>`, with the same `hp-<n>-<slug>` as
the effort's `grilled/` directory, e.g. `feat/hp-1-order-intake`. `fix/` and `chore/` where the
change is one of those. **Sandcastle branches are exempt**: `sandcastle/issue-<id>` is derived by
`.sandcastle/main.mts`, one per ticket; do not rename them.

A new branch is cut from `origin/main` with `--no-track`, so a bare `git push` can never reach
`main`.

## Commits

- **A change stays uncommitted until the developer says to commit it.** Show the diff and how it
  was checked, then stop. An effort's planning notes follow the commit instruction given for them.
- **Commit by explicit path.** A file the developer staged is their review mark.
- **A worktree lives inside this repo**, at `.worktrees/` or `.claude/worktrees/`, never `/tmp`.
  `.sandcastle/worktrees/` stays sandcastle's own.

## Deployment

**Vercel, through its Git integration**: a push to `main` deploys production, and a pushed branch
gets a preview URL. That is the brief's "deployed through CI/CD … rather than by hand". Never run
`vercel deploy` or `vercel --prod` by hand. How the deploy is set up, its env vars and its database
go in `docs/deployment.md`, written when the deploy is built.

## Checks: the Makefile contract

The root `Makefile` is the one place that says how to install, check and test the app. Sandcastle
and CI both call it, so neither knows the stack:

| Target | Who runs it | What it does |
| --- | --- | --- |
| `make setup` | each sandbox before an agent starts; CI | install dependencies |
| `make verify BASE=<branch> CHANGED=<file>` | the ticket's checks in a sandbox | the fast checks for one change |
| `make check` | the full check after a merge; CI | every test and the build |

**`verify` and `check` hold no checks until the first scaffold ticket fills them in.** That ticket's
acceptance criteria must include real targets, and no other ticket should merge before it.

**No check calls a paid model API.** The sandbox has no key for the app, and CI should not spend
money. The model sits behind an interface that tests replace with a fake. A live run of the agent
over the 40 emails is an evaluation script a human runs, and its output feeds `docs/results.md`.

## Agent skills

Skills live in `.agents/skills/`, mirrored to `.claude/skills/` for Claude Code. Both are managed by
`skills-lock.json`, so an edit to a skill is overwritten on the next install: record a deviation
from a skill's default here or in `docs/agents/` instead. The `grilled/` routing below is such a
deviation: `/to-tickets` ships with a `.scratch/` default that this repo overrides.

### Issue tracker

Markdown files under `grilled/<identifier>/{issues,tickets}/`, driven by
`node .sandcastle/tracker.mjs`. See [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md).

`<identifier>` is the effort identifier: `hp-<n>-<slug>`, numbered from `hp-1`, e.g.
`hp-1-order-intake`. Each skill owns one destination:

| Skill | Writes | Where |
| --- | --- | --- |
| `/wayfinder` | the map, and its decision tickets | `grilled/<identifier>/` and `grilled/<identifier>/issues/` |
| `/to-tickets` | implementation tickets, each carrying `**Label:** sandcastle` | `grilled/<identifier>/tickets/` |

**Sandcastle implements only what carries the label.** `tracker.mjs list`, sandcastle's backlog,
reports only files labelled `sandcastle`, which by construction means only `/to-tickets` output
under `tickets/`. A `/wayfinder` decision ticket is a question for a human; sandcastle never picks
one up.

**Only `/to-tickets` writes `tickets/`; never write one yourself.** A `sandcastle`-labelled file is
not a document: it is a **work order in an agent-grabbable queue**, and filing it puts unrequested
changes in front of the next agent that runs `tracker.mjs list`. `issues/` belongs to `/wayfinder`
on the same logic. An empty directory is not an instruction. When a session produces material that
belongs under either directory, **say what would go there and stop.**

**The `Repo` field routes a ticket.** Every code ticket says `**Repo:** harbor-point`: this repo is
sandcastle's one project, so the app, the deploy config and the CI workflow are all routable. A
ticket for an action outside the repository, such as setting an env var in the Vercel dashboard or
connecting the Git integration, says `**Repo:** n/a — operational`: it is a human's to do, and
sandcastle holds it.

**Sequence with `Blocked by`.** Only a segment that opens with a bare number counts:
`**Blocked by:** 02 — [the tool layer](02-tool-layer.md)` parses, a link alone does not.

**Write the context into the ticket.** An implementer runs in a worktree with no session history.
"The tooltip is wrong" is unimplementable there; the email id, the expected outcome and the rule
from the data pack's README are not.

### Triage labels

The five canonical roles, unchanged, written as the ticket's `Status` field. See
[`docs/agents/triage-labels.md`](docs/agents/triage-labels.md).

### Domain docs

Single context: a root `CONTEXT.md` glossary and decisions in `docs/adr/`, both created lazily. See
[`docs/agents/domain.md`](docs/agents/domain.md).

## Asking the developer

**Ask one question at a time, through the question tool** (`AskUserQuestion` in Claude Code): one
call holds one question, its recommended option first and labelled "(Recommended)", and the next
question waits for the answer. What a question rests on (the email id, the data row, the brief's
words) goes in its text and option descriptions.

## Services you start

Run only what the work needs, and stop everything you started once the work is done: a dev server,
a watcher, a headless browser, a background job. Leave running what the developer started.

## Running sandcastle

[`README.md`](README.md), "Building with sandcastle", and [`.sandcastle/README.md`](.sandcastle/README.md).
