// Turning a customer's words into SKUs (ticket 07 of the map, U18). The model translates the
// customer's words into the catalog's own words; this code decides which products fit them, so
// "exactly one ACTIVE SKU remains" is a fact the release gate can check, not the model's opinion.

export interface CatalogProduct {
  sku: string;
  name: string;
  category: string;
  sellUom: "CS" | "EA";
  pack: string;
  listPriceCents: number;
  status: "ACTIVE" | "DISCONTINUED";
  replacedBy: string | null;
}

export const productAttributes = ["description", "size", "colour", "material"] as const;
export type ProductAttribute = (typeof productAttributes)[number];
export type ProductQuery = { description: string } & Partial<Record<Exclude<ProductAttribute, "description">, string>>;

export interface Candidate {
  sku: string;
  name: string;
  sellUom: "CS" | "EA";
  pack: string;
  listPriceCents: number;
  matched: ProductQuery;
}

export interface NearMatch extends Candidate {
  unmatched: ProductAttribute[];
}

interface ProductSummary {
  sku: string;
  name: string;
  pack: string;
  listPriceCents: number;
}

export interface DiscontinuedMatch extends ProductSummary {
  replacement: ProductSummary | null;
}

export interface CatalogSearch {
  // ACTIVE products that fit every stated attribute. Exactly one is a confident match.
  candidates: Candidate[];
  // ACTIVE products that fit the description but not every other attribute, offered only when
  // nothing fits them all.
  nearMatches: NearMatch[];
  // DISCONTINUED products that fit, which are never offered themselves (policy 3).
  discontinued: DiscontinuedMatch[];
}

export function searchCatalog(catalog: CatalogProduct[], query: ProductQuery): CatalogSearch {
  const stated = productAttributes.filter((attribute) => query[attribute]?.trim());
  const fits = catalog
    .map((product) => {
      const words = new Set(wordsOf(`${product.sku} ${product.name} ${product.category} ${product.pack}`));
      const unmatched = stated.filter((attribute) => !wordsOf(query[attribute] ?? "").every((word) => words.has(word)));
      return { product, unmatched };
    })
    .filter(({ unmatched }) => !unmatched.includes("description"))
    .sort((a, b) => a.product.sku.localeCompare(b.product.sku));

  const active = fits.filter(({ product }) => product.status === "ACTIVE");
  const candidates = active.filter(({ unmatched }) => unmatched.length === 0).map(({ product }) => candidate(product, query));
  const nearMatches =
    candidates.length > 0
      ? []
      : active.map(({ product, unmatched }) => ({ ...candidate(product, query), unmatched }));
  const discontinued = fits
    .filter(({ product, unmatched }) => product.status === "DISCONTINUED" && unmatched.length === 0)
    .map(({ product }) => {
      const replacement = catalog.find((row) => row.sku === product.replacedBy);
      return { ...summary(product), replacement: replacement ? summary(replacement) : null };
    });
  return { candidates, nearMatches, discontinued };
}

function candidate(product: CatalogProduct, query: ProductQuery): Candidate {
  const matched: ProductQuery = { description: query.description };
  for (const attribute of productAttributes) {
    const value = query[attribute];
    if (attribute !== "description" && value?.trim()) matched[attribute] = value;
  }
  return { ...summary(product), sellUom: product.sellUom, matched };
}

function summary(product: CatalogProduct): ProductSummary {
  return { sku: product.sku, name: product.name, pack: product.pack, listPriceCents: product.listPriceCents };
}

const UNIT_SPELLINGS: Record<string, string> = {
  gallon: "gal",
  litre: "l",
  liter: "l",
  inch: "in",
  ounce: "oz",
  millilitre: "ml",
  milliliter: "ml",
};

// Lower case, numbers parted from their units ("1000ml", "9in"), units spelled one way, and a
// plural's "s" dropped, so "55 gallons" and "55 gal" are the same words.
function wordsOf(text: string): string[] {
  const parted = text
    .toLowerCase()
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/([a-z])(\d)/g, "$1 $2");
  return (parted.match(/[a-z0-9]+(?:[.-][a-z0-9]+)*/g) ?? []).map((word) => {
    const singular = singularOf(word);
    return UNIT_SPELLINGS[singular] ?? singular;
  });
}

function singularOf(word: string): string {
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

// The words a customer may use for each selling unit (U1). A case can be a "caja" (E011 reads
// "cajas" as cases); an each can be named by what its pack holds ("1 roll"). Anything else, such
// as boxes of a case of gloves, is not the selling unit and needs the customer to confirm.
const SELLING_UNIT_WORDS: Record<CatalogProduct["sellUom"], string[]> = {
  CS: ["case", "cs", "caja", "carton", "ctn"],
  EA: ["each", "ea", "unit", "unidad", "piece", "pc"],
};
const PACK_WORD_TRANSLATIONS: Record<string, string[]> = { roll: ["rollo"] };

export function sellingUnitFits(product: Pick<CatalogProduct, "sellUom" | "pack">, unitAsWritten: string): boolean {
  const accepted = new Set(SELLING_UNIT_WORDS[product.sellUom]);
  const packOfOne = /^1\s+([a-z]+)$/i.exec(product.pack.trim());
  if (product.sellUom === "EA" && packOfOne?.[1]) {
    const packWord = packOfOne[1].toLowerCase();
    accepted.add(packWord);
    for (const translation of PACK_WORD_TRANSLATIONS[packWord] ?? []) accepted.add(translation);
  }
  const word = unitAsWritten.trim().toLowerCase();
  return [word, word.replace(/s$/, ""), word.replace(/es$/, "")].some((form) => accepted.has(form));
}

// Every SKU code a text names, in capitals, once each, in the order they appear.
export function skuCodesIn(text: string): string[] {
  return [...new Set((text.match(/\bHPS-\d{4}\b/gi) ?? []).map((code) => code.toUpperCase()))];
}
