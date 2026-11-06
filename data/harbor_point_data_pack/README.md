# Harbor Point Supply Co. — data pack

Harbor Point Supply Co. is a fictional B2B distributor of cleaning, paper, glove and takeout supplies. Its customers are restaurants, hotels, schools, clinics and gyms. All companies, people and email addresses are invented; every email domain ends in `.example`.

This pack is a snapshot of the company's ERP data at **07:00 on Monday 2 November 2026**, plus the order inbox for that day.

## Contents

| Path | What it is |
|---|---|
| `erp.sqlite` | All tables below in one SQLite database (every column stored as TEXT, cast as you need) |
| `data/customers.csv` | Customers, payment terms, credit limit, open balance, status (`ACTIVE` or `CREDIT_HOLD`) |
| `data/customer_contacts.csv` | Known contacts and their email addresses |
| `data/ship_to_addresses.csv` | Delivery addresses; some customers have several |
| `data/products.csv` | Product catalog, selling unit, pack size, list price, status, replacement SKU |
| `data/customer_prices.csv` | Customer contract prices with validity dates |
| `data/inventory.csv` | Stock: `available = on_hand - allocated` |
| `data/incoming_supply.csv` | Supplier deliveries due in |
| `data/sales_orders.csv` | Existing sales orders and their status |
| `data/sales_order_lines.csv` | Lines for those orders, including quantity already shipped |
| `emails/*.eml` | 40 emails received by orders@harborpointsupply.example on 2 Nov 2026 |
| `emails.jsonl` | The same 40 emails as JSON lines, if you prefer not to parse .eml |

## Business rules you can rely on

- Prices are in USD per selling unit (`sell_uom`): `CS` = case, `EA` = each. Only whole selling units can be ordered.
- A valid contract price (order date within `valid_from`–`valid_to`) overrides the list price; otherwise list price applies.
- An order should not be released if the customer is on `CREDIT_HOLD`, or if `open_balance` plus the new order's value would exceed `credit_limit`.
- `DISCONTINUED` products cannot be sold; `replaced_by` names the successor.
- Orders with status `SHIPPED` cannot be edited. `OPEN` orders can. `PARTIALLY_SHIPPED` orders can only change the unshipped quantity.
- Allocating stock to a new order reduces `available`.

Anything not covered here is a product decision for you to make and explain.
