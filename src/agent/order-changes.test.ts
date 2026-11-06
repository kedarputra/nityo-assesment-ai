import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentRuns, auditEvents, inventory, proposalLines, proposals, salesOrderLines, salesOrders, users } from "@/db/schema";
import type { ModelResponse } from "@/model/model";
import { ScriptedModel, callsTool, repliesWith } from "@/model/scripted-model";
import { findEmailWork } from "@/server/inbox/email-work";
import { approveProposal } from "@/server/review/review";
import { ingestSnapshot } from "@/snapshot/snapshot";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import { e012Script } from "@/test/review-scripts";
import { releasedTodayFor } from "./release-gate";
import { runAgent } from "./run-agent";

// Order changes, cancellations and follow-ups (ticket 11), played with the fake model against the
// walkthrough's expected outcomes (grilled/hp-1-order-intake/assets/per-email-expected-outcomes.md).
// Each test starts from the 07:00 snapshot, so a release is SO-24059 and searches count from 1.

const MODEL_ID = "claude-opus-5-5";
const AT = new Date("2026-11-02T14:00:00Z");

describe("order changes and cancellations", () => {
  let testDatabase: TestDatabase;
  let userId: number;

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    await ingestSnapshot(testDatabase.db);
    const [user] = await testDatabase.db
      .insert(users)
      .values({ username: "ops.reviewer", passwordHash: "not-a-real-hash", role: "reviewer" })
      .returning({ id: users.id });
    if (!user) throw new Error("no user");
    userId = user.id;
  });

  afterEach(async () => {
    await testDatabase.close();
  });

  async function run(emailId: string, script: ModelResponse[]) {
    const model = new ScriptedModel(script);
    const summary = await runAgent(testDatabase.db, model, { emailId, modelId: MODEL_ID });
    const [record] = await testDatabase.db.select().from(agentRuns).where(eq(agentRuns.runId, summary.runId));
    const runProposals = await testDatabase.db
      .select()
      .from(proposals)
      .where(eq(proposals.runId, summary.runId))
      .orderBy(asc(proposals.id));
    const [proposal] = runProposals;
    if (!record || !proposal) throw new Error(`${emailId} made no Proposal`);
    const lines = await testDatabase.db
      .select()
      .from(proposalLines)
      .where(eq(proposalLines.proposalId, proposal.id))
      .orderBy(asc(proposalLines.lineNo));
    const failing = proposal.checks.filter((check) => !check.passes);
    return { summary, record, proposal, lines, failing, model };
  }

  async function available(sku: string): Promise<number> {
    const [row] = await testDatabase.db.select().from(inventory).where(eq(inventory.sku, sku));
    if (!row) throw new Error(`no inventory for ${sku}`);
    return row.available;
  }

  async function orderLines(soNumber: string) {
    const rows = await testDatabase.db
      .select()
      .from(salesOrderLines)
      .where(eq(salesOrderLines.soNumber, soNumber))
      .orderBy(asc(salesOrderLines.lineNo));
    return rows.map((line) => [line.lineNo, line.sku, line.qtyOrdered, line.unitPriceCents]);
  }

  async function orderStatus(soNumber: string) {
    const [order] = await testDatabase.db.select().from(salesOrders).where(eq(salesOrders.soNumber, soNumber));
    return order?.status;
  }

  function search(id: number, query: Record<string, string>): ModelResponse {
    return callsTool("search_products", query, `call_search_${id}`);
  }

  function reply(body: string): ModelResponse {
    return callsTool("draft_reply", { body });
  }

  const e004Script = (): ModelResponse[] => [
    callsTool("find_customer", { email: "procurement@harborviewhotel.example" }),
    callsTool("get_orders", { customer_id: "C003", customer_po: "HV-3391" }),
    search(1, { description: "foam soap refill" }),
    callsTool("propose_order_change", {
      customer_id: "C003",
      so_number: "SO-24051",
      line_changes: [{ line_no: 1, new_quantity: 25, unit_as_written: "cases", customer_words: "toilet tissue: please make it 25 cases instead of 20" }],
      add_lines: [{ sku: "HPS-1304", quantity: 5, search_id: 1, unit_as_written: "cases", customer_words: "add 5 cases of foam hand soap refills" }],
    }),
    reply(
      "Hi Aisha,\n\nWe'll update SO-24051: toilet tissue to 25 cases at your contract price of $66, and 5 cases of foam soap refills added at $49.\n\nHarbor Point",
    ),
    repliesWith("Proposed the change to SO-24051."),
  ];

  it("E004: proposes SO-24051's change, +$575.00, and approving it applies the change and its stock", async () => {
    const { summary, record, proposal, lines, failing } = await run("E004", e004Script());

    expect(summary).toMatchObject({ outcome: "proposal", gateVerdict: "review", errorClass: null });
    expect(record.requestKinds).toEqual(["order change"]);
    expect(proposal).toMatchObject({
      kind: "order change",
      targetSoNumber: "SO-24051",
      soNumber: null,
      status: "open",
      shipToId: "S003",
      totalCents: 57500,
    });
    expect(lines.map((line) => [line.orderLineNo, line.sku, line.quantity, line.unitPriceCents])).toEqual([
      [1, "HPS-1103", 5, 6600],
      [null, "HPS-1304", 5, 4900],
    ]);
    expect(failing).toEqual([]);
    // Nothing moves until a person approves.
    expect(await orderLines("SO-24051")).toEqual([
      [1, "HPS-1103", 20, 6600],
      [2, "HPS-1101", 15, 3950],
      [3, "HPS-1302", 6, 6200],
    ]);
    expect(await available("HPS-1103")).toBe(80);

    const work = await findEmailWork(testDatabase.db, "E004");
    expect(work?.proposals[0]).toMatchObject({
      kind: "order change",
      targetSoNumber: "SO-24051",
      lines: [
        { sku: "HPS-1103", before: 20, after: 25, lineTotalCents: 33000 },
        { sku: "HPS-1304", before: 0, after: 5, lineTotalCents: 24500 },
      ],
    });

    const approved = await approveProposal(testDatabase.db, { proposalId: proposal.id, userId, notes: {}, at: AT });

    expect(approved).toMatchObject({ released: true, kind: "order change", soNumber: "SO-24051", totalCents: 57500 });
    expect(await orderLines("SO-24051")).toEqual([
      [1, "HPS-1103", 25, 6600],
      [2, "HPS-1101", 15, 3950],
      [3, "HPS-1302", 6, 6200],
      [4, "HPS-1304", 5, 4900],
    ]);
    expect(await orderStatus("SO-24051")).toBe("OPEN");
    // The increase counts against C003's credit like a release today.
    expect(await releasedTodayFor(testDatabase.db, "C003")).toBe(57500);
    expect(await available("HPS-1103")).toBe(75);
    expect(await available("HPS-1304")).toBe(25);
    const [event] = await testDatabase.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.emailId, "E004"), eq(auditEvents.action, "proposal.approved")));
    expect(event).toMatchObject({
      actor: "person",
      userId,
      detail: {
        kind: "order change",
        soNumber: "SO-24051",
        totalCents: 57500,
        allocated: [
          { sku: "HPS-1103", quantity: 5 },
          { sku: "HPS-1304", quantity: 5 },
        ],
      },
    });
    // Shown after the decision as it was before → after, not as the order stands now.
    expect((await findEmailWork(testDatabase.db, "E004"))?.proposals[0]?.lines).toMatchObject([
      { before: 20, after: 25 },
      { before: 0, after: 5 },
    ]);
  });

  it("E017: proposes cancelling SO-24055, −$1,500.00, and approving it returns the stock", async () => {
    const { summary, record, proposal, lines, failing } = await run("E017", [
      callsTool("find_customer", { email: "facilities@summitoffice.example" }),
      callsTool("get_orders", { customer_id: "C012", customer_po: "SOP-1182" }),
      callsTool("propose_cancellation", { customer_id: "C012", so_number: "SO-24055" }),
      reply("Hi Karen,\n\nWe'll cancel SOP-1182 (SO-24055) and confirm once it's done.\n\nHarbor Point"),
      repliesWith("Proposed cancelling SO-24055."),
    ]);

    expect(summary).toMatchObject({ outcome: "proposal", gateVerdict: "review" });
    expect(record.requestKinds).toEqual(["cancellation"]);
    expect(proposal).toMatchObject({ kind: "cancellation", targetSoNumber: "SO-24055", status: "open", totalCents: -150000 });
    expect(lines.map((line) => [line.orderLineNo, line.sku, line.quantity, line.unitPriceCents])).toEqual([
      [1, "HPS-1201", -20, 3900],
      [2, "HPS-1103", -10, 7200],
    ]);
    expect(failing).toEqual([]);
    expect(await available("HPS-1201")).toBe(70);

    const approved = await approveProposal(testDatabase.db, { proposalId: proposal.id, userId, notes: {}, at: AT });

    expect(approved).toMatchObject({ released: true, kind: "cancellation", soNumber: "SO-24055", totalCents: -150000 });
    expect(await orderStatus("SO-24055")).toBe("CANCELLED");
    expect(await orderLines("SO-24055")).toEqual([
      [1, "HPS-1201", 0, 3900],
      [2, "HPS-1103", 0, 7200],
    ]);
    expect(await available("HPS-1201")).toBe(90);
    expect(await available("HPS-1103")).toBe(90);
    // A cancellation never lowers the exposure the credit check counts.
    expect(await releasedTodayFor(testDatabase.db, "C012")).toBe(0);
  });

  it("refuses a change to a SHIPPED order (SO-24040) as a hard rule", async () => {
    const { proposal, failing } = await run("E035", [
      callsTool("find_customer", { email: "frank.russo.deli@mail.example" }),
      callsTool("propose_order_change", {
        customer_id: "C011",
        so_number: "SO-24040",
        line_changes: [{ line_no: 1, new_quantity: 6 }],
      }),
      reply("Hi Frank,\n\nSO-24040 has already shipped, so we can't change it. Shall we send this as a new order?\n\nHarbor Point"),
      repliesWith("Proposed a change to a shipped order; it cannot be approved."),
    ]);

    expect(failing.map((check) => [check.check, check.detail])).toEqual([
      ["edit-rights", "SO-24040 has shipped and cannot be edited."],
    ]);

    const approved = await approveProposal(testDatabase.db, {
      proposalId: proposal.id,
      userId,
      notes: { "edit-rights": "The customer insists." },
      at: AT,
    });

    expect(approved).toMatchObject({ released: false, hardRules: [{ check: "edit-rights" }] });
    expect(await orderLines("SO-24040")).toEqual([
      [1, "HPS-1502", 4, 3300],
      [2, "HPS-1408", 2, 4500],
      [3, "HPS-1407", 1, 5200],
    ]);
  });

  it("limits a PARTIALLY_SHIPPED order (SO-24052) to its unshipped quantity", async () => {
    // C005's contact sent no email in the pack about SO-24052; E004's run stands in for the call.
    const { failing } = await run("E004", [
      callsTool("propose_order_change", {
        customer_id: "C005",
        so_number: "SO-24052",
        line_changes: [
          { line_no: 1, new_quantity: 8 },
          { line_no: 2, new_quantity: 5 },
        ],
      }),
      repliesWith("Proposed."),
    ]);

    expect(failing.find((check) => check.check === "edit-rights")?.detail).toBe(
      "SO-24052 line 2 has shipped 8; it cannot go below that.",
    );
  });

  it("refuses an order that is not the named customer's", async () => {
    const { model } = await run("E017", [
      callsTool("propose_cancellation", { customer_id: "C012", so_number: "SO-24051" }),
      callsTool("propose_cancellation", { customer_id: "C012", so_number: "SO-24055" }, "call_cancel_right"),
      repliesWith("Proposed."),
    ]);

    expect(model.requests[1]?.messages.at(-1)?.content[0]).toMatchObject({
      isError: true,
      content: "SO-24051 is not one of C012's orders.",
    });
  });

  const e002Script = (): ModelResponse[] => [
    callsTool("find_customer", { email: "admin@sunrisedaycare.example" }),
    search(1, { description: "toilet tissue", size: "jumbo" }),
    search(2, { description: "foam soap refill" }),
    search(3, { description: "trash liners", colour: "white" }),
    callsTool("propose_new_order", {
      customer_id: "C004",
      ship_to_id: "S005",
      requested_date: "2026-11-03",
      lines: [
        { sku: "HPS-1104", quantity: 3, search_id: 1, unit_as_written: "cases" },
        { sku: "HPS-1304", quantity: 2, search_id: 2, unit_as_written: "cases" },
        { sku: "HPS-1203", quantity: 2, search_id: 3, unit_as_written: "cases" },
      ],
    }),
    reply("Hi Paul,\n\nSO-24059 is confirmed.\n\nHarbor Point"),
    repliesWith("Released SO-24059."),
  ];

  it("E026: a follow-up to E002's released order is a change to it, with the boxes to confirm", async () => {
    const e002 = await run("E002", e002Script());
    expect(e002.proposal).toMatchObject({ status: "released", soNumber: "SO-24059" });

    const { record, proposal, lines, failing } = await run("E026", [
      callsTool("find_customer", { email: "admin@sunrisedaycare.example" }),
      callsTool("get_orders", { customer_id: "C004" }),
      search(4, { description: "gloves", size: "medium", material: "nitrile" }),
      search(5, { description: "gloves", size: "small", material: "nitrile" }),
      callsTool("raise_flag", { code: "P9-follow-up", note: "Adds to E002's order, released as SO-24059." }),
      callsTool("propose_order_change", {
        customer_id: "C004",
        so_number: "SO-24059",
        add_lines: [
          { sku: "HPS-1001", quantity: 6, search_id: 4, unit_as_written: "boxes", customer_words: "6 boxes of medium nitrile gloves" },
          { sku: "HPS-1003", quantity: 5, search_id: 5, unit_as_written: "boxes", customer_words: "5 boxes of small" },
        ],
      }),
      reply("Hi Paul,\n\nGloves come in cases of 10 boxes. Did you mean 6 and 5 cases, or 1 case each?\n\nHarbor Point"),
      repliesWith("Proposed adding the gloves to SO-24059."),
    ]);

    expect(record.requestKinds).toEqual(["order change"]);
    expect(proposal).toMatchObject({ kind: "order change", targetSoNumber: "SO-24059", status: "open", totalCents: 74800 });
    expect(lines.map((line) => [line.orderLineNo, line.sku, line.quantity, line.unitPriceCents])).toEqual([
      [null, "HPS-1001", 6, 6800],
      [null, "HPS-1003", 5, 6800],
    ]);
    expect(failing.map((check) => [check.check, check.flags ?? []])).toEqual([
      ["selling-units", []],
      ["no-flags", []],
    ]);
  });

  it("refuses to link a follow-up to a Proposal already released; that is a change to its order", async () => {
    const e002 = await run("E002", e002Script());

    const { model } = await run("E026", [
      callsTool("propose_new_order", {
        customer_id: "C004",
        ship_to_id: "S005",
        requested_date: "2026-11-03",
        follows_proposal_id: e002.proposal.id,
        lines: [{ sku: "HPS-1001", quantity: 1 }],
      }),
      callsTool("propose_order_change", {
        customer_id: "C004",
        so_number: "SO-24059",
        add_lines: [{ sku: "HPS-1001", quantity: 1 }],
      }),
      repliesWith("Proposed."),
    ]);

    expect(model.requests[1]?.messages.at(-1)?.content[0]).toMatchObject({
      isError: true,
      content: `Proposal ${e002.proposal.id} is already in the ERP as SO-24059; propose_order_change to SO-24059 instead (policy 9).`,
    });
  });

  const e010Script = (): ModelResponse[] => [
    callsTool("find_customer", { email: "frank.russo.deli@mail.example" }),
    callsTool("get_usual_order", { customer_id: "C011" }),
    search(1, { description: "aluminum foil" }),
    callsTool("raise_flag", { code: "UNIT-ambiguous", note: "“A box of foil”: HPS-1409 is sold per roll; proposed 1 roll." }),
    callsTool("propose_new_order", {
      customer_id: "C011",
      ship_to_id: "S014",
      requested_date: "2026-11-04",
      lines: [
        { sku: "HPS-1502", quantity: 4, from_sales_order: "SO-24040" },
        { sku: "HPS-1408", quantity: 2, from_sales_order: "SO-24040" },
        { sku: "HPS-1407", quantity: 1, from_sales_order: "SO-24040" },
        { sku: "HPS-1409", quantity: 1, search_id: 1, customer_words: "a box of foil" },
      ],
    }),
    reply("Hi Frank,\n\nLast time was 4 cs kraft bags, 2 cs cutlery kits and 1 cs napkins. Plus one foil roll at $39?\n\nHarbor Point"),
    repliesWith("Proposed the order from history."),
  ];

  it("E035: a follow-up to E010's pending Proposal is its own Proposal, linked to it and shown beside it", async () => {
    const e010 = await run("E010", e010Script());
    expect(e010.proposal.status).toBe("open");

    const { record, proposal, lines, failing } = await run("E035", [
      callsTool("find_customer", { email: "frank.russo.deli@mail.example" }),
      callsTool("get_pending_proposals", { customer_id: "C011" }),
      search(2, { description: "gloves" }),
      callsTool("raise_flag", { code: "P9-follow-up", note: "Adds to E010's order, still waiting for review." }),
      callsTool("propose_new_order", {
        customer_id: "C011",
        ship_to_id: "S014",
        requested_date: "2026-11-04",
        follows_proposal_id: e010.proposal.id,
        lines: [{ sku: "HPS-1001", quantity: 2, search_id: 2, unit_as_written: "cases", customer_words: "2 cases of gloves" }],
      }),
      reply("Hi Frank,\n\nWhich gloves should we add: nitrile in small, medium or large?\n\nHarbor Point"),
      repliesWith("Proposed the gloves beside E010's order."),
    ]);

    expect(record.requestKinds).toEqual(["new order"]);
    expect(proposal).toMatchObject({ kind: "new order", followsProposalId: e010.proposal.id, status: "open", totalCents: 13600 });
    expect(lines.map((line) => [line.sku, line.quantity])).toEqual([["HPS-1001", 2]]);
    expect(failing.map((check) => check.check)).toEqual(["confident-skus", "no-flags"]);
    // E010's Proposal is never amended in place.
    expect(await testDatabase.db.select().from(proposalLines).where(eq(proposalLines.proposalId, e010.proposal.id))).toHaveLength(4);

    const e035Work = await findEmailWork(testDatabase.db, "E035");
    expect(e035Work?.proposals[0]?.linked).toEqual([
      { relation: "follows", proposalId: e010.proposal.id, emailId: "E010", status: "open", totalCents: 31300 },
    ]);
    const e010Work = await findEmailWork(testDatabase.db, "E010");
    expect(e010Work?.proposals[0]?.linked).toEqual([
      { relation: "followed-by", proposalId: proposal.id, emailId: "E035", status: "open", totalCents: 13600 },
    ]);
  });

  it("E037: a follow-up to E012's pending Proposal, with the bags' unit to confirm", async () => {
    const e012 = await run("E012", e012Script());

    const { proposal, lines, failing } = await run("E037", [
      callsTool("find_customer", { email: "maple.bakery@mail.example" }),
      callsTool("get_pending_proposals", { customer_id: "C017" }),
      search(3, { description: "kraft paper bag", size: "#8" }),
      search(4, { description: "dinner napkins" }),
      callsTool("raise_flag", { code: "P9-follow-up", note: "Adds to E012's order, still waiting for review." }),
      callsTool("propose_new_order", {
        customer_id: "C017",
        ship_to_id: "S020",
        requested_date: "2026-11-03",
        follows_proposal_id: e012.proposal.id,
        lines: [
          { sku: "HPS-1502", quantity: 5, search_id: 3, unit_as_written: "bags", customer_words: "5 kraft bags #8" },
          { sku: "HPS-1407", quantity: 2, search_id: 4, unit_as_written: "cs", customer_words: "2 cs napkins" },
        ],
      }),
      reply("Hi Hannah,\n\nTo confirm: 5 cases of #8 kraft bags (500 bags each) and 2 cases of napkins?\n\nHarbor Point"),
      repliesWith("Proposed the follow-up beside E012's order."),
    ]);

    expect(proposal).toMatchObject({ followsProposalId: e012.proposal.id, totalCents: 26900 });
    expect(lines.map((line) => [line.sku, line.quantity, line.unitPriceCents])).toEqual([
      ["HPS-1502", 5, 3300],
      ["HPS-1407", 2, 5200],
    ]);
    expect(failing.map((check) => [check.check, check.flags ?? []])).toEqual([
      ["selling-units", []],
      ["no-flags", []],
    ]);
  });
});
