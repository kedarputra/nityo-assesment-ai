import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db/database";
import { emailEmbeddings, emails } from "@/db/schema";
import type { Embedder } from "@/model/embedder";
import { ingestSnapshot } from "@/snapshot/snapshot";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import {
  EMBEDDER_FAILED_REASON,
  MEANING_TOP,
  NO_EMBEDDER_REASON,
  cosine,
  globalSearch,
  searchEmailsByKeyword,
  searchEmailsByMeaning,
} from "./search";

// A fake embedding model with four "meanings": hand protection, cups, billing, and a little of
// everything. Text about gloves and a query about hand protection land close together, though
// they share no word.
class TopicEmbedder implements Embedder {
  readonly calls: string[][] = [];
  constructor(readonly model = "fake-embedding-1") {}

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    return texts.map((text) => [
      /glove|hand protection/i.test(text) ? 1 : 0,
      /\bcups?\b|\blids?\b/i.test(text) ? 1 : 0,
      /invoice|billing|charged/i.test(text) ? 1 : 0,
      0.1,
    ]);
  }
}

describe("search (ADR 0005)", () => {
  let testDatabase: TestDatabase;
  let db: Database;

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    db = testDatabase.db;
    await ingestSnapshot(db);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await testDatabase.close();
  });

  async function textOf(emailId: string): Promise<string> {
    const [email] = await db.select().from(emails).where(eq(emails.emailId, emailId));
    return `${email?.fromName} ${email?.fromEmail} ${email?.subject} ${email?.body}`.toLowerCase();
  }

  describe("by keyword", () => {
    it("finds an email by any word of its sender, subject or body, whatever the case", async () => {
      const hits = await searchEmailsByKeyword(db, "PSD-PO-88231");

      expect(hits.map((hit) => hit.emailId)).toEqual(["E003"]);
      expect(hits[0]?.snippet).toMatchObject({ match: "PSD-PO-88231" });
    });

    it("needs every word to match: a second word narrows the results", async () => {
      const gloves = (await searchEmailsByKeyword(db, "gloves")).map((hit) => hit.emailId);
      const glovesUnion = (await searchEmailsByKeyword(db, "GLOVES union")).map((hit) => hit.emailId);

      expect(gloves).toContain("E026");
      expect(glovesUnion).toContain("E035");
      expect(glovesUnion).not.toContain("E026");
      expect(glovesUnion.every((id) => gloves.includes(id))).toBe(true);
    });

    it("matches the name of the customer whose contact sent the email", async () => {
      // E035 comes from Union Street Deli's contact, and never names the deli.
      expect(await textOf("E035")).not.toContain("union");

      expect((await searchEmailsByKeyword(db, "union street")).map((hit) => hit.emailId)).toContain("E035");
    });

    it("scores by how many times the words appear, best first", async () => {
      const hits = await searchEmailsByKeyword(db, "bluefin");

      expect(hits.length).toBeGreaterThan(1);
      const scores = hits.map((hit) => hit.score);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
      expect(scores.every((score) => score >= 1)).toBe(true);
    });

    it("cuts a snippet around the first match in the body, on one line", async () => {
      const [hit] = await searchEmailsByKeyword(db, "Pier");

      expect(hit?.emailId).toBe("E001");
      expect(hit?.snippet?.match).toBe("Pier");
      expect(hit?.snippet?.before.length).toBeLessThanOrEqual(61);
      expect(hit?.snippet?.after.length).toBeLessThanOrEqual(61);
      expect(`${hit?.snippet?.before}${hit?.snippet?.after}`).not.toMatch(/\n/);
    });

    it("finds nothing for an empty query, and treats % and _ as plain characters", async () => {
      expect(await searchEmailsByKeyword(db, "   ")).toEqual([]);
      const percent = await searchEmailsByKeyword(db, "%");
      expect(percent.length).toBeLessThan(40);
      for (const hit of percent) expect(await textOf(hit.emailId)).toContain("%");
    });
  });

  describe("by meaning", () => {
    it("ranks emails by how close they are in meaning, with no word in common", async () => {
      expect(await searchEmailsByKeyword(db, "hand protection")).toEqual([]);

      const result = await searchEmailsByMeaning(db, new TopicEmbedder(), "hand protection");

      expect(result.fellBack).toBe(false);
      expect(result.reason).toBeNull();
      expect(result.hits.length).toBeGreaterThan(0);
      expect(result.hits.length).toBeLessThanOrEqual(MEANING_TOP);
      for (const hit of result.hits) expect(await textOf(hit.emailId)).toContain("glove");
      const scores = result.hits.map((hit) => hit.score);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
    });

    it("embeds each email once, stores it with the model's name, and embeds again for a new model", async () => {
      const first = new TopicEmbedder("model-a");
      await searchEmailsByMeaning(db, first, "cups");
      await searchEmailsByMeaning(db, first, "invoice");

      expect(first.calls.map((call) => call.length)).toEqual([40, 1, 1]);
      expect(await db.$count(emailEmbeddings, eq(emailEmbeddings.model, "model-a"))).toBe(40);

      const second = new TopicEmbedder("model-b");
      await searchEmailsByMeaning(db, second, "cups");

      expect(second.calls.map((call) => call.length)).toEqual([40, 1]);
      expect(await db.$count(emailEmbeddings, eq(emailEmbeddings.model, "model-b"))).toBe(40);
      expect(await db.$count(emailEmbeddings)).toBe(40);
    });

    it("falls back to keywords, and says so, without a Gemini key", async () => {
      const result = await searchEmailsByMeaning(db, null, "gloves");

      expect(result).toEqual({ hits: await searchEmailsByKeyword(db, "gloves"), fellBack: true, reason: NO_EMBEDDER_REASON });
    });

    it("falls back to keywords, and says so, when the embedding service fails", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const broken: Embedder = {
        model: "broken",
        embed: async () => {
          throw new Error("quota");
        },
      };

      const result = await searchEmailsByMeaning(db, broken, "gloves");

      expect(result.fellBack).toBe(true);
      expect(result.reason).toBe(EMBEDDER_FAILED_REASON);
      expect(result.hits).toEqual(await searchEmailsByKeyword(db, "gloves"));
    });

    it("measures cosine similarity", () => {
      expect(cosine([1, 0], [1, 0])).toBe(1);
      expect(cosine([1, 0], [0, 1])).toBe(0);
      expect(cosine([1, 0], [0, 0])).toBe(0);
      expect(cosine([1], [1, 2])).toBe(0);
    });
  });

  describe("global search", () => {
    it("finds customers, their sales orders and the emails about them", async () => {
      const results = await globalSearch(db, "bluefin", { mode: "keyword", embedder: null });

      expect(results).toMatchObject({ query: "bluefin", mode: "keyword", fellBack: false, reason: null });
      expect(results.customers).toEqual([{ customerId: "C001", name: "Bluefin Bistro Group", status: "ACTIVE" }]);
      expect(results.orders.length).toBeGreaterThan(0);
      expect(results.orders.every((order) => order.customerName === "Bluefin Bistro Group")).toBe(true);
      expect(results.emails.map((hit) => hit.emailId)).toContain("E001");
    });

    it("finds products by name or SKU, and orders by number or customer PO, every word matching", async () => {
      const gloves = await globalSearch(db, "nitrile large", { mode: "keyword", embedder: null });
      const bySku = await globalSearch(db, "hps-1408", { mode: "keyword", embedder: null });
      const byPo = await globalSearch(db, "HV-3391", { mode: "keyword", embedder: null });

      expect(gloves.products.length).toBeGreaterThan(0);
      expect(gloves.products.every((product) => /nitrile/i.test(product.name) && /large/i.test(product.name))).toBe(true);
      expect(bySku.products.map((product) => product.sku)).toEqual(["HPS-1408"]);
      expect(byPo.orders.map((order) => order.soNumber)).toEqual(["SO-24051"]);
    });

    it("keeps at most 10 of each", async () => {
      const results = await globalSearch(db, "hps", { mode: "keyword", embedder: null });

      expect(results.products).toHaveLength(10);
    });

    it("searches emails by meaning when asked, and passes on the fallback", async () => {
      const meaning = await globalSearch(db, "hand protection", { mode: "meaning", embedder: new TopicEmbedder() });
      const fellBack = await globalSearch(db, "gloves", { mode: "meaning", embedder: null });

      expect(meaning.emails.length).toBeGreaterThan(0);
      expect(fellBack).toMatchObject({ mode: "meaning", fellBack: true, reason: NO_EMBEDDER_REASON });
    });

    it("finds nothing for an empty query", async () => {
      expect(await globalSearch(db, "  ", { mode: "meaning", embedder: new TopicEmbedder() })).toEqual({
        query: "",
        mode: "meaning",
        fellBack: false,
        reason: null,
        emails: [],
        customers: [],
        products: [],
        orders: [],
      });
    });
  });
});
