# 03 — Walk the 40 emails through the locked policies

**Type:** task (AFK)

**Blocked by:** none

**Status:** open

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
