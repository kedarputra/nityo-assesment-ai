# 12 — Sender trust, split deliveries and linked emails

**What to build:** The agent matches unknown senders safely, splits one email into one order per ship-to, and shows related emails beside each other so a reviewer sees the whole story.

**Repo:** harbor-point

**Blocked by:** 07 — [Review a Proposal: approve, edit, override, reject, hold](07-review-a-proposal.md)

**Label:** sandcastle

**Status:** ready-for-agent

## Context

The map is [`map.md`](../map.md); words are defined in [`CONTEXT.md`](../../../CONTEXT.md); every screen follows [`DESIGN.md`](../../../DESIGN.md), whose living example is Variant A of [the prototype](../assets/prototype-review-ui.html). The business rules are in the [data pack README](../../../data/harbor_point_data_pack/README.md); the data pack is read-only.

- Policy 5 and [ticket 09](../issues/09-sender-identity-and-credit.md#answer): an unknown sender at a
  domain owned by exactly one customer is matched and flagged `P5-unverified-contact`; a shared
  domain (`mail.example`: C011, C014, C017) identifies no one; U7 (Nora's own address wins; E039
  releases and is shown on E013's review).
- Policy 7 and [ticket 08](../issues/08-emails-that-belong-together.md#answer): one order per ship-to,
  still a review reason (U8); a partial overlap with an open order's unshipped lines is context, not
  a flag; U4 (E031 is a Proposal flagged `RELATED-E023`), U5 (E033's mention of a cancellation is a
  note; E017's Proposal links back), U6 (E034 releases; its "skip the towels" remark is attached to
  E005's Northgate Proposal). An Agent run reads the customer's other emails today and their open
  work; it never changes another email's Proposal.
- Expected ([the walkthrough](../assets/per-email-expected-outcomes.md)): E005 three Proposals
  (S006 $466.00, S007 $321.00, S008 $212.50); E013 Proposal (`P5`); E031 Proposal (`RELATED-E023`);
  E034 released (S008, $584.00); E039 released ($471.00).

## Acceptance criteria

- [ ] `find_customer` matches by exact address, then by a domain owned by exactly one customer (flagged `P5-unverified-contact`); a shared domain is treated as unknown.
- [ ] An email naming several ship-tos yields one Proposal per ship-to, flagged `P7-multi-ship-to`.
- [ ] A `find_duplicate` / related-email lookup returns the customer's other emails today and open Proposals and orders; links are stored and shown on both sides in the desk ("Related: …").
- [ ] Remarks and notes from one email attach to another's Proposal for the reviewer; no run ever edits another email's Proposal.
- [ ] Tests with the fake model reproduce the expected outcomes for E005, E013, E031, E033 (note), E034 and E039, and a stranger at `mail.example` is not matched to any customer.
