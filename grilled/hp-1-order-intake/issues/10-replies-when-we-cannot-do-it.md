# 10 — What the agent tells a customer when it can't do what was asked

**Type:** grilling

**Blocked by:** 03 — [Walk the 40 emails through the locked policies](03-per-email-walkthrough.md)

**Status:** closed — resolved by Kedar Putra (recommended options, standing instruction), 2026-11-06 21:23 WIB

## Question

What do the Draft replies say, and when is one drafted at all? Four open cases from [the walkthrough](../assets/per-email-expected-outcomes.md):

- **U13. Confirmations.** Does every released order get a confirmation Draft reply (policy 10's
  Spanish reply for E011 implies so)? Does a duplicate (E016) get an acknowledgment?
- **U3. No quantities and no history.** E022 asks for "some more" bags and disinfectant, with
  $500 of credit headroom. Is that a Proposal without quantities, or routed with a clarifying
  question?
- **U10. A date stock cannot meet.** E008 needs 15 cases of cups by Fri 6 Nov; there are 0 and the
  next delivery is 13 Nov. Neither a partial shipment nor a backorder works. What is offered?
- **U12. An inquiry about an order that doesn't exist.** E027 complains that their "last order
  never came", but C014 has no sales orders at all.

The answers set the reply templates and the tone, which must match the voice guide in
[`DESIGN.md`](../../../DESIGN.md).

## Answer

Each case takes the recommendation in [the walkthrough](../assets/per-email-expected-outcomes.md), under the developer's standing instruction. Every reply
follows the voice guide in [`DESIGN.md`](../../../DESIGN.md): short, plain and warm, saying what
happens next.

- **U13. Confirmations.** Every released order gets a confirmation Draft reply (order number,
  lines, total, delivery date), in the customer's language (policy 10). A duplicate (E016) gets
  none, because the original's confirmation answers "did the first one come through?".
- **U3. No quantities, no history.** E022 is routed with a clarifying Draft reply that names the
  products the agent understood and asks how many. The agent never invents a quantity.
- **U10. A date stock cannot meet.** The Proposal shows the date conflict (`DATE-unmeetable`,
  soft) beside three choices: a partial shipment, a backorder, or decline. The Draft reply states
  the earliest date we can deliver and asks. For E008: none in stock now, 100 due on 13 Nov,
  after their 7 Nov event.
- **U12. An inquiry about an order we can't find.** E027 is routed with an honest Draft reply: no
  recent order is on file. It asks for the order date or PO, and mentions that the account is on
  hold. The reply is written for a person to send after speaking to accounts.
