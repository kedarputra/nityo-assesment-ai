# 03 — Walk the 40 emails through the locked policies

**Type:** task (AFK)

**Blocked by:** none

**Status:** closed — resolved by a subagent, checked by Claude with Kedar Putra, 2026-11-06 21:20 WIB

## Question

For each of the 40 emails in `data/harbor_point_data_pack/emails.jsonl`, what outcome do the
decisions in [the charting decisions](01-charting-decisions.md) give, and which emails raise a case
that no decision covers? The brief warns: "Expect to find problems we have deliberately not listed
for you."

For each email, record: the Request kinds; the customer, contact and ship-to it resolves to (from
the ERP rows); each line's SKU, quantity, price (contract or list, as of 2026-11-02), stock and
credit result; the expected outcome (released / Proposal in review / routed / no action) with its
flags and the policy number behind each; and whether a Draft reply is needed. Process the emails in
`received_at` order and carry each release's stock allocation forward.

Already noticed, to be checked: E033 arrives before E017 but refers to "the PO I'm cancelling";
E034 forwards Matt's list "except skip the towels"; E036 "the usual"; E023 says "see the attached
PO" (check whether it has an attachment); E021 and E039 for known contacts; HPS-1305 being shared by
E015 and E038.

**Deliverable:** `../assets/per-email-expected-outcomes.md`, linked from here. It is also the eval
set the results script will score against. **Resolved when** it exists and its "cases no policy
covers" list has been turned into new decision tickets or added to the map's fog.

## Answer

**Deliverable:** [`per-email-expected-outcomes.md`](../assets/per-email-expected-outcomes.md).
It has a summary table, one section per email in `received_at` order, stock carried across the
run, "Cases no policy covers" (U1–U18), data notes, and an "Eval lines" CSV of the expected order
lines for the scoring script. Every price, stock and credit figure was computed from `erp.sqlite`.
Claude recomputed E003, E006, E011, E015, E024, E027, E038 and E040 independently; all match.

**Outcomes, by each email's primary result:**
- **Released, 10:** E001, E002, E003, E011, E015, E031, E034, E038, E039, E040.
- **Proposal, 21:** E005 is three of them. E006, E007 and E027 are hard-rule Proposals, so they
  can only be rejected or held.
- **Routed, 6:** E009, E014, E018, E022, E023, E030. E027 also carries a routed inquiry.
- **No action, 3:** E016 (a duplicate of E015), E028 (an auto-reply), E029 (spam).

Seven emails have an "also acceptable" outcome while their uncovered case is open. Taking any of
them changes no later email's stock or credit result.

**What the run depends on:**
- **No outcome depends on processing order.** The only real stock limits are HPS-1405 (0
  available) and HPS-1302 (5 available). HPS-1305, which E015 and E038 share, is never tight.
- **Data notes for the ingest:**
  - Order history is partial: 12 of 20 customers have balances but no orders.
  - SO-24052's unshipped lines are past their date.
  - Greenleaf's (C002) HPS-1403 contract expired on 30 Sep.
  - There are no invoice or return tables, and no email has an attachment.

**The 18 uncovered cases became four decision tickets:**
- [How the agent turns a customer's words into order lines](07-words-to-order-lines.md): U18, U1,
  U9, U14 and U11.
- [How the agent links emails that belong together](08-emails-that-belong-together.md): U2, U4,
  U5, U6, U8 and U17.
- [Who the sender is, and what the credit check counts](09-sender-identity-and-credit.md): U7,
  U16 and U15.
- [What the agent tells a customer when it can't do what was asked](10-replies-when-we-cannot-do-it.md):
  U13, U3, U10 and U12.

The expected outcomes follow the locked decisions as written. When a ticket above changes a rule,
update the matching rows and the CSV in the same change.
