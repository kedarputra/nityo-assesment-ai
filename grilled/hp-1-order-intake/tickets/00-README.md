# hp-1 — Order intake: the build, slice by slice

Implementation tickets written by `/to-tickets` from [the map](../map.md), once every decision ticket
in [`issues/`](../issues/) was closed. Each is a tracer-bullet vertical slice, labelled `sandcastle`;
sandcastle runs a ticket once every ticket in its **Blocked by** line is closed.

```text
01 scaffold ─┬─ 02 data load ─┬─ 04 inbox ──┐
             │                ├─ 05 rules ──┴─ 06 tracer (E001) ─┬─ 07 review ─┬─ 11 changes & cancels
             │                │                                  │             ├─ 12 sender trust & links
             └─ 03 sign-in ───┤                                  │             └─ 13 inbox run & reset
                              │                                  ├─ 08 words & units
                              │                                  ├─ 09 dates, history, prices, stock
                              │                                  ├─ 10 routed & no action
                              │                                  ├─ 14 headers, audit role, logs
                              │                                  └─ 15 eval script
                              └─ 16 deploy config ─ 17 connect services (human)
```

| # | Ticket | Blocked by |
| --- | --- | --- |
| 01 | [Scaffold the app and its checks](01-scaffold-app-and-checks.md) | — |
| 02 | [Load the data pack into the database as the Snapshot](02-load-the-data-pack.md) | 01 |
| 03 | [Sign-in, sessions and roles](03-sign-in-sessions-and-roles.md) | 01 |
| 04 | [The inbox, read-only](04-the-inbox-read-only.md) | 02, 03 |
| 05 | [Business rules as code](05-business-rules-as-code.md) | 02 |
| 06 | [Tracer: run the agent on one email, and a clean order releases](06-tracer-run-the-agent-on-e001.md) | 04, 05 |
| 07 | [Review a Proposal: approve, edit, override, reject, hold](07-review-a-proposal.md) | 06 |
| 08 | [Products described in words, and units](08-products-described-in-words-and-units.md) | 06 |
| 09 | [Dates, history, price claims and short stock](09-dates-history-price-claims-short-stock.md) | 06 |
| 10 | [Requests that are routed or need no action](10-routed-and-no-action-requests.md) | 06 |
| 11 | [Order changes and cancellations](11-order-changes-and-cancellations.md) | 07 |
| 12 | [Sender trust, split deliveries and linked emails](12-sender-trust-split-deliveries-linked-emails.md) | 07 |
| 13 | [Inbox run, reset and the admin controls](13-inbox-run-reset-admin-controls.md) | 07 |
| 14 | [Security headers, an append-only audit role, and structured logs](14-security-headers-audit-role-structured-logs.md) | 06 |
| 15 | [The eval script](15-the-eval-script.md) | 06 |
| 16 | [Deploy configuration and docs](16-deploy-configuration-and-docs.md) | 02, 03 |
| 17 | [Connect Vercel, Neon and Anthropic](17-connect-vercel-neon-anthropic.md) | 16 |
