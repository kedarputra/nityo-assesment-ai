# 07 — Review a Proposal: approve, edit, override, reject, hold

**What to build:** A reviewer opens a Proposal that is waiting for them, sees why, and decides: approves it (with a note for each soft check), edits quantities and watches the checks re-run, rejects or holds it with a reason, undoes a release within 10 seconds, and marks the Draft reply ready.

**Repo:** harbor-point

**Blocked by:** 06 — [Tracer: run the agent on one email, and a clean order releases](06-tracer-run-the-agent-on-e001.md)

**Label:** sandcastle

**Status:** ready-for-agent

## Context

The map is [`map.md`](../map.md); words are defined in [`CONTEXT.md`](../../../CONTEXT.md); every screen follows [`DESIGN.md`](../../../DESIGN.md), whose living example is Variant A of [the prototype](../assets/prototype-review-ui.html). The business rules are in the [data pack README](../../../data/harbor_point_data_pack/README.md); the data pack is read-only.

- [Charting, approve, edit and override](../issues/01-charting-decisions.md#approve-edit-and-override):
  every approve or edit re-runs the checks; soft checks can be overridden with a required reason;
  hard rules (CREDIT_HOLD, over the credit limit, a DISCONTINUED SKU, editing a SHIPPED order) can
  only be rejected or held.
- What a person may edit: [What the ops review UI looks like](../issues/02-review-ui-prototype.md#answer)
  (quantity, SKU through product search, add or remove a line, ship-to among the customer's own;
  never price or customer).
- Interaction and words: `DESIGN.md` ("Why it's waiting for you", inline reasons with Enter and
  Esc, the toast with Undo, `j`/`k`/`a`/`r`/`h` on desk, the sticky action bar on phones).
- Demo emails (scripted fake model): E019 (product swap, soft), E007 (CREDIT_HOLD and over limit,
  hard), E012 (instruction to the system inside the email, soft flag, policy 11).

## Acceptance criteria

- [ ] Approve re-runs the gate; it refuses while a soft check has no note (inline message, focus moves to the note); with notes it releases in one transaction and records each override and the approval with the user.
- [ ] Editing a quantity, SKU, line or ship-to re-runs the checks immediately and records the edit; price and customer are not editable.
- [ ] A Proposal failing a hard rule offers only Put on hold… and Reject…; approve is not offered and the server refuses it if called directly.
- [ ] Reject and hold ask for a reason inline (never a browser prompt), require it, and record it.
- [ ] After approving, a toast says what was released and how many are left, and Undo within 10 seconds withdraws the release (stock returned, audit event written); after 10 seconds it is final.
- [ ] The Draft reply is editable and "Mark reply ready" locks it and records who; it is never sent.
- [ ] Selection moves to the next email that needs you after a decision; keyboard shortcuts work on desk and are never intercepted while typing.
- [ ] Tests with the fake model cover E019, E007 and E012 end to end, including the server refusing an override of a hard rule.
