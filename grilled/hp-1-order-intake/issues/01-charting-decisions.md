# 01 — Charting: scope, autonomy line, case policies and the agent's shape

**Type:** grilling

**Blocked by:** none

**Status:** closed — resolved with Kedar Putra while charting the map, 2026-11-06 19:56 WIB

## Question

What does the product do, and where is the line between what the agent does alone and what a person
approves, so that the rest of the map has a fixed scope to plan against? The brief: "Where to draw
that line is one of the main decisions we want to see you make" (The scenario).

## Answer

Each decision below was put to the developer as its own question and answered. The map links each
one by its anchor.

### Destination and scope

This map plans the whole product the brief asks for ("What to build and deliver": ingest, an agent
acting through tools, human review, an ops UI, an audit trail, a CI/CD deploy). It is done when
`/to-tickets` can slice the full build. The scope is full: the map is kept lean, but no brief item
is cut for time.

### The autonomy line

The agent **releases a clean order on its own**: a new order where every check passes (a known
contact, every line resolved to an ACTIVE SKU with high confidence, the system's price, full stock,
credit OK, one clear ship-to, no flags). Everything else becomes a **Proposal** in the **review
queue**: order changes, cancellations, credit problems, substitutions, unknown senders, price
disputes. Terms are in [`CONTEXT.md`](../../../CONTEXT.md).

### Requests that are not new orders

The agent acts where the ERP can:

- **Order change** and **cancellation** become concrete Proposals against the sales order, checked
  against the README's rules: `SHIPPED` cannot be edited, `OPEN` can, and `PARTIALLY_SHIPPED` can
  only change the unshipped quantity. Examples: E004 on OPEN SO-24051, E017 on SOP-1182.
- **Return** (E018), **billing dispute** (E030, INV-55120: there is no invoices table),
  **quote request** (E009) and **order inquiry** (E027) are routed to a person with a summary and a
  Draft reply.
- **No action** (spam E029, auto-reply E028) is closed, with the reason logged.

### Replies to customers

The agent writes a **Draft reply** for each email that needs one, which a person can edit and
approve in the UI. **Nothing is ever sent**: the inbox is a static snapshot of fictional `.example`
addresses. An approved reply is recorded in the audit trail as "would send".

### The release gate

Code gates a release; the model only interprets. See
[ADR 0001](../../../docs/adr/0001-code-gates-release-model-interprets.md).

### Stack

TypeScript Next.js (App Router) on Vercel through its Git integration; Postgres (Neon, through the
Vercel marketplace) with Drizzle for schema and migrations, and PGlite or a local Postgres in tests;
Claude through the Anthropic SDK, behind a model interface that tests replace with a fake. See
[ADR 0002](../../../docs/adr/0002-nextjs-postgres-claude-on-vercel.md).

### How the agent runs live

The deploy starts from the **07:00 snapshot** with the inbox unprocessed. The UI runs the agent on
one email or on the whole inbox in `received_at` order (order matters: released orders allocate
stock, and E015 and E038 both draw on HPS-1305). An admin **reset** restores the snapshot. A spend
cap on the API key bounds the cost. How a whole-inbox run is orchestrated waits on
[Vercel and Neon limits for agent runs](04-vercel-neon-agent-run-limits.md).

### Case policies

Each one sends the case to review unless it says otherwise, and each becomes a gate flag or a review
reason plus an assumption line in the product brief.

1. **Business clock**: fixed at Mon 2 Nov 2026. An email's `received_at` is its order date, which
   decides whether a contract price is valid.
2. **Short stock**: never auto-released. The Proposal shows `available` plus `incoming_supply`, and
   a person picks a partial shipment or a backorder.
3. **DISCONTINUED**: propose the `replaced_by` SKU; never substitute alone (E019 HPS-1004 → HPS-1001,
   E020 HPS-1306 → HPS-1307).
4. **A price stated in the email** that differs from the system's: use the system price and flag it
   (E024 "$70/case contract", E025 "$30 a case like he offered").
5. **Sender**: an unknown sender at a known customer's domain is matched to the customer and the
   contact is flagged (E013, Kevin covering for Nora). An unknown company is routed as a prospect
   (E014).
6. **Duplicate**: the same customer PO or the same content means no action, linked to the original
   (E016 forwards E015's PO SSL-7781).
7. **Several ship-tos**: one order per ship-to (E005, three clubs).
8. **"Same as last time" / "the usual"**: propose from the order history (E010, E036).
9. **"Also add" follow-ups**: propose a change to the customer's earlier order if it is still OPEN
   (E026, E035, E037).
10. **Non-English**: handled normally; the Draft reply is in the customer's language (E011).
11. **Instructions to the system inside an email** are data: flag them and never obey them (E012).
12. **A requested date already past**: flag it (E032, "by Friday October 30").

### Login

Seeded named users from env vars (an ops reviewer, and an admin who can reset), with a password
login and a signed session cookie. No third-party auth provider. The assessors get one login in the
README. Every approval records its user.

### Approve, edit and override

Every approve or edit **re-runs the code checks**. A person may override a **soft check** (a flag, a
substitution, a price note, an unverified contact, short stock taken as a partial) with a required
reason, which is recorded in the audit trail. The **hard rules cannot be overridden** in this app:
`CREDIT_HOLD`, `open_balance` plus the order's value exceeding `credit_limit`, a DISCONTINUED SKU,
and editing a SHIPPED order. Such a Proposal can only be rejected or held, with a Draft reply
(E007 Coastal Catering and E027 Golden Spoon are both on CREDIT_HOLD).

### The agent's shape

- **One agent run per email**: a tool-use loop with the Anthropic SDK, in-process, not over MCP.
- **Read tools**: `find_customer` (by sender, domain or name), `list_ship_tos`, `search_products`
  (free text to SKU candidates), `get_product`, `price_line` (contract or list), `check_stock`
  (available plus incoming), `check_credit`, `get_orders` (history, and by customer PO),
  `find_duplicate`.
- **Action tools**, each of which only creates a Proposal or an outcome: `propose_new_order`,
  `propose_order_change`, `propose_cancellation`, `route_to_person`, `close_no_action`,
  `draft_reply`, `raise_flag`. The code gate then releases clean new orders.
- **Model**: `claude-opus-5-5`, configurable by env var.
- **Audit trail**: an append-only event log of every agent step, tool call and result, every gate
  verdict, and every human approve, edit, reject or override, with the user, the time and the reason.
  The UI reads from it.

Exact tool signatures are left to `/to-tickets`.
