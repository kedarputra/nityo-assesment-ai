# 13 — Inbox run, reset and the admin controls

**What to build:** An admin runs the agent over the whole inbox from the browser and watches it work through all 40 emails in order, can stop it, resume it, and reset everything to 07:00; runs are locked, safe to repeat, rate-limited and stop cleanly at deadlines or spend limits.

**Repo:** harbor-point

**Blocked by:** 07 — [Review a Proposal: approve, edit, override, reject, hold](07-review-a-proposal.md)

**Label:** sandcastle

**Status:** ready-for-agent

## Context

The map is [`map.md`](../map.md); words are defined in [`CONTEXT.md`](../../../CONTEXT.md); every screen follows [`DESIGN.md`](../../../DESIGN.md), whose living example is Variant A of [the prototype](../assets/prototype-review-ui.html). The business rules are in the [data pack README](../../../data/harbor_point_data_pack/README.md); the data pack is read-only.

- Decided in [How a whole-inbox run is driven and how the snapshot is reset](../issues/05-inbox-run-and-reset.md#answer)
  and [ADR 0003](../../../docs/adr/0003-browser-driven-inbox-run.md): the browser calls "run one email"
  once per unprocessed email in `received_at` order; one run per email and one Inbox run at a time;
  resume from the first unprocessed email; a re-run supersedes only undecided Proposals; a release is
  unique per Proposal; `maxDuration = 300`, at most 15 model calls, a clean stop before
  `getDeadline()`; a spend-limit error (400 usage limits, 429 `enforced_spend_limit_reached`) stops
  the run and is never retried; Reset is admin-only, confirmed, refused while a run holds the lock,
  and starts the new audit log with "reset by <user>".
- [Security 2 and 7](../issues/06-security-controls.md#answer): admin-only Run all, Reset and Stop;
  30 agent runs and 3 resets per user per hour.
- Controls placement: the header's account menu (Run all, Reset to 07:00); progress in the greeting
  card ("Reading 12 of 40…").

## Acceptance criteria

- [ ] Run all processes every unprocessed email in `received_at` order, one request per email, with live progress; closing the tab and pressing Run all again resumes from the first unprocessed email.
- [ ] Locks: a second run on the same email, or a second Inbox run, is refused with a clear message; a run that hits its deadline or call cap ends as "timed out, run it again".
- [ ] Re-running an email withdraws its undecided Proposals (marked superseded in the audit log, never deleted) and never touches decided or released work; a release can never happen twice for one Proposal.
- [ ] A spend-limit response stops the run immediately with the calm message from `DESIGN.md`; it is not retried.
- [ ] Reset (admin, confirmed) restores the Snapshot via the ticket 02 function, is refused while a run holds the lock, and the new audit log starts with the reset event.
- [ ] Rate limits are enforced per user per hour and counted in Postgres.
- [ ] Tests with the fake model cover ordering, resume, both locks, supersede, the timeout stop, the spend-limit stop, reset refusal during a run, and the rate limits; reviewers are refused all admin actions.
