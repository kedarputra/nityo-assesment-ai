import { describe, expect, it } from "vitest";
import { stockFor } from "./business-rules";
import { shortStock } from "./short-stock";

// The pack's stock for the two short emails (the walkthrough's E008 and E033).
const clearCups = stockFor({
  sku: "HPS-1405",
  available: 0,
  incoming: [{ sku: "HPS-1405", supplierPo: "PO-7710", qty: 100, expectedDate: "2026-11-13" }],
});
const quatSpray = stockFor({
  sku: "HPS-1302",
  available: 5,
  incoming: [{ sku: "HPS-1302", supplierPo: "PO-7712", qty: 40, expectedDate: "2026-11-09" }],
});

describe("shortStock (policy 2, U10)", () => {
  it("offers a backorder or decline when none is in stock and the delivery comes after the date (E008)", () => {
    expect(shortStock({ wanted: 15, stock: clearCups, requestedDate: "2026-11-06" })).toEqual({
      sku: "HPS-1405",
      wanted: 15,
      available: 0,
      incoming: [{ supplierPo: "PO-7710", qty: 100, expectedDate: "2026-11-13" }],
      fullBy: "2026-11-13",
      dateUnmeetable: true,
      choices: [{ kind: "backorder", by: "2026-11-13" }, { kind: "decline" }],
    });
  });

  it("offers a partial shipment or a backorder when the customer named no date (E033)", () => {
    const result = shortStock({ wanted: 12, stock: quatSpray, requestedDate: null });
    expect(result).toMatchObject({ available: 5, fullBy: "2026-11-09", dateUnmeetable: false });
    expect(result.choices).toEqual([
      { kind: "partial", now: 5, later: 7, laterBy: "2026-11-09" },
      { kind: "backorder", by: "2026-11-09" },
    ]);
  });

  it("is meetable when the delivery lands by the requested date", () => {
    expect(shortStock({ wanted: 12, stock: quatSpray, requestedDate: "2026-11-09" }).dateUnmeetable).toBe(false);
  });

  it("adds decline beside partial and backorder when neither meets the date", () => {
    expect(shortStock({ wanted: 12, stock: quatSpray, requestedDate: "2026-11-04" }).choices.map((choice) => choice.kind)).toEqual([
      "partial",
      "backorder",
      "decline",
    ]);
  });

  it("has no full date when the deliveries due in do not cover the quantity", () => {
    const result = shortStock({ wanted: 200, stock: clearCups, requestedDate: null });
    expect(result).toMatchObject({ fullBy: null, dateUnmeetable: false });
    expect(result.choices).toEqual([{ kind: "decline" }]);
  });
});
