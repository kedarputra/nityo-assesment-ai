# hp-1 — Order intake: map

**Label:** wayfinder:map

Serves the whole of the brief's "What to build and deliver"
([`docs/brief/assessment.md`](../../docs/brief/assessment.md)), against the data pack's rules
([`data/harbor_point_data_pack/README.md`](../../data/harbor_point_data_pack/README.md)).

## Destination

Every product and architecture decision the brief asks for is settled and written down, so
`/to-tickets` can slice the full build (ingest, the agent and its tools, the release gate, the review
UI, the audit trail, login and the CI/CD deploy) into sandcastle tickets. The product brief's
decisions and assumptions fall out of this map.

## Notes

- **Lean map, full scope.** Cover every brief item with no cuts for time, and ticket only the
  decisions that block the build. Settle what can be settled in conversation.
- Grilling tickets call the `grilling` and `domain-modeling` skills. The glossary is
  [`CONTEXT.md`](../../CONTEXT.md); decisions that qualify go in [`docs/adr/`](../../docs/adr/).
- Ground every question in an email id, an ERP row, or the brief's or README's own words.
- Ask the developer one question at a time, through the question tool (`AGENTS.md`).
- The data pack is read-only; a fix to bad data is an ingest decision and a product-brief assumption.

## Decisions so far

- [Charting: destination and scope](issues/01-charting-decisions.md#destination-and-scope): the whole
  product, full scope, kept lean.
- [Charting: the autonomy line](issues/01-charting-decisions.md#the-autonomy-line): the agent releases
  only clean new orders; everything else becomes a Proposal in the review queue.
- [Charting: requests that are not new orders](issues/01-charting-decisions.md#requests-that-are-not-new-orders):
  edits and cancels get ERP Proposals; returns, invoices, quotes and complaints are routed; spam and
  auto-replies get no action.
- [Charting: replies to customers](issues/01-charting-decisions.md#replies-to-customers): Draft
  replies are edited and approved in the UI, and never sent.
- [Charting: the release gate](issues/01-charting-decisions.md#the-release-gate): code gates a
  release; the model only interprets (ADR 0001).
- [Charting: stack](issues/01-charting-decisions.md#stack): Next.js + Postgres (Neon) + Claude on
  Vercel (ADR 0002).
- [Charting: how the agent runs live](issues/01-charting-decisions.md#how-the-agent-runs-live): live
  runs from the UI over the 07:00 snapshot, with an admin reset.
- [Charting: case policies](issues/01-charting-decisions.md#case-policies): twelve policies, from the
  business clock (2 Nov 2026) to treating instructions inside an email as data.
- [Charting: login](issues/01-charting-decisions.md#login): seeded named users with a password;
  every approval records its user.
- [Charting: approve, edit and override](issues/01-charting-decisions.md#approve-edit-and-override):
  every approval re-runs the checks; soft checks can be overridden with a reason, hard rules cannot.
- [Charting: the agent's shape](issues/01-charting-decisions.md#the-agents-shape): one tool-use run
  per email, read and action tools, Opus 5.5, and an append-only audit log.
- [Vercel and Neon limits for agent runs](issues/04-vercel-neon-agent-run-limits.md): one email fits
  in a function budget but 40 don't; Workflows is the only built-in option that keeps order; use
  `pg` with a pool on Neon; three ways to reset; cap spend on a dedicated Anthropic workspace.

## Not yet specified

- **New case policies.** Whatever the
  [walkthrough of the 40 emails](issues/03-per-email-walkthrough.md) finds that no policy covers.
- **The eval script and its metrics.** How a live run over the 40 emails is scored against the
  walkthrough's expected outcomes for `docs/results.md`: which mismatches count, and how a
  routed-but-correct email scores.
- **Production success metrics** for the product brief (brief item 1, "how you would measure success
  in production"): what gets measured, such as the share released untouched, edit rate on Proposals,
  time to order and gate misses.

## Out of scope

- **Sending real email.** Draft replies are never sent; the inbox is a static snapshot of fictional
  `.example` addresses ([replies](issues/01-charting-decisions.md#replies-to-customers)).
- **An MCP server.** The tools run in-process; the brief allows "functions, an API or an MCP server"
  ([the agent's shape](issues/01-charting-decisions.md#the-agents-shape)).
- **Quote generation, and a returns, credits or invoices model.** The ERP has no such data; these
  requests are routed to a person
  ([other kinds](issues/01-charting-decisions.md#requests-that-are-not-new-orders)).
- **An outside auth provider** ([login](issues/01-charting-decisions.md#login)).
- **Live mailbox polling.** The inbox is the 40 emails of 2 Nov, loaded by the ingest.
