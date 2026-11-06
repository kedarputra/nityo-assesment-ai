import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { draftReplies, inventory, proposalLines, proposals, salesOrderLines } from "@/db/schema";
import type { ModelResponse } from "@/model/model";
import { ScriptedModel, callsTool, repliesWith } from "@/model/scripted-model";
import { findEmailWork } from "@/server/inbox/email-work";
import { ingestSnapshot } from "@/snapshot/snapshot";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import { SYSTEM_PROMPT } from "./prompt";
import { runAgent } from "./run-agent";

// Products described in words, units and substitutions (ticket 08), played with the fake model
// against the walkthrough's expected outcomes
// (grilled/hp-1-order-intake/assets/per-email-expected-outcomes.md). Each test starts from the
// 07:00 snapshot, so a release is SO-24059 and searches are numbered from 1.

const MODEL_ID = "claude-opus-5-5";

describe("products described in words", () => {
  let testDatabase: TestDatabase;

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    await ingestSnapshot(testDatabase.db);
  });

  afterEach(async () => {
    await testDatabase.close();
  });

  async function run(emailId: string, script: ModelResponse[]) {
    const summary = await runAgent(testDatabase.db, new ScriptedModel(script), { emailId, modelId: MODEL_ID });
    const [proposal] = await testDatabase.db.select().from(proposals).where(eq(proposals.runId, summary.runId));
    if (!proposal) throw new Error(`${emailId} made no Proposal`);
    const lines = await testDatabase.db
      .select()
      .from(proposalLines)
      .where(eq(proposalLines.proposalId, proposal.id))
      .orderBy(asc(proposalLines.lineNo));
    const [reply] = await testDatabase.db.select().from(draftReplies).where(eq(draftReplies.runId, summary.runId));
    const failing = proposal.checks.filter((check) => !check.passes);
    return { summary, proposal, lines, reply: reply?.body ?? "", failing };
  }

  async function available(sku: string): Promise<number> {
    const [row] = await testDatabase.db.select().from(inventory).where(eq(inventory.sku, sku));
    if (!row) throw new Error(`no inventory for ${sku}`);
    return row.available;
  }

  function search(id: number, query: Record<string, string>): ModelResponse {
    return callsTool("search_products", query, `call_search_${id}`);
  }

  it("releases E002's three described lines at $335.00, each the one product its words fit", async () => {
    const { summary, proposal, lines, reply, failing } = await run("E002", [
      callsTool("find_customer", { email: "admin@sunrisedaycare.example" }),
      callsTool("list_ship_tos", { customer_id: "C004" }),
      search(1, { description: "toilet tissue", size: "jumbo" }),
      search(2, { description: "foam soap refill" }),
      search(3, { description: "trash liners", colour: "white" }),
      callsTool("propose_new_order", {
        customer_id: "C004",
        ship_to_id: "S005",
        requested_date: "2026-11-03",
        lines: [
          { sku: "HPS-1104", quantity: 3, search_id: 1, unit_as_written: "cases", customer_words: "3 cases of the big toilet paper rolls" },
          { sku: "HPS-1304", quantity: 2, search_id: 2, unit_as_written: "cases", customer_words: "2 cases of the foam soap refills" },
          { sku: "HPS-1203", quantity: 2, search_id: 3, unit_as_written: "cases", customer_words: "2 cases of trash bags for the kitchen (the small white ones)" },
        ],
      }),
      callsTool("draft_reply", {
        body: "Hi Paul,\n\nSO-24059 is confirmed: 3 cases of Jumbo 9in toilet tissue, 2 cases of foam hand soap refills and 2 cases of 13 gal white liners. Tell us if any of these is not what you meant.\n\nHarbor Point",
      }),
      repliesWith("Released Sunrise Daycare's order as SO-24059."),
    ]);

    expect(summary).toMatchObject({ outcome: "released", gateVerdict: "released" });
    expect(failing).toEqual([]);
    expect(proposal).toMatchObject({ status: "released", soNumber: "SO-24059", totalCents: 33500 });
    expect(lines.map((line) => [line.sku, line.quantity, line.productSearchId])).toEqual([
      ["HPS-1104", 3, 1],
      ["HPS-1304", 2, 2],
      ["HPS-1203", 2, 3],
    ]);
    expect(await available("HPS-1104")).toBe(27);
    expect(reply).toContain("Jumbo");
  });

  it("releases E011 at $770.00 with cajas and rollos read as the selling units, and replies in Spanish", async () => {
    const { summary, proposal, failing, reply } = await run("E011", [
      callsTool("find_customer", { email: "orders@tidewaterseafood.example" }),
      search(1, { description: "trash liners", size: "55 gal", colour: "black" }),
      search(2, { description: "gloves", size: "large", material: "nitrile" }),
      search(3, { description: "cling film" }),
      callsTool("propose_new_order", {
        customer_id: "C013",
        ship_to_id: "S016",
        requested_date: "2026-11-03",
        lines: [
          { sku: "HPS-1202", quantity: 10, search_id: 1, unit_as_written: "cajas" },
          { sku: "HPS-1002", quantity: 4, search_id: 2, unit_as_written: "cajas" },
          { sku: "HPS-1410", quantity: 2, search_id: 3, unit_as_written: "rollos" },
        ],
      }),
      callsTool("draft_reply", {
        body: "Buenos días Carlos,\n\nSu pedido SO-24059 está confirmado: 10 cajas de bolsas negras de 55 galones, 4 cajas de guantes de nitrilo talla L y 2 rollos de film transparente.\n\nGracias,\nHarbor Point",
      }),
      repliesWith("Released Tidewater's order as SO-24059 and drafted a confirmation in Spanish."),
    ]);

    expect(summary).toMatchObject({ outcome: "released", gateVerdict: "released" });
    expect(failing).toEqual([]);
    expect(proposal).toMatchObject({ soNumber: "SO-24059", totalCents: 77000 });
    const released = await testDatabase.db.select().from(salesOrderLines).where(eq(salesOrderLines.soNumber, "SO-24059"));
    expect(released.map((line) => [line.sku, line.qtyOrdered])).toEqual([
      ["HPS-1202", 10],
      ["HPS-1002", 4],
      ["HPS-1410", 2],
    ]);
    expect(reply).toMatch(/^Buenos días/);
    expect(SYSTEM_PROMPT).toMatch(/customer's language/);
  });

  it("proposes E019 as HPS-1001 ×4 in place of discontinued HPS-1004, never releasing the swap", async () => {
    const { summary, proposal, lines, failing, reply } = await run("E019", [
      callsTool("find_customer", { email: "office@northsidecc.example" }),
      callsTool("get_product", { sku: "HPS-1004" }),
      callsTool("propose_new_order", {
        customer_id: "C015",
        ship_to_id: "S018",
        requested_date: "2026-11-03",
        lines: [{ sku: "HPS-1001", quantity: 4, replaces_sku: "HPS-1004", unit_as_written: "cases" }],
      }),
      callsTool("draft_reply", {
        body: "Hi James,\n\nHPS-1004 vinyl gloves are discontinued. Its replacement is HPS-1001 nitrile gloves, medium, at $68.00 a case instead of $45.00. Shall we send 4 cases?\n\nHarbor Point",
      }),
      repliesWith("Proposed HPS-1001 in place of HPS-1004 for a person to accept."),
    ]);

    expect(summary).toMatchObject({ outcome: "proposal", gateVerdict: "review" });
    expect(proposal).toMatchObject({ status: "open", soNumber: null, totalCents: 27200 });
    expect(lines.map((line) => [line.sku, line.quantity, line.replacesSku])).toEqual([["HPS-1001", 4, "HPS-1004"]]);
    expect(failing.map((check) => check.check)).toEqual(["no-substitution"]);
    expect(failing[0]?.detail).toBe(
      "P3-discontinued: HPS-1004 (10 boxes x 100 gloves at $45.00) is discontinued; HPS-1001 (10 boxes x 100 gloves at $68.00) is swapped in for a person to accept.",
    );
    expect(reply).toContain("$68.00 a case instead of $45.00");
    expect(await available("HPS-1001")).toBe(60);

    const work = await findEmailWork(testDatabase.db, "E019");
    expect(work?.proposals[0]?.lines[0]?.swappedFor).toEqual({
      sku: "HPS-1004",
      name: "Vinyl Gloves, Clear, Medium",
      pack: "10 boxes x 100 gloves",
      listPriceCents: 4500,
    });
  });

  it("proposes E020 as HPS-1307 ×2 for HPS-1306 plus HPS-1201 ×10 at C007's contract price, $453.00", async () => {
    const { summary, proposal, lines, failing, reply } = await run("E020", [
      callsTool("find_customer", { email: "m.hoang@pinecrestsd.example" }),
      search(1, { description: "neutral floor cleaner", size: "1 gal" }),
      search(2, { description: "trash liners", size: "33 gal", colour: "black" }),
      callsTool("propose_new_order", {
        customer_id: "C007",
        ship_to_id: "S010",
        requested_date: "2026-11-03",
        lines: [
          { sku: "HPS-1307", quantity: 2, search_id: 1, replaces_sku: "HPS-1306", unit_as_written: "cases" },
          { sku: "HPS-1201", quantity: 10, search_id: 2, unit_as_written: "cases" },
        ],
      }),
      callsTool("draft_reply", {
        body: "Hi Minh,\n\nHPS-1306 is discontinued; HPS-1307 (4 x 2.5 L, $51.00 a case) replaces it, so each case holds about a third less than the 4 x 1 gal you asked for. Should we send 2 cases or 3? The 10 cases of liners are at your contract price of $35.10.\n\nHarbor Point",
      }),
      repliesWith("Proposed the replacement floor cleaner and the liners for review."),
    ]);

    expect(summary).toMatchObject({ outcome: "proposal", gateVerdict: "review" });
    expect(proposal).toMatchObject({ status: "open", totalCents: 45300 });
    expect(lines.map((line) => [line.sku, line.quantity, line.unitPriceCents, line.priceSource, line.replacesSku])).toEqual([
      ["HPS-1307", 2, 5100, "list", "HPS-1306"],
      ["HPS-1201", 10, 3510, "contract", null],
    ]);
    expect(failing.map((check) => check.check)).toEqual(["no-substitution"]);
    expect(failing[0]?.detail).toContain("HPS-1306 (4 x 1 gal at $47.00) is discontinued; HPS-1307 (4 x 2.5 L at $51.00)");
    expect(reply).toContain("about a third less");
  });

  it("sends E021 to review as LOW-CONF-sku, because HPS-1035 is not in the catalog", async () => {
    const { summary, proposal, lines, failing } = await run("E021", [
      callsTool("find_customer", { email: "admin@crescentdental.example" }),
      callsTool("get_product", { sku: "HPS-1035" }),
      search(1, { description: "hand sanitizer gel", size: "1000 ml" }),
      callsTool("propose_new_order", {
        customer_id: "C018",
        ship_to_id: "S021",
        requested_date: "2026-11-03",
        lines: [
          { sku: "HPS-1305", quantity: 4, search_id: 1, customer_words: "HPS-1035 Hand Sanitizer Gel 1000ml x 4" },
          { sku: "HPS-1001", quantity: 4, customer_words: "HPS-1001 x 4" },
        ],
      }),
      callsTool("draft_reply", {
        body: "Hi Lily,\n\nHPS-1035 is not one of our codes. Did you mean HPS-1305, Hand Sanitizer Gel Refill 1000 ml?\n\nHarbor Point",
      }),
      repliesWith("Proposed HPS-1305 as the likely product and asked Lily to confirm."),
    ]);

    expect(summary).toMatchObject({ outcome: "proposal", gateVerdict: "review" });
    expect(proposal).toMatchObject({ status: "open", totalCents: 50400 });
    expect(lines.map((line) => [line.sku, line.quantity])).toEqual([
      ["HPS-1305", 4],
      ["HPS-1001", 4],
    ]);
    expect(failing.map((check) => check.check)).toEqual(["confident-skus"]);
    expect(failing[0]?.detail).toBe("LOW-CONF-sku: The email names HPS-1035, which is not in the catalog.");
  });

  describe("the gate holds the confident-match rule", () => {
    const e002Order = (line: Record<string, unknown>) =>
      callsTool("propose_new_order", {
        customer_id: "C004",
        ship_to_id: "S005",
        requested_date: "2026-11-03",
        lines: [line],
      });

    it("sends a line to review when its search left two candidates", async () => {
      const { failing } = await run("E002", [
        search(1, { description: "toilet tissue" }),
        e002Order({ sku: "HPS-1104", quantity: 3, search_id: 1 }),
        repliesWith("Proposed."),
      ]);

      expect(failing.map((check) => [check.check, check.detail])).toEqual([
        ["confident-skus", "LOW-CONF-sku: HPS-1104 is not the only product its description fits (HPS-1103, HPS-1104)."],
      ]);
    });

    it("sends a line to review when it is neither written in the email nor from a search", async () => {
      const { failing } = await run("E002", [e002Order({ sku: "HPS-1104", quantity: 3 }), repliesWith("Proposed.")]);

      expect(failing.map((check) => check.detail)).toEqual([
        "LOW-CONF-sku: HPS-1104 is not written in the email and cites no search.",
      ]);
    });

    it("sends a line to review when the search it cites found a different product", async () => {
      const { failing } = await run("E002", [
        search(1, { description: "foam soap refill" }),
        e002Order({ sku: "HPS-1104", quantity: 3, search_id: 1 }),
        repliesWith("Proposed."),
      ]);

      expect(failing.map((check) => check.check)).toEqual(["confident-skus"]);
    });

    it("never releases a replacement the model swapped in without saying so", async () => {
      const { summary, failing } = await run("E019", [
        search(1, { description: "gloves", size: "medium", material: "nitrile" }),
        callsTool("propose_new_order", {
          customer_id: "C015",
          ship_to_id: "S018",
          requested_date: "2026-11-03",
          lines: [{ sku: "HPS-1001", quantity: 4, search_id: 1 }],
        }),
        repliesWith("Released."),
      ]);

      expect(summary).toMatchObject({ gateVerdict: "review" });
      expect(failing.map((check) => [check.check, check.detail])).toEqual([
        ["no-substitution", "P3-discontinued: The email names discontinued HPS-1004."],
      ]);
    });

    it("refuses a swap to a product that is not the discontinued SKU's replacement", async () => {
      const { failing } = await run("E019", [
        callsTool("propose_new_order", {
          customer_id: "C015",
          ship_to_id: "S018",
          requested_date: "2026-11-03",
          lines: [{ sku: "HPS-1002", quantity: 4, replaces_sku: "HPS-1004" }],
        }),
        repliesWith("Proposed."),
      ]);

      expect(failing.find((check) => check.check === "no-substitution")?.detail).toBe(
        "P3-discontinued: HPS-1002 is not the replacement for HPS-1004.",
      );
    });
  });

  describe("units", () => {
    it("flags E037's '5 kraft bags' read as 5 cases of 500 as UNIT-ambiguous", async () => {
      const { summary, failing, reply } = await run("E037", [
        callsTool("find_customer", { email: "maple.bakery@mail.example" }),
        search(1, { description: "kraft paper bag", size: "#8" }),
        search(2, { description: "dinner napkins" }),
        callsTool("propose_new_order", {
          customer_id: "C017",
          ship_to_id: "S020",
          requested_date: "2026-11-03",
          lines: [
            { sku: "HPS-1502", quantity: 5, search_id: 1, unit_as_written: "bags", customer_words: "5 kraft bags #8" },
            { sku: "HPS-1407", quantity: 2, search_id: 2, unit_as_written: "cs", customer_words: "2 cs napkins" },
          ],
        }),
        callsTool("draft_reply", {
          body: "Hi Hannah,\n\nWe have read 5 kraft bags #8 as 5 cases of 500 bags. Can you confirm?\n\nHarbor Point",
        }),
        repliesWith("Proposed for review."),
      ]);

      expect(summary).toMatchObject({ gateVerdict: "review" });
      expect(failing.map((check) => [check.check, check.detail])).toEqual([
        [
          "selling-units",
          'UNIT-ambiguous: HPS-1502 is sold per case (500 bags), and the customer wrote "bags"; read as 5.',
        ],
      ]);
      expect(reply).toContain("Can you confirm?");
    });

    it("flags a quantity that is not whole selling units", async () => {
      const { failing } = await run("E001", [
        callsTool("propose_new_order", {
          customer_id: "C001",
          ship_to_id: "S001",
          requested_date: "2026-11-05",
          lines: [{ sku: "HPS-1408", quantity: 3, quantity_as_written: 2.5, unit_as_written: "cases" }],
        }),
        repliesWith("Proposed."),
      ]);

      expect(failing.map((check) => check.detail)).toEqual(["UNIT-ambiguous: HPS-1408: the customer wrote 2.5, read as 3."]);
    });
  });
});
