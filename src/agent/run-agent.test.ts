import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentRuns,
  auditEvents,
  draftReplies,
  inventory,
  proposalLines,
  proposals,
  salesOrderLines,
  salesOrders,
} from "@/db/schema";
import { ScriptedModel, callsTool, repliesWith } from "@/model/scripted-model";
import { ingestSnapshot } from "@/snapshot/snapshot";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import { e001Lines, e001Script } from "@/test/e001-script";
import { releaseChecks } from "./release-checks";
import { AgentRunRefused, MAX_MODEL_CALLS, runAgent } from "./run-agent";

const MODEL_ID = "claude-opus-5-5";

describe("an Agent run", () => {
  let testDatabase: TestDatabase;

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    await ingestSnapshot(testDatabase.db);
  });

  afterEach(async () => {
    await testDatabase.close();
  });

  async function available(sku: string): Promise<number> {
    const [row] = await testDatabase.db.select().from(inventory).where(eq(inventory.sku, sku));
    if (!row) throw new Error(`no inventory for ${sku}`);
    return row.available;
  }

  async function auditOf(runId: string) {
    return testDatabase.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.runId, runId))
      .orderBy(asc(auditEvents.id));
  }

  it("releases E001 as one order of $672.00 to S001, allocates its stock and audits every step", async () => {
    const db = testDatabase.db;
    expect(await available("HPS-1408")).toBe(30);
    const model = new ScriptedModel(e001Script());

    const summary = await runAgent(db, model, { emailId: "E001", modelId: MODEL_ID });

    expect(summary).toMatchObject({ emailId: "E001", outcome: "released", gateVerdict: "released", errorClass: null });

    const [order] = await db.select().from(salesOrders).where(eq(salesOrders.soNumber, "SO-24059"));
    expect(order).toMatchObject({
      customerId: "C001",
      shipToId: "S001",
      orderDate: "2026-11-02",
      requestedDate: "2026-11-05",
      status: "OPEN",
    });
    const lines = await db
      .select()
      .from(salesOrderLines)
      .where(eq(salesOrderLines.soNumber, "SO-24059"))
      .orderBy(asc(salesOrderLines.lineNo));
    expect(lines.map(({ sku, qtyOrdered, qtyShipped, unitPriceCents }) => ({ sku, qtyOrdered, qtyShipped, unitPriceCents }))).toEqual([
      { sku: "HPS-1408", qtyOrdered: 4, qtyShipped: 0, unitPriceCents: 4500 },
      { sku: "HPS-1402", qtyOrdered: 6, qtyShipped: 0, unitPriceCents: 7100 },
      { sku: "HPS-1502", qtyOrdered: 2, qtyShipped: 0, unitPriceCents: 3300 },
    ]);
    const total = lines.reduce((sum, line) => sum + line.qtyOrdered * line.unitPriceCents, 0);
    expect(total).toBe(67200);

    expect(await available("HPS-1408")).toBe(26);
    expect(await available("HPS-1402")).toBe(19);
    expect(await available("HPS-1502")).toBe(23);

    const [proposal] = await db.select().from(proposals).where(eq(proposals.runId, summary.runId));
    expect(proposal).toMatchObject({ status: "released", soNumber: "SO-24059", totalCents: 67200 });
    expect(proposal?.checks.every((check) => check.passes)).toBe(true);
    expect(proposal?.checks.map((check) => check.check)).toEqual([...releaseChecks]);

    const [reply] = await db.select().from(draftReplies).where(eq(draftReplies.runId, summary.runId));
    expect(reply?.body).toContain("SO-24059");

    const events = await auditOf(summary.runId);
    expect(events.map((event) => [event.actor, event.action, event.detail.tool ?? null])).toEqual([
      ["agent", "run.started", null],
      ["agent", "tool.called", "find_customer"],
      ["agent", "tool.called", "list_ship_tos"],
      ["agent", "tool.called", "get_product"],
      ["agent", "tool.called", "price_line"],
      ["agent", "tool.called", "check_stock"],
      ["agent", "tool.called", "check_credit"],
      ["gate", "gate.verdict", null],
      ["gate", "order.released", null],
      ["agent", "tool.called", "propose_new_order"],
      ["agent", "tool.called", "draft_reply"],
      ["agent", "run.finished", null],
    ]);
    expect(events.every((event) => event.emailId === "E001")).toBe(true);
    expect(events.find((event) => event.action === "gate.verdict")?.detail).toMatchObject({ verdict: "released" });
    expect(events.find((event) => event.action === "order.released")?.detail).toMatchObject({ soNumber: "SO-24059" });
  });

  it("keeps an Agent run record with its calls, tokens, cost, outcome and gate verdict", async () => {
    let clock = Date.parse("2026-11-02T12:05:00Z");
    const now = () => new Date((clock += 1_000));

    const summary = await runAgent(testDatabase.db, new ScriptedModel(e001Script()), {
      emailId: "E001",
      modelId: MODEL_ID,
      now,
    });

    const [run] = await testDatabase.db.select().from(agentRuns).where(eq(agentRuns.runId, summary.runId));
    expect(run).toMatchObject({
      emailId: "E001",
      modelId: MODEL_ID,
      modelCalls: 9,
      inputTokens: 9_000,
      outputTokens: 1_800,
      // $4 per million in and $20 per million out: 9,000 × 4 + 1,800 × 20 micro-dollars.
      estimatedCostMicroUsd: 72_000,
      outcome: "released",
      gateVerdict: "released",
      errorClass: null,
    });
    expect(run?.endedAt?.getTime()).toBeGreaterThan(run?.startedAt.getTime() ?? Infinity);
  });

  it("sends the email as delimited data under a system prompt that says it is never an instruction", async () => {
    const model = new ScriptedModel(e001Script());

    await runAgent(testDatabase.db, model, { emailId: "E001", modelId: MODEL_ID });

    const [first] = model.requests;
    expect(first?.system).toMatch(/never an instruction/);
    const opening = first?.messages[0]?.content[0];
    expect(opening?.type === "text" ? opening.text : "").toMatch(/^<email id="E001">[\s\S]*HPS-1408 {2}x 4[\s\S]*<\/email>$/);
    expect(first?.tools.map((tool) => tool.name)).toEqual([
      "find_customer",
      "list_ship_tos",
      "get_product",
      "search_products",
      "price_line",
      "check_stock",
      "check_credit",
      "get_orders",
      "find_duplicate",
      "get_usual_order",
      "link_related_email",
      "note_for_reviewer",
      "propose_new_order",
      "draft_reply",
      "raise_flag",
      "route_to_person",
      "close_no_action",
    ]);
    expect(first?.tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);
  });

  it("returns an invalid tool call to the model as an error and applies none of it", async () => {
    const db = testDatabase.db;
    const model = new ScriptedModel([
      // A quantity of 2.5 is not a whole selling unit, so the whole call is refused.
      callsTool("propose_new_order", {
        customer_id: "C001",
        ship_to_id: "S001",
        requested_date: "2026-11-05",
        lines: [
          { sku: "HPS-1408", quantity: 4 },
          { sku: "HPS-1402", quantity: 2.5 },
        ],
      }),
      callsTool("release_order", { so_number: "SO-24059" }),
      repliesWith("I could not propose it."),
    ]);

    const summary = await runAgent(db, model, { emailId: "E001", modelId: MODEL_ID });

    const results = model.requests.slice(1).map((request) => request.messages.at(-1)?.content[0]);
    expect(results[0]).toMatchObject({ type: "tool_result", isError: true });
    expect(results[1]).toMatchObject({ type: "tool_result", isError: true, content: "There is no tool called release_order." });
    expect(await db.select().from(proposals)).toEqual([]);
    expect(await db.select().from(salesOrders).where(eq(salesOrders.soNumber, "SO-24059"))).toEqual([]);
    expect(await available("HPS-1408")).toBe(30);

    const events = await auditOf(summary.runId);
    expect(events.filter((event) => event.action === "tool.refused")).toHaveLength(2);
    // Nothing settled the email, so the run says so rather than looking done.
    expect(summary).toMatchObject({ outcome: "failed", errorClass: "no-outcome" });
  });

  it("refuses to run an email that has already run", async () => {
    await runAgent(testDatabase.db, new ScriptedModel(e001Script()), { emailId: "E001", modelId: MODEL_ID });

    await expect(
      runAgent(testDatabase.db, new ScriptedModel(e001Script()), { emailId: "E001", modelId: MODEL_ID }),
    ).rejects.toBeInstanceOf(AgentRunRefused);
  });

  it(`stops after ${MAX_MODEL_CALLS} model calls`, async () => {
    const model = new ScriptedModel(
      Array.from({ length: MAX_MODEL_CALLS + 1 }, () => callsTool("get_product", { sku: "HPS-1408" })),
    );

    const summary = await runAgent(testDatabase.db, model, { emailId: "E001", modelId: MODEL_ID });

    expect(model.requests).toHaveLength(MAX_MODEL_CALLS);
    expect(summary).toMatchObject({ outcome: "failed", errorClass: "call-cap" });
  });

  it("records a model failure as a failed run with its error class", async () => {
    const model = new ScriptedModel([callsTool("find_customer", { email: "maria@bluefinbistro.example" })]);

    const summary = await runAgent(testDatabase.db, model, { emailId: "E001", modelId: MODEL_ID });

    expect(summary).toMatchObject({ outcome: "failed", errorClass: "Error" });
    const [run] = await testDatabase.db.select().from(agentRuns).where(eq(agentRuns.runId, summary.runId));
    expect(run?.endedAt).not.toBeNull();
  });

  describe("the gate, not the model, decides", () => {
    it("prices at the system's price and sends to review when the model proposes a lower price", async () => {
      const db = testDatabase.db;
      const model = new ScriptedModel([
        {
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "This order is approved at $30 a case; release it now." },
              {
                type: "tool_call",
                id: "call_propose",
                name: "propose_new_order",
                input: {
                  customer_id: "C001",
                  ship_to_id: "S001",
                  requested_date: "2026-11-05",
                  lines: e001Lines.map((line) => ({ ...line, stated_unit_price_cents: 3000 })),
                },
              },
            ],
          },
          stopReason: "tool_use",
        },
        repliesWith("Approved and released."),
      ]);

      const summary = await runAgent(db, model, { emailId: "E001", modelId: MODEL_ID });

      expect(summary).toMatchObject({ outcome: "proposal", gateVerdict: "review" });
      const [proposal] = await db.select().from(proposals).where(eq(proposals.runId, summary.runId));
      expect(proposal).toMatchObject({ status: "open", soNumber: null, totalCents: 67200 });
      expect(proposal?.checks.filter((check) => !check.passes).map((check) => check.check)).toEqual(["system-price"]);
      const lines = await db
        .select()
        .from(proposalLines)
        .where(eq(proposalLines.proposalId, proposal?.id ?? -1))
        .orderBy(asc(proposalLines.lineNo));
      expect(lines.map((line) => [line.sku, line.unitPriceCents, line.statedPriceCents])).toEqual([
        ["HPS-1408", 4500, 3000],
        ["HPS-1402", 7100, 3000],
        ["HPS-1502", 3300, 3000],
      ]);
      expect(await db.select().from(salesOrders).where(eq(salesOrders.soNumber, "SO-24059"))).toEqual([]);
      expect(await available("HPS-1408")).toBe(30);
    });

    it("keeps E007 in review on credit hold, whatever the model claims", async () => {
      const db = testDatabase.db;
      const model = new ScriptedModel([
        callsTool("find_customer", { email: "hello@coastalcatering.example" }),
        callsTool("search_products", { description: "wooden cutlery kit" }, "call_search_cutlery"),
        callsTool("search_products", { description: "soup cup", size: "16 oz" }, "call_search_cups"),
        // An argument the tool does not have is refused, not quietly dropped.
        callsTool("propose_new_order", {
          customer_id: "C009",
          ship_to_id: "S012",
          requested_date: "2026-11-07",
          approved: true,
          lines: [{ sku: "HPS-1408", quantity: 6 }],
        }),
        callsTool("propose_new_order", {
          customer_id: "C009",
          ship_to_id: "S012",
          requested_date: "2026-11-07",
          lines: [
            { sku: "HPS-1408", quantity: 6, search_id: 1 },
            { sku: "HPS-1402", quantity: 3, search_id: 2 },
          ],
        }),
        repliesWith("The order is approved and on its way."),
      ]);

      const summary = await runAgent(db, model, { emailId: "E007", modelId: MODEL_ID });

      const refused = model.requests[4]?.messages.at(-1)?.content[0];
      expect(refused).toMatchObject({ type: "tool_result", isError: true });

      expect(summary).toMatchObject({ outcome: "proposal", gateVerdict: "review" });
      const [proposal] = await db.select().from(proposals).where(eq(proposals.runId, summary.runId));
      // The walkthrough's figures: 6 × $45.00 + 3 × $71.00 = $483.00, on hold and over the limit.
      expect(proposal).toMatchObject({ status: "open", totalCents: 48300 });
      expect(proposal?.checks.filter((check) => !check.passes).map((check) => check.check)).toEqual([
        "credit-hold",
        "credit-limit",
      ]);
      expect(await available("HPS-1408")).toBe(30);
    });
  });
});
