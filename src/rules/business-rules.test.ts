import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { readDataPack } from "@/snapshot/data-pack";
import {
  BusinessRuleError,
  businessDate,
  checkOrderEdit,
  creditCheck,
  editRights,
  orderValue,
  priceFor,
  sellability,
  stockFor,
} from "./business-rules";

// The rules run over the data pack exactly as the ingest reads it, so the figures below are the
// walkthrough's (grilled/hp-1-order-intake/assets/per-email-expected-outcomes.md).
const pack = readDataPack();

function product(skuCode: string) {
  const row = pack.products.find((candidate) => candidate.sku === skuCode);
  if (!row) throw new Error(`no product ${skuCode} in the pack`);
  return { sku: row.sku, listPriceCents: row.listPriceCents, status: row.status, replacedBy: row.replacedBy ?? null };
}

function customer(customerId: string) {
  const row = pack.customers.find((candidate) => candidate.customerId === customerId);
  if (!row) throw new Error(`no customer ${customerId} in the pack`);
  return row;
}

function salesOrder(soNumber: string) {
  const row = pack.salesOrders.find((candidate) => candidate.soNumber === soNumber);
  if (!row) throw new Error(`no sales order ${soNumber} in the pack`);
  return {
    soNumber: row.soNumber,
    status: row.status,
    lines: pack.salesOrderLines.filter((line) => line.soNumber === soNumber),
  };
}

function available(skuCode: string): number {
  const row = pack.inventory.find((candidate) => candidate.sku === skuCode);
  if (!row) throw new Error(`no inventory for ${skuCode} in the pack`);
  return row.onHand - row.allocated;
}

function price(customerId: string, skuCode: string, orderDate = businessDate) {
  return priceFor({ customerId, orderDate, product: product(skuCode), contracts: pack.customerPrices });
}

interface Walkthrough {
  email: string;
  customerId: string;
  releasedTodayCents: number;
  lines: { sku: string; quantity: number; unitPriceCents: number; source: "contract" | "list" }[];
  totalCents: number;
  exposureCents: number;
  creditPasses: boolean;
  onHold: boolean;
}

