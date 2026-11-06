# 02 — What the ops review UI looks like

**Type:** prototype

**Blocked by:** none

**Status:** closed — resolved by Kedar Putra (recommended option, standing instruction), 2026-11-06 20:18 WIB

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

## Answer

**Prototype:** [`prototype-review-ui.html`](../assets/prototype-review-ui.html). Open it in a browser
and switch variants with `?variant=A|B|C`, the bottom bar, or the ← → keys. It runs six real emails
(E001, E005, E007, E012, E019, E029) over data-pack rows, in memory. Approve, edit, reject, hold,
override and approve-reply all work and write to the audit log.

| Variant | Shape | Screenshot |
| --- | --- | --- |
| A, three-pane inbox | an email list, then the email with the agent's reasoning and steps, then the Proposal with its checks, lines, actions and Draft reply | [A](../assets/review-ui-variant-a-three-pane-inbox.png) |
| B, one decision at a time | a queue of the emails that need a person: a one-sentence headline, "what stops it" first, then the lines and big buttons; handled emails listed below | [B](../assets/review-ui-variant-b-one-decision-at-a-time.png) |
| C, ledger table | one dense row per email with check columns, rows that expand, bulk approval with a shared reason, and the audit log in a drawer | [C](../assets/review-ui-variant-c-ledger-table.png) |

**Verdict: build Variant A, with two pieces taken from B.** This was the recommended option, taken
under the developer's standing instruction to choose the recommendation (2026-11-06); the developer
can overrule it.

- **A's three panes are the base.** They put the brief's three needs side by side for every email:
  "what the agent did" (the agent's steps), "why" (its reasoning, next to the original email), and
  "approve, edit or reject" (the Proposal). The unit of work is one Email, as the ops team already
  thinks of it, and the list keeps the whole day visible, released and no-action emails included.
- **From B, the blockers come first.** The Proposal panel opens with only the failing checks: each
  soft check has its override-reason field, each hard rule shows a lock and offers only Reject or
  Hold. Passing checks fold into "N checks pass".
- **From B, the headline.** A one-sentence summary heads the Proposal, e.g. "Release 3 orders for
  Metro Fitness Clubs, $999.50".
- **Not C's bulk approval.** One reason pasted over many overrides empties the audit trail of its
  per-case reasons, and the release gate exists so that each soft check gets looked at. C's
  check-icon columns are worth keeping as small badges on A's list rows, if room allows.
- **The audit log is its own page** (A's "Audit log" tab): who (the agent, the gate, or the named
  user), what, which email, and the detail, newest first.

**What a person can edit on a Proposal**, settled alongside the verdict on the same standing
instruction: a line's quantity, its SKU (picked through product search), adding or removing a line,
and the ship-to (from the customer's own ship-tos). The price and the customer cannot be edited:
the price is the system's (policy 4), and a different customer is a different email's problem.
Every edit re-runs the gate, as the prototype shows: raising a Metro Fitness line to 40 fails Full
stock across the split orders.

**Other request kinds use the same Proposal panel.** An order change or cancellation shows the
existing sales order's lines as before → after, with the README's edit rule for its status. A
routed request (return, billing dispute, quote, order inquiry) shows its summary and the Draft
reply, with no lines and no gate.

**Design pass, 2026-11-06.** After the verdict, the developer ran `/desain` over this prototype. The
result is [`DESIGN.md`](../../../DESIGN.md) at the repository root: the design standard for every
screen. The prototype was rebuilt on it: Variant A carries the verdict above, with reasons typed
inline instead of in a browser prompt, a 10-second Undo after approval, keyboard keys, and E012's
injected passage outlined in the email. The screenshots above show the result.

**Second design pass, 2026-11-06: friendlier and responsive.** The developer asked, through
`/desain`, for a more user-friendly desk with a pleasant tone that works on every screen.
[`DESIGN.md`](../../../DESIGN.md) is now version 2:
- **Look:** a warm cream page with white cards, softer corners, sender avatars, Plus Jakarta Sans,
  and a "sun" highlight for good news.
- **Voice:** a voice guide ("Needs you", "Why it's waiting for you", "Add a quick note about why
  it's OK…"), a greeting and progress card, a dismissible tip, and an all-clear state.
- **Layouts:** list → detail on a phone, with a sticky action bar and line cards; two panes on a
  tablet; three on a desk.

The decisions above are unchanged. Screenshots of the chosen design at each width:
[tablet](../assets/review-ui-a-tablet.png), [phone list](../assets/review-ui-a-phone-list.png),
[phone detail](../assets/review-ui-a-phone-detail.png).

**Left to the build.** Where the "run one / run all / reset" controls sit, which waits on
[How a whole-inbox run is driven and how the snapshot is reset](05-inbox-run-and-reset.md).
