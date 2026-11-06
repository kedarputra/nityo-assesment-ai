# 08 — Products described in words, and units

**What to build:** The agent turns lines written in words into SKUs, releases them only when exactly one product fits, reads odd units into whole selling units for review, and proposes a discontinued product's replacement for a person to accept.

**Repo:** harbor-point

**Blocked by:** 06 — [Tracer: run the agent on one email, and a clean order releases](06-tracer-run-the-agent-on-e001.md)

**Label:** sandcastle

**Status:** ready-for-agent

## Context

The map is [`map.md`](../map.md); words are defined in [`CONTEXT.md`](../../../CONTEXT.md); every screen follows [`DESIGN.md`](../../../DESIGN.md), whose living example is Variant A of [the prototype](../assets/prototype-review-ui.html). The business rules are in the [data pack README](../../../data/harbor_point_data_pack/README.md); the data pack is read-only.

- Decided in [How the agent turns a customer's words into order lines](../issues/07-words-to-order-lines.md#answer):
  U18 (a described line is confident only when exactly one ACTIVE SKU remains after the stated size,
  colour, material and type; the gate checks the line cites a `search_products` result with one
  candidate, else `LOW-CONF-sku`), U1 (the most plausible whole-selling-unit reading, flagged
  `UNIT-ambiguous`, with the reply asking), U9 (a substitution keeps the case count; the Proposal and
  reply state the pack and price difference).
- Policy 3: DISCONTINUED products are never substituted on the agent's own authority.
- Expected outcomes ([the walkthrough](../assets/per-email-expected-outcomes.md)): E002 released
  (HPS-1104 ×3, HPS-1304 ×2, HPS-1203 ×2, $335.00); E011 released in Spanish context (HPS-1202 ×10,
  HPS-1002 ×4, HPS-1410 ×2 EA, $770.00, reply in Spanish per policy 10); E019 Proposal (HPS-1001 ×4
  replacing HPS-1004); E020 Proposal (HPS-1307 ×2 replacing HPS-1306, plus HPS-1201 ×10 at the C007
  contract price); E021 Proposal (`LOW-CONF-sku`: HPS-1035 does not exist).

## Acceptance criteria

- [ ] A `search_products` tool that returns ACTIVE candidates for a description with the attributes it matched, and the replacement for a DISCONTINUED SKU.
- [ ] The gate enforces the confident-match rule: a described line releases only when it cites a search that returned exactly one candidate; otherwise `LOW-CONF-sku` sends it to review.
- [ ] Units: a quantity not in whole selling units, or in a unit that is not the selling unit (boxes of a case of 10 boxes, single bags of a case of 500, a box of foil sold per roll), is proposed at its most plausible whole-selling-unit reading and flagged `UNIT-ambiguous`; the Draft reply asks the customer to confirm.
- [ ] A substitution Proposal keeps the requested case count, shows "Swapped in for …" with the old and new pack and price, and the reply states the difference.
- [ ] Draft replies are in the customer's language (E011 in Spanish).
- [ ] Tests with the fake model reproduce the expected outcomes for E002, E011, E019, E020 and E021.