const walkthrough: Walkthrough[] = [
  {
    email: "E001",
    customerId: "C001",
    releasedTodayCents: 0,
    lines: [
      { sku: "HPS-1408", quantity: 4, unitPriceCents: 4500, source: "list" },
      { sku: "HPS-1402", quantity: 6, unitPriceCents: 7100, source: "list" },
      { sku: "HPS-1502", quantity: 2, unitPriceCents: 3300, source: "list" },
    ],
    totalCents: 67200,
    exposureCents: 487200,
    creditPasses: true,
    onHold: false,
  },
  {
    email: "E003",
    customerId: "C007",
    releasedTodayCents: 0,
    lines: [
      { sku: "HPS-1301", quantity: 6, unitPriceCents: 4860, source: "contract" },
      { sku: "HPS-1303", quantity: 6, unitPriceCents: 3420, source: "contract" },
      { sku: "HPS-1201", quantity: 30, unitPriceCents: 3510, source: "contract" },
      { sku: "HPS-1103", quantity: 20, unitPriceCents: 7200, source: "list" },
      { sku: "HPS-1304", quantity: 4, unitPriceCents: 4900, source: "list" },
    ],
    totalCents: 318580,
    exposureCents: 1218580,
    creditPasses: true,
    onHold: false,
  },
  {
    email: "E006",
    customerId: "C006",
    releasedTodayCents: 0,
    lines: [
      { sku: "HPS-1401", quantity: 8, unitPriceCents: 6400, source: "list" },
      { sku: "HPS-1407", quantity: 2, unitPriceCents: 5200, source: "list" },
    ],
    totalCents: 61600,
    exposureCents: 821600,
    creditPasses: false,
    onHold: false,
  },
  {
    email: "E011",
    customerId: "C013",
    releasedTodayCents: 0,
    lines: [
      { sku: "HPS-1202", quantity: 10, unitPriceCents: 4400, source: "list" },
      { sku: "HPS-1002", quantity: 4, unitPriceCents: 6800, source: "list" },
      { sku: "HPS-1410", quantity: 2, unitPriceCents: 2900, source: "list" },
    ],
    totalCents: 77000,
    exposureCents: 227000,
    creditPasses: true,
    onHold: false,
  },
  {
    email: "E015",
    customerId: "C020",
    releasedTodayCents: 0,
    lines: [
      { sku: "HPS-1103", quantity: 15, unitPriceCents: 7200, source: "list" },
      { sku: "HPS-1104", quantity: 6, unitPriceCents: 5500, source: "list" },
      { sku: "HPS-1305", quantity: 6, unitPriceCents: 5400, source: "contract" },
    ],
    totalCents: 173400,
    exposureCents: 873400,
    creditPasses: true,
    onHold: false,
  },
  {
    email: "E024",
    customerId: "C002",
    releasedTodayCents: 0,
    lines: [
      { sku: "HPS-1403", quantity: 4, unitPriceCents: 7800, source: "list" },
      { sku: "HPS-1404", quantity: 4, unitPriceCents: 4600, source: "list" },
      { sku: "HPS-1407", quantity: 2, unitPriceCents: 5200, source: "list" },
    ],
    totalCents: 60000,
    exposureCents: 370000,
    creditPasses: true,
    onHold: false,
  },
  {
    email: "E027",
    customerId: "C014",
    releasedTodayCents: 0,
    lines: [
      { sku: "HPS-1401", quantity: 3, unitPriceCents: 6400, source: "list" },
      { sku: "HPS-1407", quantity: 1, unitPriceCents: 5200, source: "list" },
    ],
    totalCents: 24400,
    exposureCents: 419400,
    creditPasses: false,
    onHold: true,
  },
  {
    // E015 (1734.00) was released for C020 earlier the same day, so it counts.
    email: "E038",
    customerId: "C020",
    releasedTodayCents: 173400,
    lines: [
      { sku: "HPS-1001", quantity: 6, unitPriceCents: 6800, source: "list" },
      { sku: "HPS-1101", quantity: 10, unitPriceCents: 4250, source: "list" },
      { sku: "HPS-1305", quantity: 4, unitPriceCents: 5400, source: "contract" },
    ],
    totalCents: 104900,
    exposureCents: 978300,
    creditPasses: true,
    onHold: false,
  },
  {
    email: "E040",
    customerId: "C016",
    releasedTodayCents: 0,
    lines: [
      { sku: "HPS-1407", quantity: 10, unitPriceCents: 5200, source: "list" },
      { sku: "HPS-1408", quantity: 10, unitPriceCents: 4500, source: "list" },
      { sku: "HPS-1403", quantity: 8, unitPriceCents: 7800, source: "list" },
      { sku: "HPS-1404", quantity: 8, unitPriceCents: 4600, source: "list" },
    ],
    totalCents: 196200,
    exposureCents: 696200,
    creditPasses: true,
    onHold: false,
  },
];

describe.each(walkthrough)("the walkthrough's $email", (expected) => {
  const priced = expected.lines.map((line) => ({ line, price: price(expected.customerId, line.sku) }));

  it("prices every line from the contract or the list", () => {
    for (const { line, price: actual } of priced) {
      expect({ sku: actual.sku, unitPriceCents: actual.unitPriceCents, source: actual.source }).toEqual({
        sku: line.sku,
        unitPriceCents: line.unitPriceCents,
        source: line.source,
      });
    }
  });

  it("totals the order", () => {
    const value = orderValue({
      lines: priced.map(({ line, price: actual }) => ({
        sku: line.sku,
        quantity: line.quantity,
        unitPriceCents: actual.unitPriceCents,
      })),
    });

    expect(value.totalCents).toBe(expected.totalCents);
  });

  it("checks credit with the arithmetic shown", () => {
    const result = creditCheck({
      customer: customer(expected.customerId),
      releasedTodayCents: expected.releasedTodayCents,
      orderValueCents: expected.totalCents,
    });

    expect(result.limit.exposureCents).toBe(expected.exposureCents);
    expect(result.limit.passes).toBe(expected.exposureCents <= result.limit.creditLimitCents);
    expect(result.status.passes).toBe(!expected.onHold);
    expect(result.passes).toBe(expected.creditPasses);
  });
});

