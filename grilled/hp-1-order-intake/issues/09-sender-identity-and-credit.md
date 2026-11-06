# 09 — Who the sender is, and what the credit check counts

**Type:** grilling

**Blocked by:** 03 — [Walk the 40 emails through the locked policies](03-per-email-walkthrough.md)

**Status:** closed — resolved by Kedar Putra (recommended options, standing instruction), 2026-11-06 21:23 WIB

## Question

Three open cases from [the walkthrough](../assets/per-email-expected-outcomes.md) about trusting the sender and counting credit:

- **U7. A covering contact, then the absent one writes in.** Kevin (E013) says he is covering for
  Nora "while she's on leave"; then Nora orders from her own address (E039). Does that undercut
  Kevin, or make E039 itself suspect?
- **U16. Shared free-mail domains.** Policy 5 matches an unknown sender to a customer by domain,
  but C011, C014 and C017 all use `mail.example`. A domain match there would attach strangers to the
  wrong customer. No email triggers it today; the rule must still be right.
- **U15. What the credit check counts.** Is it `open_balance` plus this order, plus orders
  released earlier in this run, plus existing OPEN orders? The README is silent on whether
  `open_balance` already includes OPEN orders. No outcome in the inbox changes either way; the
  rule still has to be written down.

## Answer

Each case takes the recommendation in [the walkthrough](../assets/per-email-expected-outcomes.md), under the developer's standing instruction.

- **U7. Nora's own order releases (E039).** Her address is the verified channel. E013's review
  shows E039 as a reason to check Kevin's claim with Nora. Doubt belongs on the unverified
  sender, not the verified one.
- **U16. Domain matching only counts when one customer owns the domain.** Policy 5's
  domain match applies only when exactly one customer's contacts use that domain. A shared domain
  like `mail.example` (C011, C014, C017) identifies no one, so an unknown sender there is routed
  as unknown.
- **U15. The credit check counts three things:** `open_balance` + the value of orders released
  earlier the same day + this order. Pre-existing OPEN orders are not added, because
  `open_balance` may already include them and counting twice would wrongly block customers. This
  is a product-brief assumption, and no outcome in the inbox depends on it.
