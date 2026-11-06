# Running sandcastle

Sandcastle implements the `sandcastle`-labelled tickets under `grilled/<effort>/tickets/`, one
sandbox per ticket, and merges each finished one into its project's checkout.

## Before a run

1. Leave the checkout on `main`, or on the effort's branch: the run moves a checkout on `main` to
   `feat/hp-1-order-intake` ([`lib/effort-branch.mjs`](lib/effort-branch.mjs)). This repository
   is its own one project, so the root and the project are the same checkout. It takes the local branch,
   then origin's, and otherwise cuts a new one from `origin/main`. A checkout on any other branch
   stays where it is, and the runner holds every ticket whose checkout is on another effort's
   branch. A checkout on `main` stays there, and holds its tickets with the reason, when:
   - it has uncommitted changes to tracked files,
   - its tickets come from more than one effort (run with `--map`), or
   - its `main` has commits `origin/main` does not have.
2. Look at what would run. This fetches origin and changes nothing else:

   ```sh
   npm run sandcastle:dry-run -- --map hp-1-order-intake
   ```

   Each held ticket has its reason. Each ready ticket has its stage, how many commits it has, and
   whether its worktree has uncommitted edits. Each project with a ready ticket says whether its
   branch already passed the full check, or the full check runs first.

## A run

```sh
npm run sandcastle -- --map hp-1-order-intake [--parallel 3] [--rounds 1]
```

A round starts every ticket that is ready, then merges and closes the finished ones; the next
round starts the tickets those closes unblocked. `--rounds 1` stops after the first round, so no
new ticket starts until you look at the result. Without it, rounds repeat until no ticket can
start (at most 10).

| Step | Who | What |
| --- | --- | --- |
| Branch | host git | move each checkout on `main` that a ticket waits on, and this root, to the effort's branch; fast-forward each checkout's branch to origin's. A root on another effort's branch holds every ticket |
| Select | host script | open, labelled, unblocked tickets whose `Repo` names one project ([`lib/selection.mjs`](lib/selection.mjs)) |
| Check | sandbox, no model | before tickets start on a checkout, the full check of its tip, unless that tip already passed or is origin/main's tip (a fresh cut, which CI checked on main): its CI's own steps ([`sandbox/full-check.sh`](sandbox/full-check.sh)). Red on a tip someone else made: that project's tickets are held |
| Fix | Opus | only when the check of a tip the runner's merges made is red: one turn on `sandcastle/check-<base>`; the host checks again and merges the fix only when it is green. Still red, the run stops |
| Prepare | host script | make or reuse the worktree, commit edits a stopped run left as `RALPH(wip):` (without a lockfile `npm install` rewrote alone), rewrite CRLF copies as stored, merge the base in when the implementer has not signed off |
| Implement | Opus | up to 4 turns in one session; stops after 2 turns with no progress. Its "done" counts only when the host's own run of the ticket's checks passes; when they fail, its next turn gets the failure |
| Review | Opus | one turn, on a bounded diff without lockfiles or generated code. The host runs the ticket's checks after it too; when they fail, the ticket goes back to the implementer on the next run |
| Merge | host git | a clean merge into the checkout; a conflict goes to an Opus resolver on the ticket branch, and the host runs the ticket's checks after it |
| Close | host script | `tracker.mjs close`, only after git confirms the branch is in the checkout |
| Push | host git | each checkout's branch, each ticket branch the checkout has not merged, and each fix attempt that stayed red, to origin |
| Check, at the end | sandbox, no model | the full check, and the fix when it is red, of each checkout this run merged into that no later round checked; then the last push |

Each ticket is attempted once per run. When the usage allowance runs out, no new model call
starts; work in progress is committed on its branch, and clean merges and closes still happen.
The full check at the end still runs, since it uses no model; when it is red, the fixer waits for
the next run.

## On another machine

Everything a run makes goes to origin, so you can go on from any machine with the same command.
The run pushes after each round, and again when it ends, also on an error or Ctrl-C. Before that
last push, it saves what a stopped agent left uncommitted as a `RALPH(wip):` commit. It pushes
the branch of each repository it committed to, each ticket branch with commits that did not
merge, and each fix attempt that stayed red. It never pushes `sandcastle/check-<base>`.

