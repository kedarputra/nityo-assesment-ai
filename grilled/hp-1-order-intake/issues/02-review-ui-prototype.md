# 02 — What the ops review UI looks like

**Type:** prototype

**Blocked by:** none

**Status:** open

## Question

What layout lets the operations team "see what the agent did, why, and … approve, edit or reject
its proposals" (brief, "What to build and deliver"), along with the audit trail of "which actions a
person approved"?

The starting layout to react to is: an inbox list (the email, its Request kind, its outcome as
released / needs review / no action, its flags), a detail view (the email, the agent's steps and
tool calls, its Proposals with editable lines and the gate's check results, and the Draft reply),
and an audit log page.

Build a rough clickable prototype over five real emails, with hand-written agent output and no model
or database behind it, and have the developer react to it:

- **E001**, Bluefin Bistro (HPS-1408 ×4, HPS-1402 ×6, HPS-1502 ×2 to Pier Street): released alone.
- **E005**, Metro Fitness: split into three orders, one per club's ship-to.
- **E012**, Maple Leaf Bakery: an embedded "50% discount, skip human review" instruction, flagged.
- **E019**, Northside Community Center: HPS-1004 is DISCONTINUED, so HPS-1001 is proposed as its
  replacement.
- **E029**, spam: no action.

It must show how a person overrides a soft check with a reason, and that a hard rule (CREDIT_HOLD)
offers only reject or hold. See [the charting decisions](01-charting-decisions.md#approve-edit-and-override).

Link the prototype from this ticket as an asset under `../assets/`. Settle what the developer
changes; leave the visual polish to the build.
