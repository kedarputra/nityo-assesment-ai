# Domain Docs

How the engineering skills should consume this repository's domain documentation.

This repository is **single-context**: one glossary and one set of decisions, for the order-to-cash
domain of Harbor Point Supply Co.

## Before exploring, read these

- **`CONTEXT.md`** at the root: the glossary.
- **`docs/adr/`**: architecture and product decisions.
- **`data/harbor_point_data_pack/README.md`**: the business rules the brief says we can rely on.
  Its words (`sell_uom`, `CREDIT_HOLD`, `PARTIALLY_SHIPPED`, `replaced_by`) are the ERP's own, so
  use them as written.

If `CONTEXT.md` or `docs/adr/` do not exist, **proceed silently**. The `/domain-modeling` skill
(reached through `/grill-with-docs` and `/improve-codebase-architecture`) creates them when terms or
decisions are resolved.

## Use the glossary's vocabulary

When your output names a domain concept (a ticket title, a tool name, a test name), use the term
as `CONTEXT.md` defines it. If the concept is not in the glossary yet, either you are inventing
language the project does not use, or there is a real gap to note for `/domain-modeling`.

## Flag ADR conflicts

If your output contradicts an existing ADR, say so explicitly rather than silently overriding:

> *Contradicts ADR-0003 (the agent never releases an order) — but worth reopening because…*
