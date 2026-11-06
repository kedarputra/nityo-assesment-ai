import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { draftReplies, inventory, proposalLines, proposals, salesOrders } from "@/db/schema";
import type { ModelResponse } from "@/model/model";
import { ScriptedModel, callsTool, repliesWith } from "@/model/scripted-model";
import { ingestSnapshot } from "@/snapshot/snapshot";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import { runAgent } from "./run-agent";

// Ticket 09: dates (U11, policy 12), "the usual" (U14, policy 8), prices stated in the email
// (policy 4) and short stock (policy 2, U10), each run on its email from the walkthrough
// (grilled/hp-1-order-intake/assets/per-email-expected-outcomes.md) with a scripted model.

const MODEL_ID = "claude-opus-5-5";

// A product the customer described in words is chosen from a search (U18); a run's n-th search is
// its search_id n.
function search(id: number, query: Record<string, string>): ModelResponse {
  return callsTool("search_products", query, `call_search_${id}`);
}

function script(sender: string, proposal: Record<string, unknown>, before: ModelResponse[] = []): ModelResponse[] {
  return [
    callsTool("find_customer", { email: sender }),
    ...before,
    callsTool("propose_new_order", proposal),
    callsTool("draft_reply", { body: "Hi,\n\nThanks for your order. A colleague is checking it and will be in touch.\n\nHarbor Point" }),
    repliesWith("Proposed the order for review and drafted a reply."),
  ];
}

