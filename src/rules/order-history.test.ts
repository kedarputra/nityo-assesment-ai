import { describe, expect, it } from "vitest";
import { usualOrder } from "./order-history";

// C001 Bluefin Bistro's history (E036) and C011 Union Street Deli's (E010), as the pack has them.
const so24053 = {
  soNumber: "SO-24053",
  orderDate: "2026-10-20",
  lines: [
    { sku: "HPS-1401", qtyOrdered: 10 },
    { sku: "HPS-1403", qtyOrdered: 5 },
    { sku: "HPS-1404", qtyOrdered: 5 },
  ],
};
const so24054 = {
  soNumber: "SO-24054",
  orderDate: "2026-10-06",
  lines: [
    { sku: "HPS-1401", qtyOrdered: 10 },
    { sku: "HPS-1403", qtyOrdered: 5 },
    { sku: "HPS-1404", qtyOrdered: 5 },
    { sku: "HPS-1407", qtyOrdered: 4 },
  ],
};
const so24040 = {
  soNumber: "SO-24040",
  orderDate: "2026-10-12",
  lines: [
    { sku: "HPS-1502", qtyOrdered: 4 },
    { sku: "HPS-1408", qtyOrdered: 2 },
    { sku: "HPS-1407", qtyOrdered: 1 },
  ],
};

describe("usualOrder (U14)", () => {
  it("is the lines common to the recent orders, and offers the rest (E036)", () => {
    expect(usualOrder([so24054, so24053])).toEqual({
      basedOn: ["SO-24053", "SO-24054"],
      latest: { soNumber: "SO-24053", orderDate: "2026-10-20", lines: [
        { sku: "HPS-1401", quantity: 10 },
        { sku: "HPS-1403", quantity: 5 },
        { sku: "HPS-1404", quantity: 5 },
      ] },
      common: [
        { sku: "HPS-1401", quantity: 10, fromSalesOrder: "SO-24053" },
        { sku: "HPS-1403", quantity: 5, fromSalesOrder: "SO-24053" },
        { sku: "HPS-1404", quantity: 5, fromSalesOrder: "SO-24053" },
      ],
      offered: [{ sku: "HPS-1407", quantity: 4, fromSalesOrder: "SO-24054" }],
    });
  });

  it("is the one order when there is only one (E010, “same as last time”)", () => {
    const usual = usualOrder([so24040]);
    expect(usual.latest?.soNumber).toBe("SO-24040");
    expect(usual.common.map((line) => [line.sku, line.quantity, line.fromSalesOrder])).toEqual([
      ["HPS-1502", 4, "SO-24040"],
      ["HPS-1408", 2, "SO-24040"],
      ["HPS-1407", 1, "SO-24040"],
    ]);
    expect(usual.offered).toEqual([]);
  });

  it("looks at the three most recent orders only", () => {
    const older = { soNumber: "SO-1", orderDate: "2026-01-01", lines: [{ sku: "HPS-9999", qtyOrdered: 1 }] };
    const third = { ...so24053, soNumber: "SO-24060", orderDate: "2026-10-27" };
    const usual = usualOrder([older, so24054, so24053, third]);
    expect(usual.basedOn).toEqual(["SO-24060", "SO-24053", "SO-24054"]);
    expect(usual.common.map((line) => line.sku)).toEqual(["HPS-1401", "HPS-1403", "HPS-1404"]);
  });

  it("has nothing to repeat for a customer with no orders", () => {
    expect(usualOrder([])).toEqual({ basedOn: [], latest: null, common: [], offered: [] });
  });
});
