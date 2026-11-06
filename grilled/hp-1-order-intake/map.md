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
- Every screen follows [`DESIGN.md`](../../DESIGN.md); its living example is Variant A of
  [the review UI prototype](assets/prototype-review-ui.html).

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
- [What the ops review UI looks like](issues/02-review-ui-prototype.md): a three-pane inbox (list,
  email with the agent's reasoning, Proposal) with blockers first and a one-line headline; no bulk
  approval; quantity, SKU, lines and ship-to are editable, price and customer are not.
- [Walk the 40 emails through the locked policies](issues/03-per-email-walkthrough.md): expected
  outcomes for all 40, which also serve as the eval set: 9 released, 22 Proposals, 6 routed and
  3 no action, after ticket 08 made E031 a Proposal. Its 18 uncovered cases became tickets 07–10.
- [How a whole-inbox run is driven and how the snapshot is reset](issues/05-inbox-run-and-reset.md):
  the browser drives one email per request, resumable and locked (ADR 0003); reset by truncate and
  reseed; one shared preview database; Hobby is enough; `pg` on the pooled URL.
- [Which security controls the build must meet](issues/06-security-controls.md): password login
  (no SSO), reviewer and admin roles checked on the server, Zod at every input, untrusted content
  shown only as text with a CSP, an append-only audit log enforced in the database, rate limits,
  and no secrets or email bodies in logs.
- [How the agent turns a customer's words into order lines](issues/07-words-to-order-lines.md): a
  described line releases when exactly one ACTIVE SKU fits, checked in code; odd units, a swap's
  size and price, "the usual" and "next Tuesday" go to review with a question.
- [How the agent links emails that belong together](issues/08-emails-that-belong-together.md): a run
  reads the customer's other emails and open work today; it links them but never changes another
  email's Proposal. E031 becomes a Proposal tied to E023's missing PO.
- [Who the sender is, and what the credit check counts](issues/09-sender-identity-and-credit.md): the
  verified address wins (E039 releases, E013 gets checked); domain matching only when one customer
  owns the domain; credit is `open_balance` + same-day releases + this order.
- [What the agent tells a customer when it can't do what was asked](issues/10-replies-when-we-cannot-do-it.md):
  every release gets a confirmation; no quantity means a clarifying question; an unmeetable date
  gets the earliest real date; an order we can't find gets an honest reply.
- [How the agent's results are measured](issues/11-how-results-are-measured.md): `make eval` with
  unsafe releases (target 0) first, then outcome, line and review-reason accuracy, three runs; the
  product brief's production metrics.
- [Speed and observability targets](issues/12-speed-and-observability.md): under 500 ms per person's
  action, inbox under 1.5 s, runs usually under 60 s; Agent run records in Postgres and structured
  logs with no bodies or secrets; no third-party monitoring.

## Not yet specified

Nothing. Every patch of fog has become a ticket and been decided; the way to the destination
is clear, and the next step is `/to-tickets` (only the developer can run it).

## Out of scope

- **Sending real email.** Draft replies are never sent; the inbox is a static snapshot of fictional
  `.example` addresses ([replies](issues/01-charting-decisions.md#replies-to-customers)).
- **An MCP server.** The tools run in-process; the brief allows "functions, an API or an MCP server"
  ([the agent's shape](issues/01-charting-decisions.md#the-agents-shape)).
- **Quote generation, and a returns, credits or invoices model.** The ERP has no such data; these
  requests are routed to a person
  ([other kinds](issues/01-charting-decisions.md#requests-that-are-not-new-orders)).
- **An outside auth provider or SSO** ([login](issues/01-charting-decisions.md#login)), confirmed
  by [Which security controls the build must meet](issues/06-security-controls.md) after the
  developer raised SSO.
- **Live mailbox polling.** The inbox is the 40 emails of 2 Nov, loaded by the ingest.
