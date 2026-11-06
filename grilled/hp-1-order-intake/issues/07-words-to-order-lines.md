# 07 — How the agent turns a customer's words into order lines

**Type:** grilling

**Blocked by:** 03 — [Walk the 40 emails through the locked policies](03-per-email-walkthrough.md)

**Status:** closed — resolved by Kedar Putra (recommended options, standing instruction), 2026-11-06 21:23 WIB

## Question

When does a line written in words count as a confident match that the agent may release, and how
does it read units, substitutions, "the usual" and dates? Five open cases from [the walkthrough](../assets/per-email-expected-outcomes.md), each with its
facts, options and a recommendation in its "Cases no policy covers" section:

- **U18. "High confidence" for words.** E002, E005, E011, E031, E034, E039 and E040 name products
  in words, not SKUs. Requiring SKU codes would cut releases from 10 to 4. What counts as one
  confident match, and what is left to review?
- **U1. Quantities in the wrong unit.** "6 boxes" of gloves sold in cases of 10 boxes (E026),
  "5 kraft bags" (E037), "a box of foil" sold per roll (E010). Convert, round, or ask?
- **U9. Substitutions that change more than the SKU.** Vinyl at $45 → nitrile at $68 (E019); a
  4 × 1 gal case → a 4 × 2.5 L case (E020). Keep the case count, or convert the volume?
- **U14. "The usual"** when the last orders differ (E036: napkins appear in only one of them).
- **U11. Relative dates.** On Mon 2 Nov, is "next Tuesday" 3 Nov or 10 Nov (E024)? The same goes for
  every weekday name.

Each answer becomes a rule in the agent's prompt or tools, a check in the release gate, and an
expected outcome in the evaluation set.

## Answer

Each case takes the recommendation in [the walkthrough](../assets/per-email-expected-outcomes.md), under the developer's standing instruction.

- **U18. A confident match.** A line written in words is confident when exactly one ACTIVE SKU
  remains after the stated attributes (size, colour, material, type) are applied, and the quantity
  is in whole selling units.
  - **Checked in code:** the gate requires the line to cite a `search_products` call that returned
    exactly one candidate under those attributes. Anything else is `LOW-CONF-sku`, a soft check.
  - **The effect:** E002, E011, E031, E034, E039 and E040 can release without SKU codes. Requiring
    SKU codes would cut releases from 10 to 4.
- **U1. Units.** When the stated unit isn't the selling unit, or the quantity isn't whole selling
  units, the agent proposes its most plausible reading in whole selling units, flagged
  `UNIT-ambiguous` (soft), and the Draft reply asks the customer to confirm:
  - E026: "6 boxes" of gloves becomes 6 cases, to be confirmed;
  - E037: "5 kraft bags" becomes 5 cases, to be confirmed;
  - E010: "a box of foil" becomes 1 roll (EA).
- **U9. Substitutions.** The Proposal keeps the case count the customer asked for. The Proposal
  and the Draft reply both state the pack and price difference: E020's 4 × 1 gal → 4 × 2.5 L,
  and E019's $45 → $68 a case.
- **U14. "The usual."** It means the lines common to the customer's recent orders. Lines that
  appear in only some of them are offered in the Draft reply. For E036, that is the three common
  lines, with the napkins offered.
- **U11. Dates.**
  - **A bare weekday** is its next occurrence after Mon 2 Nov: Wednesday = 4 Nov, Thursday =
    5 Nov, Friday = 6 Nov, Saturday = 7 Nov.
  - **"Today"** is 2 Nov.
  - **"Next <weekday>"** is ambiguous. Both dates are recorded, it is flagged `DATE-ambiguous`
    (soft), and the Draft reply asks. E024's "next Tuesday" could be 3 Nov or 10 Nov.
