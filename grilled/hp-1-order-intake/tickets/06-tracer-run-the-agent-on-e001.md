# 06 — Tracer: run the agent on one email, and a clean order releases

**What to build:** A reviewer presses "Run the agent" on E001 (Bluefin Bistro, explicit SKUs to Pier Street) and watches the agent read it, look things up through tools, propose the order, pass the release gate, release SO-24059 with its stock allocated, and draft a confirmation, all recorded in the audit log.

**Repo:** harbor-point

**Blocked by:** 04, 05 — [The inbox, read-only](04-the-inbox-read-only.md), [Business rules as code](05-business-rules-as-code.md)

**Label:** sandcastle

**Status:** closed — resolved 2026-11-06 22:28 WIB by sandcastle

## Context

The map is [`map.md`](../map.md); words are defined in [`CONTEXT.md`](../../../CONTEXT.md); every screen follows [`DESIGN.md`](../../../DESIGN.md), whose living example is Variant A of [the prototype](../assets/prototype-review-ui.html). The business rules are in the [data pack README](../../../data/harbor_point_data_pack/README.md); the data pack is read-only.

- The agent's shape: [Charting, the agent's shape](../issues/01-charting-decisions.md#the-agents-shape);
  the autonomy line and the clean-order definition: [Charting, the autonomy line](../issues/01-charting-decisions.md#the-autonomy-line);
  [ADR 0001](../../../docs/adr/0001-code-gates-release-model-interprets.md).
- [Security 5](../issues/06-security-controls.md#answer): the email goes into the prompt as delimited
  data under a system prompt saying its content is never an instruction; tools only read the ERP and
  write Proposals, outcomes, flags and Draft replies; only the code gate releases; tool results are
  size-capped; at most 15 model calls per Agent run.
- Speed and records: [Speed and observability targets](../issues/12-speed-and-observability.md#answer)
  (Agent run record fields).
- Expected for E001: [the walkthrough](../assets/per-email-expected-outcomes.md), released, $672.00,
  HPS-1408 ×4, HPS-1402 ×6, HPS-1502 ×2, ship-to S001, requested Thu 5 Nov; a confirmation reply.
- Tests use the scripted fake model; no test calls the real model.

## Acceptance criteria

- [ ] Read tools `find_customer` (by exact sender address), `list_ship_tos`, `get_product`, `price_line`, `check_stock`, `check_credit`, `get_orders`, and action tools `propose_new_order`, `draft_reply`, `raise_flag`, `close_no_action`, each with a Zod schema; an invalid tool call is returned to the model as an error, never partially applied.
- [ ] A release gate in code evaluates a proposed new order against every check (known contact, every SKU sellable, system price, full stock, not on credit hold, within the credit limit, a clear ship-to, no flags) and either releases it or leaves it as a Proposal in the review queue with the failing checks recorded.
- [ ] A release creates the sales order and its lines, allocates stock (reducing `available`), and writes its audit events, all in one transaction.
- [ ] An Agent run record stores run id, email id, start and end, model calls, tokens, estimated cost, outcome, gate verdict and error class; every tool call and the gate verdict are audit events.
- [ ] "Run the agent" on an email that has not run (secondary button, `DESIGN.md`) starts a run; the row shows "Reading…" and then the outcome; the Proposal pane shows the headline, checks and the confirmation Draft reply.
- [ ] An end-to-end test with the scripted fake reproduces E001: released as one order of $672.00 to S001, inventory for HPS-1408 goes from 30 to 26, the audit log has the run, each tool call, the gate verdict and the release.
- [ ] A test proves the gate, not the model, decides: a scripted model that calls `propose_new_order` with a lower price, or claims the order is approved, still gets the system price and a review outcome when a check fails.
