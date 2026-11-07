# Product brief: Harbor Point order desk

## The user and the problem

The user is the **operations team at Harbor Point Supply Co.**, the people who turn customer emails
into sales orders. Every morning they read an inbox of orders in every shape: SKU lists, pasted
spreadsheets, free text, forwards, Spanish, one-line phone messages. For each email they work out
who the customer is and what they want. They check stock, contract prices and credit, then retype
the order into the ERP. Most of their day goes on reading and typing. The judgement calls get the
leftover attention: a customer on credit hold, a discontinued product, a sender nobody knows.

## What I built

An **order desk where an AI agent does the reading and the ERP work, and a person makes the risky
calls.**

- **Ingest.** The data pack (the ERP at 07:00 on Mon 2 Nov 2026, and the 40 emails) loads into the
  app's own Postgres. Every change the agent or a person makes lands there. The pack itself is never
  edited.
- **An agent that works through tools.** There is one run per email: a tool-use loop over 20 tools,
  such as `find_customer`, `search_products`, `price_line`, `check_stock`, `check_credit`,
  `get_orders`, `find_duplicate`, `propose_new_order`, `propose_order_change`, `route_to_person` and
  `draft_reply`.
  - It decides what kind of request the email is and what should happen next.
  - It records everything it concludes as a **Proposal**, a routing, or "no action".
- **A release gate in code.** The model only interprets; code decides what may be released. A new
  order is released only when every one of 15 checks passes (ADR 0001).
- **A review desk** (inbox, the email, and the agent's Proposal side by side).
  - A person sees why each Proposal is waiting, blockers first.
  - They can edit quantities, products, lines and ship-to, then approve, hold or reject.
  - A release can be undone for 10 seconds.
  - Draft replies are edited and approved here.
- **An audit log.** Every agent step, tool call, gate verdict and human decision is recorded, with
  who, when and why. The database enforces append-only.
- **CI/CD.** GitHub Actions runs lint, typecheck, 447 tests, the build and an audit on every pull
  request. A push to `main` deploys to Vercel. No test calls a paid model.

## What I chose not to build

- **Sending email.** Replies are drafted and approved, but never sent. The inbox is a fixed
  snapshot of fictional addresses.
- **Quotes, returns, credits and invoices.** The ERP has no data for them, so those emails are
  routed to a person with a summary and a draft reply.
- **Live mailbox polling, SSO and an MCP server.** None changes what the brief asks the agent to
  decide. The tools run in-process.
- **Bulk approve.** Each risky decision is made one email at a time, on purpose.

## The line: what the agent does alone, and what needs a person

| The agent does it alone | It waits for a person |
| --- | --- |
| **Releases a new order** when every check passes: a known contact, every line resolved to exactly one ACTIVE SKU, whole selling units, the system's price, full stock, credit within limit, one clear ship-to, a clear date, no flags | **Any failed check.** Soft checks (an unknown contact, a substitution, an odd unit, a price the customer claimed, short stock) can be overridden **with a written reason**. |
| **Closes spam and auto-replies** as "no action", with the reason logged | **Hard rules** can only be held or rejected, never overridden: credit hold, over the credit limit, a discontinued SKU, an edit to a shipped order |
| **Drafts** a reply for every email that needs one | **Order changes and cancellations**: always a Proposal against the existing sales order |
| **Links** emails that belong together (a forwarded PO, an "also add") | **Returns, invoices, quotes and inquiries**: routed with a summary |
| | **Sending** any reply: approved by a person, recorded as "would send" |

The line follows the cost of a mistake. A clean order the agent gets right saves typing. A wrong
release costs stock, credit and the customer's trust. So only orders the code can fully verify are
released alone, and everything else goes to the desk with its reason. On the 40 emails the
walkthrough expects 9 releases, 22 Proposals, 6 routed and 3 no action.

## How I would measure success in production

1. **Safety (first):** releases later corrected because the agent was wrong (edited, cancelled or
   credited). The target is near 0. The gate is loosened only where this stays near 0.
2. **Automation:** the share of emails handled with no person (released or no action), per week.
3. **Review quality:**
   - the share of Proposals approved with no edit;
   - the override rate per soft check (a check that is always overridden is miscalibrated);
   - the median time a person spends per email.
4. **Speed for the customer:** the time from email received to order in the ERP, at the median
   and p90.
5. **Cost:** the model cost per email.

Before production, `make eval` replays the 40 emails three times against the expected outcomes.
It reports unsafe releases first, then outcome, line and review-reason accuracy. The results are in
[`docs/results.md`](results.md).

## Assumptions

1. **The business clock is fixed at Mon 2 Nov 2026.** An email's received time is its order date.
   That date decides contract-price validity and what "Wednesday" means.
2. **Short stock is never released alone.** The desk shows available plus incoming stock, and a
   person picks a partial shipment or a backorder.
3. **A discontinued SKU is never swapped silently.** The agent proposes `replaced_by` with the case
   count kept, and states the pack and price difference.
4. **A price stated in an email is not trusted.** The system price is used and the claim is flagged
   (E024, E025).
5. **The verified address wins.** An unknown sender at a known customer's domain is matched and
   flagged (E013). Domain matching counts only when one customer owns the domain, since `mail.example`
   is shared.
6. **Credit counts `open_balance` + orders released earlier the same day + this order.** Existing
   OPEN orders are not added, because `open_balance` may already include them.
7. **A line written in words is confident only when exactly one ACTIVE SKU fits** its stated
   attributes, checked in code. Odd units are converted to whole selling units, flagged, and
   confirmed in the reply.
8. **A duplicate PO or repeated content means no action**, linked to the original (E016 → E015).
9. **Instructions to the system inside an email are data.** They are flagged and never obeyed (E012).
10. **One order per ship-to** when one email orders for several sites (E005).
11. **"The usual" and "also add"** are proposed from order history, or as a change to a still-OPEN
    order. They are never released alone.
12. **Replies are written in the customer's language** (E011 is in Spanish).
13. **Runs are on demand.** The deploy starts at the 07:00 snapshot. A person runs the agent per
    email, or an admin runs the inbox in received order, because stock allocation depends on order.
    An admin can reset to 07:00.
14. **The live demo's model is Gemini's free tier** (`gemini-3.5-flash-lite`), so the demo costs
    nothing. The agent sits behind a model interface: Claude is the planned model and needs only an
    API key. The free tier is slower and rate-limited, and [`docs/results.md`](results.md) reports
    what that changed.
