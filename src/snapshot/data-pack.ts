import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  customerStatus,
  productStatus,
  salesOrderStatus,
  sellUom,
  type customerContacts,
  type customerPrices,
  type customers,
  type emails,
  type incomingSupply,
  type inventory,
  type products,
  type salesOrderLines,
  type salesOrders,
  type shipToAddresses,
} from "@/db/schema";

// The Snapshot as typed rows, ready to insert. Reading casts every TEXT value from the pack and
// refuses one it cannot cast exactly; it interprets nothing (no price, no status meaning).
export interface Snapshot {
  customers: (typeof customers.$inferInsert)[];
  customerContacts: (typeof customerContacts.$inferInsert)[];
  shipToAddresses: (typeof shipToAddresses.$inferInsert)[];
  products: (typeof products.$inferInsert)[];
  customerPrices: (typeof customerPrices.$inferInsert)[];
  inventory: (typeof inventory.$inferInsert)[];
  incomingSupply: (typeof incomingSupply.$inferInsert)[];
  salesOrders: (typeof salesOrders.$inferInsert)[];
  salesOrderLines: (typeof salesOrderLines.$inferInsert)[];
  emails: (typeof emails.$inferInsert)[];
}

export const dataPackDirectory = path.join(process.cwd(), "data", "harbor_point_data_pack");

// Reads `erp.sqlite` (identical to the CSVs) read-only, and `emails.jsonl`. The pack is never
// written to.
export function readDataPack(directory: string = dataPackDirectory): Snapshot {
  const erp = new DatabaseSync(path.join(directory, "erp.sqlite"), { readOnly: true });
  try {
    return {
      ...readErp(erp),
      emails: readEmails(readFileSync(path.join(directory, "emails.jsonl"), "utf8")),
    };
  } finally {
    erp.close();
  }
}

type PackRow = Record<string, unknown>;

type ErpTable =
  | "customers"
  | "customer_contacts"
  | "ship_to_addresses"
  | "products"
  | "customer_prices"
  | "inventory"
  | "incoming_supply"
  | "sales_orders"
  | "sales_order_lines";

function readTable(erp: DatabaseSync, table: ErpTable): PackRow[] {
  // `table` is one of the fixed names above, never input. rowid keeps the pack's own order.
  return erp.prepare(`select * from ${table} order by rowid`).all();
}

function readErp(erp: DatabaseSync): Omit<Snapshot, "emails"> {
  return {
    customers: readTable(erp, "customers").map((row) => ({
      customerId: text(row, "customer_id"),
      name: text(row, "name"),
      paymentTerms: text(row, "payment_terms"),
      creditLimitCents: cents(row, "credit_limit"),
      openBalanceCents: cents(row, "open_balance"),
      status: oneOf(row, "status", customerStatus.enumValues),
    })),
    customerContacts: readTable(erp, "customer_contacts").map((row) => ({
      customerId: text(row, "customer_id"),
      name: text(row, "name"),
      email: text(row, "email"),
      role: text(row, "role"),
    })),
    shipToAddresses: readTable(erp, "ship_to_addresses").map((row) => ({
      shipToId: text(row, "ship_to_id"),
      customerId: text(row, "customer_id"),
      name: text(row, "name"),
      address: text(row, "address"),
      isDefault: oneOf(row, "is_default", ["0", "1"] as const) === "1",
    })),
    products: readTable(erp, "products").map((row) => ({
      sku: text(row, "sku"),
      name: text(row, "name"),
      category: text(row, "category"),
      sellUom: oneOf(row, "sell_uom", sellUom.enumValues),
      pack: text(row, "pack"),
      listPriceCents: cents(row, "list_price"),
      status: oneOf(row, "status", productStatus.enumValues),
      replacedBy: optionalText(row, "replaced_by"),
    })),
    customerPrices: readTable(erp, "customer_prices").map((row) => ({
      customerId: text(row, "customer_id"),
      sku: text(row, "sku"),
      unitPriceCents: cents(row, "unit_price"),
      validFrom: isoDate(row, "valid_from"),
      validTo: isoDate(row, "valid_to"),
    })),
    inventory: readTable(erp, "inventory").map((row) => {
      const onHand = wholeNumber(row, "on_hand");
      const allocated = wholeNumber(row, "allocated");
      // The database derives `available`; a pack that disagrees with it is refused, not hidden.
      if (wholeNumber(row, "available") !== onHand - allocated) {
        throw new DataPackError(`inventory ${text(row, "sku")}: available is not on_hand - allocated`);
      }
      return { sku: text(row, "sku"), onHand, allocated };
    }),
    incomingSupply: readTable(erp, "incoming_supply").map((row) => ({
      supplierPo: text(row, "supplier_po"),
      sku: text(row, "sku"),
      qty: wholeNumber(row, "qty"),
      expectedDate: isoDate(row, "expected_date"),
    })),
    salesOrders: readTable(erp, "sales_orders").map((row) => ({
      soNumber: text(row, "so_number"),
      customerId: text(row, "customer_id"),
      shipToId: text(row, "ship_to_id"),
      customerPo: optionalText(row, "customer_po"),
      orderDate: isoDate(row, "order_date"),
      requestedDate: isoDate(row, "requested_date"),
      status: oneOf(row, "status", salesOrderStatus.enumValues),
    })),
    salesOrderLines: readTable(erp, "sales_order_lines").map((row) => ({
      soNumber: text(row, "so_number"),
      lineNo: wholeNumber(row, "line_no"),
      sku: text(row, "sku"),
      qtyOrdered: wholeNumber(row, "qty_ordered"),
      qtyShipped: wholeNumber(row, "qty_shipped"),
      unitPriceCents: cents(row, "unit_price"),
    })),
  };
}