describe("priceFor", () => {
  it("applies the list price once C002's HPS-1403 contract has expired, and says which contract lapsed", () => {
    const result = price("C002", "HPS-1403");

    expect(result).toMatchObject({ source: "list", unitPriceCents: 7800 });
    expect(result.source === "list" && result.expiredContract).toMatchObject({
      unitPriceCents: 7000,
      validTo: "2026-09-30",
    });
  });

  it("applies the same contract on a date inside its validity, both ends inclusive", () => {
    expect(price("C002", "HPS-1403", "2026-09-30")).toMatchObject({ source: "contract", unitPriceCents: 7000 });
    expect(price("C002", "HPS-1403", "2026-04-01")).toMatchObject({ source: "contract", unitPriceCents: 7000 });
    expect(price("C002", "HPS-1403", "2026-03-31")).toMatchObject({ source: "list", expiredContract: null });
  });

  it("never applies another customer's contract (C003's HPS-1101 is not C020's)", () => {
    expect(price("C020", "HPS-1101")).toMatchObject({ source: "list", unitPriceCents: 4250, expiredContract: null });
    expect(price("C003", "HPS-1101")).toMatchObject({ source: "contract", unitPriceCents: 3950 });
  });

  it("refuses to pick between two contracts valid on the same day", () => {
    const contract = { customerId: "C001", sku: "HPS-1401", unitPriceCents: 5900, validFrom: "2026-01-01", validTo: "2026-12-31" };

    expect(() =>
      priceFor({ customerId: "C001", orderDate: businessDate, product: product("HPS-1401"), contracts: [contract, { ...contract, unitPriceCents: 5000 }] }),
    ).toThrow(BusinessRuleError);
  });

  it("refuses an order date that is not a calendar date", () => {
    expect(() =>
      priceFor({ customerId: "C001", orderDate: "next Tuesday", product: product("HPS-1401"), contracts: [] }),
    ).toThrow(ZodError);
  });
});

describe("orderValue", () => {
  it.each([1.5, 0, -2])("refuses %d selling units: only whole units can be ordered", (quantity) => {
    expect(() => orderValue({ lines: [{ sku: "HPS-1401", quantity, unitPriceCents: 6400 }] })).toThrow(ZodError);
  });

  it("refuses a fractional price: money is integer cents", () => {
    expect(() => orderValue({ lines: [{ sku: "HPS-1401", quantity: 1, unitPriceCents: 64.5 }] })).toThrow(ZodError);
  });
});

describe("stockFor", () => {
  it("gives available stock with no incoming supply for a SKU nothing is due for", () => {
    expect(stockFor({ sku: "HPS-1408", available: available("HPS-1408"), incoming: pack.incomingSupply })).toEqual({
      sku: "HPS-1408",
      available: 30,
      incoming: [],
      incomingTotal: 0,
    });
  });

  it.each([
    ["HPS-1405", 0, { supplierPo: "PO-7710", qty: 100, expectedDate: "2026-11-13" }],
    ["HPS-1302", 5, { supplierPo: "PO-7712", qty: 40, expectedDate: "2026-11-09" }],
  ])("gives %s's available stock and its incoming delivery with the date", (skuCode, stock, delivery) => {
    expect(stockFor({ sku: skuCode, available: available(skuCode), incoming: pack.incomingSupply })).toEqual({
      sku: skuCode,
      available: stock,
      incoming: [delivery],
      incomingTotal: delivery.qty,
    });
  });

  it("lists several deliveries soonest first", () => {
    const result = stockFor({
      sku: "HPS-1302",
      available: 5,
      incoming: [
        { sku: "HPS-1302", supplierPo: "PO-2", qty: 10, expectedDate: "2026-11-20" },
        { sku: "HPS-1302", supplierPo: "PO-1", qty: 30, expectedDate: "2026-11-09" },
      ],
    });

    expect(result.incoming.map((delivery) => delivery.supplierPo)).toEqual(["PO-1", "PO-2"]);
    expect(result.incomingTotal).toBe(40);
  });
});

describe("creditCheck", () => {
  it("shows E006's arithmetic: Oak & Ember goes $216 over an $8,000 limit with $400 of headroom", () => {
    expect(creditCheck({ customer: customer("C006"), releasedTodayCents: 0, orderValueCents: 61600 }).limit).toEqual({
      passes: false,
      openBalanceCents: 760000,
      releasedTodayCents: 0,
      orderValueCents: 61600,
      exposureCents: 821600,
      creditLimitCents: 800000,
      headroomCents: 40000,
      exceedsByCents: 21600,
    });
  });

  it("passes an order that lands exactly on the limit", () => {
    expect(creditCheck({ customer: customer("C006"), releasedTodayCents: 0, orderValueCents: 40000 }).passes).toBe(true);
  });

  it("blocks a customer on CREDIT_HOLD even when the order fits the limit (E027's Golden Spoon)", () => {
    const result = creditCheck({ customer: customer("C014"), releasedTodayCents: 0, orderValueCents: 100 });

    expect(result.status).toEqual({ passes: false, customerStatus: "CREDIT_HOLD" });
    expect(result.limit.passes).toBe(true);
    expect(result.passes).toBe(false);
  });
});

