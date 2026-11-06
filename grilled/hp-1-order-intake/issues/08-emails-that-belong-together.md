# 08 — How the agent links emails that belong together

**Type:** grilling

**Blocked by:** 03 — [Walk the 40 emails through the locked policies](03-per-email-walkthrough.md)

**Status:** closed — resolved by Kedar Putra (recommended options, standing instruction), 2026-11-06 21:23 WIB

## Question

Several emails only make sense next to another email. How does the agent find the related email,
and what does it do with it? Six open cases from [the walkthrough](../assets/per-email-expected-outcomes.md):

- **U2. A follow-up to a pending Proposal.** Policy 9 assumes the earlier order is OPEN, but
  E035 → E010, E037 → E012 and E026 → E002 follow up orders that may still be Proposals, or that
  were released earlier in the run.
- **U4. A missing attachment.** E023's PO HV-3405 has no attachment. E031, from the same contact
  to the same dock 58 minutes later, may be that PO. Should E031 still release on its own?
- **U5. A cancellation mentioned before it arrives.** E033 (08:36) mentions "the PO I'm
  cancelling" before E017 (08:37) cancels SOP-1182.
- **U6. A forwarded list with an exclusion.** E034 forwards Matt's Northgate list "except skip the
  towels", against E005's pending Northgate towels. Does E034 withdraw them, and does it release on
  its own?
- **U8. Policy 7 and policy 6's limits.** Is a split into one order per ship-to a review reason
  when each order is clean (E005)? What counts as "the same content" for a duplicate? E005 Downtown
  repeats the unshipped remainder of SO-24052; E003 and E038 are also near repeats.
- **U17. What an auto-reply tells us.** E028 says Karen is away until 9 Nov. Is that attached to
  her open Requests (E033, E017)?

The answer decides what the agent reads beyond the one email in front of it (the customer's other
emails today, their open Proposals and orders), and so what the "one run per email" in
[the agent's shape](01-charting-decisions.md#the-agents-shape) really means.

## Answer

Each case takes the recommendation in [the walkthrough](../assets/per-email-expected-outcomes.md), under the developer's standing instruction.

**What an Agent run reads.** Besides the email in front of it, an Agent run reads that customer's
other emails today and their open Proposals and sales orders, through the `get_orders` and
`find_duplicate` tools. It links what belongs together and never changes another email's
Proposal.

- **U2. A follow-up to a pending Proposal** becomes a separate new-order Proposal, linked to the
  pending one and shown beside it in the review queue. Proposals are never amended in place. When
  the earlier order is already OPEN, policy 9 applies as written: a change Proposal to that order.
- **U4. E031 becomes a Proposal**, flagged "possibly the PO HV-3405 that E023 said was attached".
  A duplicate shipment to a hotel costs more than one review. Both Draft replies ask Aisha. The
  [walkthrough](../assets/per-email-expected-outcomes.md) is updated: E031's expected outcome is
  now `proposal`.
- **U5. A cancellation needs an explicit target.** E033 is a new order only; its mention of
  "the PO I'm cancelling" is logged as a note, and E017's cancellation Proposal links back to it.
- **U6. E034 releases** its two clean lines (no towels). Its remark "skip the towels, we still
  have plenty" is attached to E005's Northgate Proposal for the reviewer. It is never applied to
  E005 automatically.
- **U8. Policy 7 stays a review reason** ("each one sends the case to review unless it says
  otherwise"). A duplicate (policy 6) means every line is identical, on the same day, or the same
  customer PO. A partial overlap with an open order's unshipped lines is shown as context on the
  Proposal, not as a flag. Example: E005 Downtown against SO-24052.
- **U17. An auto-reply's information is attached** to the sender's open Requests: E033 and E017
  get "contact away until 9 Nov; call the front desk for urgent matters". The auto-reply itself is
  still no action.