export function readEmails(jsonLines: string): Snapshot["emails"] {
  return jsonLines
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new DataPackError("emails.jsonl: a line is not a JSON object");
      }
      const row: PackRow = { ...parsed };
      const emailId = text(row, "email_id");
      const attachments = row.attachments;
      if (!Array.isArray(attachments) || attachments.length > 0) {
        throw new DataPackError(`email ${emailId}: attachments are not supported`);
      }
      return {
        emailId,
        receivedAt: timestamp(row, "received_at"),
        fromName: text(row, "from_name"),
        fromEmail: text(row, "from_email"),
        to: text(row, "to"),
        subject: text(row, "subject"),
        // Stored exactly as received: no trimming, no normalising.
        body: rawText(row, "body"),
      };
    });
}

export class DataPackError extends Error {
  override name = "DataPackError";
}

function rawText(row: PackRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new DataPackError(`${column}: expected text, got ${JSON.stringify(value)}`);
  }
  return value;
}

function text(row: PackRow, column: string): string {
  const value = rawText(row, column);
  if (value === "") throw new DataPackError(`${column}: expected a value, got an empty string`);
  return value;
}

// The pack writes "no value" as an empty string.
function optionalText(row: PackRow, column: string): string | null {
  const value = rawText(row, column);
  return value === "" ? null : value;
}

function oneOf<const Allowed extends readonly string[]>(
  row: PackRow,
  column: string,
  allowed: Allowed,
): Allowed[number] {
  const value = rawText(row, column);
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new DataPackError(`${column}: ${JSON.stringify(value)} is not one of ${allowed.join(", ")}`);
  }
  return match;
}

function wholeNumber(row: PackRow, column: string): number {
  const value = rawText(row, column);
  if (!/^\d+$/.test(value)) {
    throw new DataPackError(`${column}: ${JSON.stringify(value)} is not a whole number`);
  }
  return Number(value);
}

// Dollars as written ("68.0", "48.60", "20000") to integer cents, by string, never via a float.
export function parseCents(value: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new DataPackError(`${JSON.stringify(value)} is not an amount in dollars and cents`);
  const [, dollars = "", fraction = ""] = match;
  return Number(dollars) * 100 + Number(fraction.padEnd(2, "0"));
}

function cents(row: PackRow, column: string): number {
  try {
    return parseCents(rawText(row, column));
  } catch (error) {
    if (error instanceof DataPackError) throw new DataPackError(`${column}: ${error.message}`);
    throw error;
  }
}

function isoDate(row: PackRow, column: string): string {
  const value = rawText(row, column);
  const isCalendarDate =
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!isCalendarDate) {
    throw new DataPackError(`${column}: ${JSON.stringify(value)} is not a date (YYYY-MM-DD)`);
  }
  return value;
}

// An ISO 8601 timestamp with its UTC offset, e.g. 2026-11-02T07:02:00-05:00.
function timestamp(row: PackRow, column: string): Date {
  const value = rawText(row, column);
  const parsed = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(parsed.getTime())) {
    throw new DataPackError(`${column}: ${JSON.stringify(value)} is not a timestamp with an offset`);
  }
  return parsed;
}
