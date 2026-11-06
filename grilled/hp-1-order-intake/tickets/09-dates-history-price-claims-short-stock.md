# 09 — Dates, history, price claims and short stock

**What to build:** The agent reads requested dates, rebuilds "the usual" from history, ignores prices stated in the email in favour of the system's, and handles short stock and dates the stock cannot meet, each as a clear reason for review with the right question in the reply.

**Repo:** harbor-point

**Blocked by:** 06 — [Tracer: run the agent on one email, and a clean order releases](06-tracer-run-the-agent-on-e001.md)

**Label:** sandcastle

**Status:** closed — resolved 2026-11-06 23:28 WIB by sandcastle

## Context

The map is [`map.md`](../map.md); words are defined in [`CONTEXT.md`](../../../CONTEXT.md); every screen follows [`DESIGN.md`](../../../DESIGN.md), whose living example is Variant A of [the prototype](../assets/prototype-review-ui.html). The business rules are in the [data pack README](../../../data/harbor_point_data_pack/README.md); the data pack is read-only.

- [Ticket 07](../issues/07-words-to-order-lines.md#answer): U11 (a bare weekday is its next occurrence
  after Mon 2 Nov; "today" is 2 Nov; "next <weekday>" records both dates and flags
  `DATE-ambiguous`), U14 ("the usual" is the lines common to recent orders; the rest is offered in
  the reply).
- [Ticket 10](../issues/10-replies-when-we-cannot-do-it.md#answer): U10 (an unmeetable date shows
  `DATE-unmeetable` beside partial, backorder and decline; the reply gives the earliest real date).
- [Charting policies](../issues/01-charting-decisions.md#case-policies) 2 (short stock: available
  plus incoming; a person picks partial or backorder), 4 (a price in the email that differs: system
  price, flagged), 8 ("same as last time" from history), 12 (a past requested date, flagged).
- Expected ([the walkthrough](../assets/per-email-expected-outcomes.md)): E024 Proposal (`P4`, the
  expired $70 contract, list $78, `DATE-ambiguous` for "next Tuesday"); E025 Proposal (`P4`, $30 vs
  $34); E032 Proposal (`P12`, "by Friday October 30"); E036 Proposal (`P8`, three common lines,
  napkins offered); E010 Proposal (`P8`, from SO-24040); E008 Proposal (`P2`, `DATE-unmeetable`: 0
  of HPS-1405 now, 100 due 13 Nov); E033 Proposal (`P2`: 5 of 12 HPS-1302 now, 40 due 9 Nov).

## Acceptance criteria

- [ ] Requested dates are resolved per U11 and stored with the original phrase; ambiguous ones carry both dates and `DATE-ambiguous`; past ones carry `P12-past-date`.
- [ ] A price stated in the email never changes the order's price; a difference is flagged `P4-price-differs` and explained in the reply.
- [ ] "Same as last time" and "the usual" are rebuilt from the customer's sales orders per U14 and flagged `P8-from-history`.
- [ ] Short stock shows available and incoming with dates and is flagged `P2-short-stock`; when no option meets the date, `DATE-unmeetable` is added and decline is offered beside partial and backorder.
- [ ] Tests with the fake model reproduce the expected outcomes for E008, E010, E024, E025, E032, E033 and E036.