describe("dates, history, price claims and short stock", () => {
  let testDatabase: TestDatabase;

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    await ingestSnapshot(testDatabase.db);
  });

  afterEach(async () => {
    await testDatabase.close();
  });

  async function run(emailId: string, turns: ModelResponse[]) {
    const db = testDatabase.db;
    const model = new ScriptedModel(turns);
    const summary = await runAgent(db, model, { emailId, modelId: MODEL_ID });
    const [proposal] = await db.select().from(proposals).where(eq(proposals.runId, summary.runId));
    if (!proposal) throw new Error(`${emailId} made no Proposal`);
    const lines = await db
      .select()
      .from(proposalLines)
      .where(eq(proposalLines.proposalId, proposal.id))
      .orderBy(asc(proposalLines.lineNo));
    const failing = proposal.checks.filter((check) => !check.passes);
    const [reply] = await db.select().from(draftReplies).where(eq(draftReplies.runId, summary.runId));
    return { summary, proposal, lines, failing, reply, model };
  }

  // What propose_new_order told the model, which is what its reply's question rests on.
  function proposeResult(model: ScriptedModel): string {
    for (const request of model.requests) {
      for (const part of request.messages.at(-1)?.content ?? []) {
        if (part.type === "tool_result" && part.toolCallId === "call_propose_new_order") return part.content;
      }
    }
    throw new Error("propose_new_order returned nothing");
  }

  async function nothingReleased() {
    return testDatabase.db.select().from(salesOrders).where(eq(salesOrders.soNumber, "SO-24059"));
  }

  it("E024: keeps the list $78 over the expired $70 contract and records both Tuesdays", async () => {
    const { summary, proposal, lines, failing, reply } = await run(
      "E024",
      script(
        "purchasing@greenleafcafes.example",
        {
          customer_id: "C002",
          ship_to_id: "S002",
          requested_date: "2026-11-03",
          requested_date_words: "next Tuesday",
          lines: [
            {
              sku: "HPS-1403",
              quantity: 4,
              search_id: 1,
              stated_unit_price_cents: 7000,
              customer_words: "12 oz hot cups at our contract price of $70/case",
            },
            { sku: "HPS-1404", quantity: 4, search_id: 2, customer_words: "the matching lids" },
            { sku: "HPS-1407", quantity: 2, search_id: 3, customer_words: "dinner napkins" },
          ],
        },
        [
          search(1, { description: "hot cup", size: "12 oz" }),
          search(2, { description: "hot cup lid" }),
          search(3, { description: "dinner napkins" }),
        ],
      ),
    );

    expect(summary).toMatchObject({ outcome: "proposal", gateVerdict: "review" });
    expect(proposal).toMatchObject({
      totalCents: 60000,
      requestedDate: "2026-11-03",
      requestedDateAlternative: "2026-11-10",
      requestedDateWords: "next Tuesday",
    });
    expect(lines.map((line) => [line.sku, line.unitPriceCents, line.priceSource, line.statedPriceCents])).toEqual([
      ["HPS-1403", 7800, "list", 7000],
      ["HPS-1404", 4600, "list", null],
      ["HPS-1407", 5200, "list", null],
    ]);
    expect(failing.map((check) => [check.check, check.flags])).toEqual([
      ["system-price", ["P4-price-differs"]],
      ["requested-date", ["DATE-ambiguous"]],
    ]);
    expect(failing[0]?.detail).toContain("HPS-1403 stated $70.00, system $78.00 (list); the $70.00 contract ended Wed 30 Sep");
    expect(failing[1]?.detail).toContain("could be Tue 3 Nov or Tue 10 Nov");
    expect(reply).toBeDefined();
    expect(await nothingReleased()).toEqual([]);
  });

  it("E025: books the straws at the $34 on file, not the $30 Mike offered", async () => {
    const { proposal, lines, failing } = await run(
      "E025",
      script(
        "taproom@lakesidebrew.example",
        {
          customer_id: "C010",
          ship_to_id: "S013",
          requested_date: "2026-11-04",
          lines: [
            { sku: "HPS-1406", quantity: 6, search_id: 1, stated_unit_price_cents: 3000, customer_words: "paper straws at $30 a case" },
          ],
        },
        [search(1, { description: "paper straws" })],
      ),
    );

    expect(proposal).toMatchObject({ status: "open", totalCents: 20400 });
    expect(lines.map((line) => [line.unitPriceCents, line.statedPriceCents])).toEqual([[3400, 3000]]);
    expect(failing.map((check) => [check.check, check.flags])).toEqual([["system-price", ["P4-price-differs"]]]);
  });

  it("E032: flags “by Friday October 30” as a date already past", async () => {
    const { proposal, failing } = await run(
      "E032",
      script(
        "office@northsidecc.example",
        {
          customer_id: "C015",
          ship_to_id: "S018",
          // The model's own reading does not matter: the words are read by code.
          requested_date: "2026-11-06",
          requested_date_words: "by Friday October 30",
          lines: [
            { sku: "HPS-1103", quantity: 4, search_id: 1 },
            { sku: "HPS-1201", quantity: 5, search_id: 2 },
          ],
        },
        [
          search(1, { description: "toilet tissue", size: "standard roll" }),
          search(2, { description: "trash liners", size: "33 gal", colour: "black" }),
        ],
      ),
    );

    expect(proposal).toMatchObject({ totalCents: 48300, requestedDate: "2026-10-30", requestedDateAlternative: null });
    expect(failing.map((check) => [check.check, check.flags])).toEqual([["requested-date", ["P12-past-date"]]]);
    expect(failing[0]?.detail).toContain("Fri 30 Oct, which has already passed");
  });

  it("E036: rebuilds “the usual” from the three lines common to SO-24053 and SO-24054 and offers the napkins", async () => {
    const { proposal, lines, failing, model } = await run(
      "E036",
      script(
        "maria@bluefinbistro.example",
        {
          customer_id: "C001",
          ship_to_id: "S001",
          requested_date: "2026-11-06",
          requested_date_words: "for Friday",
          lines: [
            { sku: "HPS-1401", quantity: 10, from_sales_order: "SO-24053", customer_words: "our usual takeout order" },
            { sku: "HPS-1403", quantity: 5, from_sales_order: "SO-24053", customer_words: "our usual takeout order" },
            { sku: "HPS-1404", quantity: 5, from_sales_order: "SO-24053", customer_words: "our usual takeout order" },
          ],
        },
        [callsTool("get_usual_order", { customer_id: "C001" })],
      ),
    );

    const usual = model.requests[2]?.messages.at(-1)?.content[0];
    expect(usual?.type === "tool_result" ? JSON.parse(usual.content) : null).toMatchObject({
      basedOn: ["SO-24053", "SO-24054"],
      common: [
        { sku: "HPS-1401", quantity: 10 },
        { sku: "HPS-1403", quantity: 5 },
        { sku: "HPS-1404", quantity: 5 },
      ],
      offered: [{ sku: "HPS-1407", quantity: 4, fromSalesOrder: "SO-24054" }],
    });
    // HPS-1401 is at C001's contract price of $59; the others at list.
    expect(lines.map((line) => [line.sku, line.unitPriceCents, line.priceSource, line.fromSalesOrder])).toEqual([
      ["HPS-1401", 5900, "contract", "SO-24053"],
      ["HPS-1403", 7800, "list", "SO-24053"],
      ["HPS-1404", 4600, "list", "SO-24053"],
    ]);
    expect(proposal).toMatchObject({ totalCents: 121000, requestedDate: "2026-11-06" });
    expect(failing.map((check) => [check.check, check.flags])).toEqual([["from-history", ["P8-from-history"]]]);
  });

  it("E010: repeats SO-24040 and adds the foil, for Frank to confirm", async () => {
    const { proposal, lines, failing } = await run(
      "E010",
      script(
        "frank.russo.deli@mail.example",
        {
          customer_id: "C011",
          ship_to_id: "S014",
          requested_date: "2026-11-04",
          lines: [
            { sku: "HPS-1502", quantity: 4, from_sales_order: "SO-24040", customer_words: "same as last time" },
            { sku: "HPS-1408", quantity: 2, from_sales_order: "SO-24040", customer_words: "same as last time" },
            { sku: "HPS-1407", quantity: 1, from_sales_order: "SO-24040", customer_words: "same as last time" },
            { sku: "HPS-1409", quantity: 1, search_id: 1, customer_words: "a box of foil" },
          ],
        },
        [
          callsTool("get_usual_order", { customer_id: "C011" }),
          search(1, { description: "aluminum foil" }),
          callsTool("raise_flag", { code: "UNIT-ambiguous", note: "“A box of foil”: HPS-1409 is sold per roll; proposed 1 roll." }),
        ],
      ),
    );

    expect(proposal).toMatchObject({ totalCents: 31300 });
    expect(lines.map((line) => [line.sku, line.quantity, line.fromSalesOrder])).toEqual([
      ["HPS-1502", 4, "SO-24040"],
      ["HPS-1408", 2, "SO-24040"],
      ["HPS-1407", 1, "SO-24040"],
      ["HPS-1409", 1, null],
    ]);
    expect(failing.map((check) => [check.check, check.flags ?? []])).toEqual([
      ["from-history", ["P8-from-history"]],
      ["no-flags", []],
    ]);
  });

  it("refuses a line that cites an order the customer does not have", async () => {
    const { model } = await run(
      "E010",
      [
        callsTool("propose_new_order", {
          customer_id: "C011",
          ship_to_id: "S014",
          requested_date: "2026-11-04",
          lines: [{ sku: "HPS-1401", quantity: 10, from_sales_order: "SO-24053" }],
        }),
        ...script("frank.russo.deli@mail.example", {
          customer_id: "C011",
          ship_to_id: "S014",
          requested_date: "2026-11-04",
          lines: [{ sku: "HPS-1502", quantity: 4, from_sales_order: "SO-24040" }],
        }),
      ],
    );

    expect(model.requests[1]?.messages.at(-1)?.content[0]).toMatchObject({
      type: "tool_result",
      isError: true,
      content: "SO-24053 is not one of C011's orders with HPS-1401.",
    });
  });

  it("E008: none of HPS-1405 now and 100 due 13 Nov, after the 6 Nov deadline, so the date is unmeetable", async () => {
    const { proposal, failing, model } = await run(
      "E008",
      script(
        "events@bayfrontvenue.example",
        {
          customer_id: "C016",
          ship_to_id: "S019",
          requested_date: "2026-11-06",
          requested_date_words: "by Friday Nov 6 at the latest",
          lines: [{ sku: "HPS-1405", quantity: 15, search_id: 1, customer_words: "16 oz clear cold cups" }],
        },
        [search(1, { description: "cold cup", size: "16 oz", material: "clear" })],
      ),
    );

    expect(proposal).toMatchObject({ status: "open", totalCents: 123000, requestedDate: "2026-11-06" });
    expect(failing).toEqual([
      {
        check: "full-stock",
        passes: false,
        detail:
          "Not enough available: HPS-1405 wants 15, 0 available, 100 due Fri 13 Nov (PO-7710); the full 15 can arrive Fri 13 Nov at the earliest, after the requested Fri 6 Nov.",
        flags: ["P2-short-stock", "DATE-unmeetable"],
        choices: ["HPS-1405: backorder all 15 for Fri 13 Nov", "Decline the order"],
      },
    ]);
    expect(JSON.parse(proposeResult(model)).failingChecks[0].flags).toEqual(["P2-short-stock", "DATE-unmeetable"]);
  });

  it("E033: 5 of 12 HPS-1302 now and 40 due 9 Nov, so a person picks a partial or a backorder", async () => {
    const db = testDatabase.db;
    const { proposal, failing } = await run(
      "E033",
      script(
        "facilities@summitoffice.example",
        {
          customer_id: "C012",
          ship_to_id: "S015",
          // "Urgently" names no date, so no date can be missed.
          requested_date: "2026-11-04",
          lines: [
            { sku: "HPS-1302", quantity: 12, search_id: 1, customer_words: "quat disinfectant spray" },
            { sku: "HPS-1303", quantity: 4, search_id: 2, customer_words: "glass cleaner" },
          ],
        },
        [
          search(1, { description: "disinfectant spray", material: "quat" }),
          search(2, { description: "glass cleaner" }),
        ],
      ),
    );

    expect(proposal).toMatchObject({ status: "open", totalCents: 89600 });
    expect(failing.map((check) => [check.check, check.flags])).toEqual([["full-stock", ["P2-short-stock"]]]);
    expect(failing[0]?.detail).toBe("Not enough available: HPS-1302 wants 12, 5 available, 40 due Mon 9 Nov (PO-7712).");
    expect(failing[0]?.choices).toEqual([
      "HPS-1302: ship 5 now and the other 7 from Mon 9 Nov",
      "HPS-1302: backorder all 12 for Mon 9 Nov",
    ]);
    const [spray] = await db.select().from(inventory).where(eq(inventory.sku, "HPS-1302"));
    expect(spray?.available).toBe(5);
  });
});