- **A push never deploys.** The run never pushes `main`, `master` or a tag: a push to `main`
  starts the production deploy on Vercel. A pushed `feat/` branch gets a Vercel preview, which
  is harmless. It never forces a push. A refused push is listed at
  the end, and the commits stay on this machine.
- **The next machine takes the work up.** The run fetches each repository once. It fast-forwards
  each checkout's branch, and each ticket branch, to origin's copy before a ticket starts.
- **Stage markers stay local.** On another machine, a ticket resumes as `in-progress`, so the
  implementer and the reviewer each run once more before the merge.
- **Full check refs stay local too.** On another machine, every tip reads as unchecked: the full
  check runs once before tickets start, and when it is red, the project's tickets are held with no
  fixer, even for a tip the first machine's merges made. A fixer stopped on the first machine,
  and its commits on `sandcastle/check-<base>`, stay there.

## Checks

Both checks call the root `Makefile`, so the stack decides what runs, not the runner:

| Check | Script | Calls |
| --- | --- | --- |
| the ticket's checks | [`sandbox/verify.sh`](sandbox/verify.sh) | `make verify BASE=<base> CHANGED=<file of changed paths>`; skipped when only `.sandcastle/`, `grilled/`, `.agents/` or `.claude/` changed |
| the full check | [`sandbox/full-check.sh`](sandbox/full-check.sh) | `make check`, the same target CI runs |
| sandbox setup | the `onSandboxReady` hook in [`main.mts`](main.mts) | `make setup` |

The agent runs them before it says it is done, and the host runs them again after: a "done"
counts only when they pass. The host runs nothing again when the working tree still has the exact
content of a run that passed (`/tmp/sandcastle-verify/result` in the sandbox), as it does when the
agent checked and then committed.

**The full check**, [`sandbox/full-check.sh`](sandbox/full-check.sh), runs `make check`, the
same target CI runs, which includes the full suite and the build. Without it nothing runs the
full suite between a ticket's merge and the effort's PR.
No ticket starts on a checkout whose tip has not passed it. Two refs per checkout branch, in the
project's own git, say where the tip stands, so a tip that passed is not checked again:

| Tip | Ref | Check | When red |
| --- | --- | --- | --- |
| passed | `refs/sandcastle/checked/<base>` names it | none | — |
| main: a fresh cut, the same commit as `origin/main` | `refs/remotes/origin/main` names it | none: CI checked it on `main`. It is recorded as passed | — |
| pending: the runner's merges made it | `refs/sandcastle/check-pending/<base>` names it | runs | the fixer fixes it on `sandcastle/check-<base>`, and the host checks again. Still red: the attempt is kept on `sandcastle/fix-attempt-<base>-<sha>` and pushed, the run stops, and the tip is left to a human |
| unchecked: someone else moved it, or it never ran | neither | runs | the project's tickets are held for this run, and the next run checks it again. No fixer: no merge of a run made it red |

A check that runs past its limit (30 min) is red, as "TIMED OUT".

## After a stop

Run the same command again. A ticket resumes from its branch:

| Stage | Meaning | The next run |
| --- | --- | --- |
| `in-progress` | commits or WIP, not signed off | merges the base in, then the implementer continues from the commits |
| `implemented` | the implementer signed off on the tip | runs the reviewer only |
| `reviewed` | the reviewer signed off on the tip | merges, with no model |

The stage is a ref, `refs/sandcastle/<stage>/<branch>`, that counts only while it names the
branch tip. `npm run sandcastle:clean` deletes it with the branch. When the ticket's checks fail
after the reviewer, both markers are deleted, so the ticket is `in-progress` again.

A worktree's `node_modules` counts only once its sandbox was set up: the copy from the checkout
and `npm install` both finished. The run then writes a marker in the worktree's git directory
([`lib/node-modules.mjs`](lib/node-modules.mjs)). A `node_modules` with no marker is what a stop
left half copied, so the next run deletes it and copies it again. A worktree made before the
marker existed is copied again once.

A full check that a stop cut short is run again: its tip keeps its state, so the next run checks
it before any ticket starts. A pending tip goes to the fixer again when it is still red, and that
fixer goes on from the stopped fixer's commits on `sandcastle/check-<base>`. What the stopped
fixer left uncommitted is saved there as a `RALPH(wip):` commit first. `npm run sandcastle:clean`
deletes that branch with every other `sandcastle/` branch, a stopped fixer's commits included,
but not the check refs.

