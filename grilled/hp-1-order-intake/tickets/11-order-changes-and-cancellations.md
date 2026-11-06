# 11 — Order changes and cancellations

**What to build:** Emails that change or cancel an existing sales order become change or cancellation Proposals checked against the README's edit rules, and "also add" follow-ups attach to the right earlier order or Proposal.

**Repo:** harbor-point

**Blocked by:** 07 — [Review a Proposal: approve, edit, override, reject, hold](07-review-a-proposal.md)

**Label:** sandcastle

**Status:** ready-for-agent

## Context

The map is [`map.md`](../map.md); words are defined in [`CONTEXT.md`](../../../CONTEXT.md); every screen follows [`DESIGN.md`](../../../DESIGN.md), whose living example is Variant A of [the prototype](../assets/prototype-review-ui.html). The business rules are in the [data pack README](../../../data/harbor_point_data_pack/README.md); the data pack is read-only.

- [Charting, requests that are not new orders](../issues/01-charting-decisions.md#requests-that-are-not-new-orders):
  SHIPPED cannot be edited; OPEN can; PARTIALLY_SHIPPED only in the unshipped quantity.
- Policy 9 and [ticket 08, U2](../issues/08-emails-that-belong-together.md#answer): a follow-up to an
  OPEN order is a change Proposal to it; a follow-up to a pending Proposal is a separate new-order
  Proposal linked to it; Proposals are never amended in place. [Ticket 07, U1](../issues/07-words-to-order-lines.md#answer)
  for odd units in follow-ups.
- Expected ([the walkthrough](../assets/per-email-expected-outcomes.md)): E004 change to SO-24051
  (HV-3391, OPEN: line 1 20 → 25 cases HPS-1103 at the C003 contract price, add 5 cases HPS-1304;
  +$575.00); E017 cancellation of SO-24055 (SOP-1182, OPEN, $1,500.00); E026 follow-up to E002's
  released order (gloves in boxes, `UNIT-ambiguous`); E035 follow-up to E010's pending Proposal
  (glove type and size unknown); E037 follow-up to E012's pending Proposal ("5 kraft bags").

## Acceptance criteria

- [ ] `propose_order_change` and `propose_cancellation` tools create Proposals against a named sales order, showing its lines as before → after.
- [ ] The edit rules are enforced by the business-rules module: a change to a SHIPPED order is a hard-rule failure; a PARTIALLY_SHIPPED change may only touch unshipped quantity.
- [ ] Approving a change or cancellation applies it to the sales order and adjusts stock allocation in one transaction, with audit events.
- [ ] Follow-ups attach per policy 9 and U2: change Proposal for an OPEN target, linked separate Proposal for a pending one, shown side by side in the desk.
- [ ] Tests with the fake model reproduce the expected outcomes for E004, E017, E026, E035 and E037, and a SHIPPED-order change is refused.
