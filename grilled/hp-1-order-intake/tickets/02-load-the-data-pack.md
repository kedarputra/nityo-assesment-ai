# 02 — Load the data pack into the database as the Snapshot

**What to build:** The ERP tables and the 40 emails exist in Postgres with real types, loaded from the data pack by one ingest that also powers the Reset, so every later ticket reads real Harbor Point data.

**Repo:** harbor-point

**Blocked by:** 01 — [Scaffold the app and its checks](01-scaffold-app-and-checks.md)

**Label:** sandcastle

**Status:** closed — resolved 2026-11-06 21:55 WIB by sandcastle

## Context

The map is [`map.md`](../map.md); words are defined in [`CONTEXT.md`](../../../CONTEXT.md); every screen follows [`DESIGN.md`](../../../DESIGN.md), whose living example is Variant A of [the prototype](../assets/prototype-review-ui.html). The business rules are in the [data pack README](../../../data/harbor_point_data_pack/README.md); the data pack is read-only.

- Terms: Snapshot and Reset in `CONTEXT.md`; the reset design is
  [How a whole-inbox run is driven and how the snapshot is reset](../issues/05-inbox-run-and-reset.md#answer),
  item 3 (truncate and reseed in one transaction; the seed is the same ingest).
- The data notes in [the walkthrough](../assets/per-email-expected-outcomes.md#data-notes): every
  column is TEXT; money carries cents (48.60, 34.20, 35.10) and must be integer cents or a decimal,
  never a float; `available = on_hand - allocated` holds for all 30 SKUs; no email has an
  attachment; `emails.jsonl` is in `received_at` order but ids are not (E033 before E017).
- Read the pack from `erp.sqlite` or the CSVs (they are identical) and `emails.jsonl`. Never write to
  the pack.

## Acceptance criteria

- [ ] Tables for customers, contacts, ship-to addresses, products, contract prices, inventory, incoming supply, sales orders and their lines, and emails, with typed columns: money in integer cents (or a decimal type), dates as dates, quantities as integers, statuses as constrained values.
- [ ] An ingest function loads the whole pack into an empty database; a Reset function truncates every app table and reloads the Snapshot in one transaction; both are runnable from a package script and from tests.
- [ ] Tests on the in-process database assert: 20 customers, 22 contacts, 23 ship-tos, 30 products, 8 contract prices, 30 inventory rows, 2 incoming supplies, 9 sales orders, 24 order lines and 40 emails; C007's HPS-1201 contract price is 3510 cents valid 2026-07-01 to 2027-06-30; HPS-1004 is DISCONTINUED with replaced_by HPS-1001; HPS-1409 and HPS-1410 sell per EA; E011's body is stored intact.
- [ ] A test proves Reset restores the Snapshot after rows were changed, and that it is one transaction (a failure part-way leaves the previous data).
- [ ] No business rule lives here: no prices are computed and no status is interpreted.