## Slack

Optional, and off by default. A run sends its events to a Slack channel only when
`SANDCASTLE_SLACK_WEBHOOK_URL` in `.sandcastle/.env` names an incoming webhook
([`lib/notify.mjs`](lib/notify.mjs)). With it empty or absent, a run sends nothing and works as
before. A dry run sends nothing either.

To turn it on:

1. Make an incoming webhook: api.slack.com/apps, then your app, then "Incoming Webhooks", then the
   channel.
2. Copy the `SANDCASTLE_SLACK_*` lines from [`.env.example`](.env.example) into
   `.sandcastle/.env`, and set the webhook URL. `.env` is gitignored, so do this on each machine
   that runs sandcastle.

The settings stay on the host: no sandbox gets them. A wrong `SANDCASTLE_SLACK_EVENTS` value
stops the run before it starts.

| Setting | What it does | When empty |
| --- | --- | --- |
| `SANDCASTLE_SLACK_WEBHOOK_URL` | the incoming webhook | no message is sent |
| `SANDCASTLE_SLACK_EVENTS` | the events to send, comma-separated, from the table below | every event |
| `SANDCASTLE_SLACK_MENTION` | who an alert notifies, e.g. `<!here>` or `<@U0123ABCD>` | no mention |
| `SANDCASTLE_SLACK_MACHINE` | the machine's name in each message | the host name |

Each message is a card with a colored bar: blue for a start, green for a pass, yellow for a
warning, red for an error, grey for a round where no ticket can start. Above the card is the
machine's name in bold, such as `*[dev-laptop]*`, so messages from two machines stay apart.
Below it is the list of efforts the run is limited to.

| Event | When | What it says |
| --- | --- | --- |
| `run-start` | after the 5-second pause | how many tickets at a time, how many rounds |
| `round-start` | each round, after selection and the full check | each ready ticket, with its project and the stage it resumes at; each held ticket, with why |
| `round-error` | at once, when it happens | the ticket and why: a ticket that failed, one not merged, a conflict not resolved, a close that failed |
| `round-end` | after the round's merges and push | each ticket's outcome, whether it merged and closed, and why it stopped |
| `full-check-start` | each full check, when it starts: before a round's tickets, or the final one after the last round | the project, the branch, the time limit, and what a red does |
| `full-check` | each full check, when it ends | green, fixed by the fixer, or why it did not pass; how long it took; "Final" on the final one |
| `allowance-spent` | once | no new model call starts |
| `run-end` | the run's end | how long the run took; the rounds that ran tickets; the tickets started, resumed, merged and closed, and each outcome; the full checks; the tokens; the run record's path; each ticket and each full check in a list; why it ended early; what is only on this machine |
| `run-stopped` | Ctrl-C, SIGTERM or a crash, after the run started | why, and what is only on this machine |

`SANDCASTLE_SLACK_MENTION` goes above the card, next to the machine's name, on each alert:
`round-error`, a full check that did not pass, `run-stopped`, and a `run-end` that ended early or
left something unpushed. A post that fails never stops the run: the console shows the first
failure, and the run goes on.

### Send sample messages

To check the webhook and how each card looks, with no run, send a sample of each event
([`slack-test.mjs`](slack-test.mjs)). Run it from the repository root:

```sh
npm run sandcastle:slack-test                          # all 9 events, in a run's order
npm run sandcastle:slack-test -- round-error run-end   # only the named events
npm run sandcastle:slack-test -- --print               # the text of each message; sends nothing
```

It reads the same `SANDCASTLE_SLACK_*` settings from `.sandcastle/.env` as a run, and sends each
event you name, also one that `SANDCASTLE_SLACK_EVENTS` leaves out. To see the mention, send an
alert. Every ticket, branch and effort in a sample starts with `tt-0000`, the samples' own placeholder. A failed post shows
Slack's answer, and the command exits with code 1.

## Measurements

Each run writes `.sandcastle/runs/<start time>.json`: each ticket's phases and their times, its
token use from the session files, whether it resumed, whether the reviewer changed anything
(`reviewerCommits`, `reviewerChange`), each full check with its result and the fixer's tokens,
and a summary with tickets per hour.

## Tests

```sh
npm run sandcastle:test
```

The tests use temporary git repositories only.
