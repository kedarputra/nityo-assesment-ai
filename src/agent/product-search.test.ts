import { describe, expect, it } from "vitest";
import { readDataPack } from "@/snapshot/data-pack";
import { searchCatalog, sellingUnitFits, skuCodesIn } from "./product-search";

// The searches the walkthrough's described lines need, over the data pack's own catalog
// (grilled/hp-1-order-intake/assets/per-email-expected-outcomes.md).
const catalog = readDataPack().products.map((product) => ({ ...product, replacedBy: product.replacedBy ?? null }));

function candidatesFor(query: Parameters<typeof searchCatalog>[1]) {
  return searchCatalog(catalog, query).candidates.map((candidate) => candidate.sku);
}

describe("searchCatalog", () => {
  it("finds exactly one ACTIVE SKU for each of E002's described lines", () => {
    expect(candidatesFor({ description: "toilet tissue", size: "jumbo" })).toEqual(["HPS-1104"]);
    expect(candidatesFor({ description: "foam soap refill" })).toEqual(["HPS-1304"]);
    expect(candidatesFor({ description: "trash liners", colour: "white" })).toEqual(["HPS-1203"]);
  });

  it("leaves two candidates when the size is not stated", () => {
    expect(candidatesFor({ description: "toilet tissue" })).toEqual(["HPS-1103", "HPS-1104"]);
  });

  it("reads sizes written with or without a space, and gallons in full", () => {
    expect(candidatesFor({ description: "trash liners", size: "55 gallons", colour: "black" })).toEqual(["HPS-1202"]);
    expect(candidatesFor({ description: "trash liners", size: "33gal", colour: "black" })).toEqual(["HPS-1201"]);
    expect(candidatesFor({ description: "hand sanitizer gel", size: "1000ml" })).toEqual(["HPS-1305"]);
  });

  it("says which attributes each candidate matched", () => {
    const result = searchCatalog(catalog, { description: "gloves", size: "large", material: "nitrile" });

    expect(result.candidates).toEqual([
      expect.objectContaining({
        sku: "HPS-1002",
        name: "Nitrile Gloves, Blue, Large",
        sellUom: "CS",
        pack: "10 boxes x 100 gloves",
        listPriceCents: 6800,
        matched: { description: "gloves", size: "large", material: "nitrile" },
      }),
    ]);
  });

  it("never offers a DISCONTINUED product, but names it and its replacement", () => {
    const result = searchCatalog(catalog, { description: "neutral floor cleaner", size: "1 gal" });

    expect(result.candidates).toEqual([]);
    expect(result.discontinued).toEqual([
      {
        sku: "HPS-1306",
        name: "Neutral Floor Cleaner, 1 gal",
        pack: "4 x 1 gal",
        listPriceCents: 4700,
        replacement: { sku: "HPS-1307", name: "Neutral Floor Cleaner, 2.5 L", pack: "4 x 2.5 L", listPriceCents: 5100 },
      },
    ]);
  });

  it("finds a DISCONTINUED SKU by its code", () => {
    const result = searchCatalog(catalog, { description: "HPS-1004" });

    expect(result.discontinued.map((product) => [product.sku, product.replacement?.sku])).toEqual([["HPS-1004", "HPS-1001"]]);
  });

  it("lists near matches when nothing fits every attribute", () => {
    const result = searchCatalog(catalog, { description: "toilet tissue", size: "mega" });

    expect(result.candidates).toEqual([]);
    expect(result.nearMatches.map((product) => [product.sku, product.unmatched])).toEqual([
      ["HPS-1103", ["size"]],
      ["HPS-1104", ["size"]],
    ]);
  });
});

describe("sellingUnitFits", () => {
  const product = (sellUom: "CS" | "EA", pack: string) => ({ sellUom, pack });

  it("accepts the selling unit's own words, in English and Spanish", () => {
    expect(sellingUnitFits(product("CS", "250 liners"), "cases")).toBe(true);
    expect(sellingUnitFits(product("CS", "100 liners"), "cajas")).toBe(true);
    expect(sellingUnitFits(product("EA", "1 roll"), "rollos")).toBe(true);
    expect(sellingUnitFits(product("EA", "1 roll"), "each")).toBe(true);
  });

  it("refuses a unit that is not the selling unit", () => {
    expect(sellingUnitFits(product("CS", "10 boxes x 100 gloves"), "boxes")).toBe(false);
    expect(sellingUnitFits(product("CS", "500 bags"), "bags")).toBe(false);
    expect(sellingUnitFits(product("EA", "1 roll"), "box")).toBe(false);
  });
});

describe("skuCodesIn", () => {
  it("finds every SKU code written in a text, once each, in capitals", () => {
    expect(skuCodesIn("HPS-1035 Hand Sanitizer Gel 1000ml x 4\nhps-1001 x 4\nHPS-1001 again")).toEqual([
      "HPS-1035",
      "HPS-1001",
    ]);
  });
});
