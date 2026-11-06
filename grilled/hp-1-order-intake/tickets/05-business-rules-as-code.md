# 05 — Business rules as code

**What to build:** The data pack's business rules and the map's checks exist as one tested module with Zod-checked inputs, so the agent's tools and the release gate compute prices, stock, credit and edit rights the same way every time.

**Repo:** harbor-point

**Blocked by:** 02 — [Load the data pack into the database as the Snapshot](02-load-the-data-pack.md)

**Label:** sandcastle

**Status:** closed — resolved 2026-11-06 22:09 WIB by sandcastle

## Context

The map is [`map.md`](../map.md); words are defined in [`CONTEXT.md`](../../../CONTEXT.md); every screen follows [`DESIGN.md`](../../../DESIGN.md), whose living example is Variant A of [the prototype](../assets/prototype-review-ui.html). The business rules are in the [data pack README](../../../data/harbor_point_data_pack/README.md); the data pack is read-only.

- [ADR 0001](../../../docs/adr/0001-code-gates-release-model-interprets.md): code gates a release; the model
  only interprets. This module is that code; the gate (ticket 06) and the tools call it.
- Rules: contract price when the order date is within `valid_from`–`valid_to`, else list
  (C002's HPS-1403 contract expired 2026-09-30); whole selling units only; `available` and incoming
  supply; `CREDIT_HOLD` blocks; the credit check is `open_balance` + orders released earlier the same
  day + this order ([ticket 09, U15](../issues/09-sender-identity-and-credit.md#answer));
  DISCONTINUED cannot be sold and `replaced_by` names the successor; SHIPPED orders cannot be edited,
  OPEN can, PARTIALLY_SHIPPED only in the unshipped quantity.
- The business clock is fixed at Mon 2 Nov 2026 ([policy 1](../issues/01-charting-decisions.md#case-policies)).
- Expected numbers to test against: [the walkthrough](../assets/per-email-expected-outcomes.md),
  e.g. E003 = $3,185.80 with three Pinecrest contract prices; E006 takes Oak & Ember to $8,216 against
  an $8,000 limit; E027's customer is on CREDIT_HOLD.

## Acceptance criteria

- [ ] Functions for: the price of a SKU for a customer on a date (with its source), stock for a SKU (available and incoming with dates), the credit check for a customer and an order value (status and limit results, with the arithmetic), whether a SKU can be sold (and its replacement), and what an edit to a sales order is allowed to change given its status.
- [ ] Every function takes Zod-validated input and returns a typed result; money is integer cents end to end.
- [ ] Table-driven tests reproduce the walkthrough's figures for E001, E003, E006, E011, E015, E024, E027, E038 and E040, the contract-expiry case, a DISCONTINUED SKU, and each order status's edit rule (SHIPPED refused, PARTIALLY_SHIPPED limited to unshipped quantity).
- [ ] The module has no network or model access and no UI.