describe("sellability", () => {
  it.each([
    ["HPS-1004", "HPS-1001"],
    ["HPS-1306", "HPS-1307"],
  ])("refuses DISCONTINUED %s and names its successor %s", (skuCode, successor) => {
    expect(sellability({ product: product(skuCode) })).toEqual({
      sku: skuCode,
      sellable: false,
      reason: "DISCONTINUED",
      replacedBy: successor,
    });
  });

  it("sells an ACTIVE SKU", () => {
    expect(sellability({ product: product("HPS-1001") })).toEqual({ sku: "HPS-1001", sellable: true });
  });
});

describe("editing a sales order", () => {
  it("refuses any edit to a SHIPPED order (SO-24040)", () => {
    const order = salesOrder("SO-24040");

    expect(editRights({ order })).toMatchObject({ status: "SHIPPED", editable: false });
    expect(checkOrderEdit({ order, edit: { kind: "line-quantity", lineNo: 1, quantity: 5 } })).toMatchObject({ allowed: false });
    expect(checkOrderEdit({ order, edit: { kind: "cancel" } })).toMatchObject({ allowed: false });
  });

  it("allows any edit to an OPEN order (SO-24051)", () => {
    const order = salesOrder("SO-24051");

    expect(editRights({ order })).toEqual({ soNumber: "SO-24051", status: "OPEN", editable: true, scope: "whole-order" });
    for (const edit of [
      { kind: "line-quantity", lineNo: 1, quantity: 1 },
      { kind: "add-line", sku: "HPS-1401", quantity: 2 },
      { kind: "ship-to", shipToId: "S001" },
      { kind: "requested-date", requestedDate: "2026-11-10" },
      { kind: "cancel" },
    ] as const) {
      expect(checkOrderEdit({ order, edit })).toEqual({ allowed: true });
    }
  });

  it("limits a PARTIALLY_SHIPPED order (SO-24052) to each line's unshipped quantity", () => {
    const order = salesOrder("SO-24052");

    expect(editRights({ order })).toEqual({
      soNumber: "SO-24052",
      status: "PARTIALLY_SHIPPED",
      editable: true,
      scope: "unshipped-quantity",
      lines: [
        { lineNo: 1, sku: "HPS-1305", qtyShipped: 6, unshippedQty: 4, minQty: 6 },
        { lineNo: 2, sku: "HPS-1001", qtyShipped: 8, unshippedQty: 0, minQty: 8 },
        { lineNo: 3, sku: "HPS-1201", qtyShipped: 0, unshippedQty: 12, minQty: 0 },
      ],
    });
    expect(checkOrderEdit({ order, edit: { kind: "line-quantity", lineNo: 1, quantity: 6 } })).toEqual({ allowed: true });
    expect(checkOrderEdit({ order, edit: { kind: "line-quantity", lineNo: 1, quantity: 14 } })).toEqual({ allowed: true });
    expect(checkOrderEdit({ order, edit: { kind: "line-quantity", lineNo: 3, quantity: 0 } })).toEqual({ allowed: true });
    expect(checkOrderEdit({ order, edit: { kind: "line-quantity", lineNo: 1, quantity: 5 } })).toMatchObject({ allowed: false });
    for (const edit of [
      { kind: "add-line", sku: "HPS-1401", quantity: 2 },
      { kind: "ship-to", shipToId: "S006" },
      { kind: "requested-date", requestedDate: "2026-11-10" },
      { kind: "cancel" },
    ] as const) {
      expect(checkOrderEdit({ order, edit })).toMatchObject({ allowed: false });
    }
  });

  it("refuses an edit to a line the order does not have", () => {
    expect(
      checkOrderEdit({ order: salesOrder("SO-24051"), edit: { kind: "line-quantity", lineNo: 99, quantity: 1 } }),
    ).toMatchObject({ allowed: false });
  });
});
