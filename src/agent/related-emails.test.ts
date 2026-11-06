import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentFlags, emailLinks, inventory, proposalLines, proposals } from "@/db/schema";
import type { ModelResponse } from "@/model/model";
import { ScriptedModel, callsTool, repliesWith } from "@/model/scripted-model";
import { findEmailWork } from "@/server/inbox/email-work";
import { ingestSnapshot } from "@/snapshot/snapshot";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import { shipTosNamedIn } from "./release-gate";
import { runAgent } from "./run-agent";
import { findTool } from "./tools";

// Sender trust, split deliveries and linked emails (tickets 08 and 09 of the map), played with the
// fake model against the walkthrough's expected outcomes
// (grilled/hp-1-order-intake/assets/per-email-expected-outcomes.md). Each test starts from the
// 07:00 snapshot, so a release is SO-24059 and searches are numbered from 1.

const MODEL_ID = "claude-opus-5-5";

describe("sender trust, split deliveries and linked emails", () => {
  let testDatabase: TestDatabase;

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    await ingestSnapshot(testDatabase.db);
  });

  afterEach(async () => {
    await testDatabase.close();
  });

  async function run(emailId: string, script: ModelResponse[]) {
    const model = new ScriptedModel(script);
    const summary = await runAgent(testDatabase.db, model, { emailId, modelId: MODEL_ID });
    const rows = await testDatabase.db.select().from(proposals).where(eq(proposals.runId, summary.runId)).orderBy(asc(proposals.id));
    const made = [];
    for (const proposal of rows) {
      const lines = await testDatabase.db
        .select()
        .from(proposalLines)
        .where(eq(proposalLines.proposalId, proposal.id))
        .orderBy(asc(proposalLines.lineNo));
      const failing = proposal.checks.filter((check) => !check.passes);
      made.push({
        ...proposal,
        lines: lines.map((line) => [line.sku, line.quantity]),
        failing: failing.map((check) => check.check),
        reasons: failing.flatMap((check) => check.flags ?? []),
      });
    }
    const flags = await testDatabase.db.select().from(agentFlags).where(eq(agentFlags.runId, summary.runId));
    return { summary, proposals: made, flags: flags.map((flag) => flag.code), model };
  }

  // What the agent was told in answer to one tool call.
  function resultOf(model: ScriptedModel, callId: string): unknown {
    for (const request of model.requests) {
      for (const message of request.messages) {
        for (const part of message.content) {
          if (part.type === "tool_result" && part.toolCallId === callId) return JSON.parse(part.content);
        }
      }
    }
    throw new Error(`no result for ${callId}`);
  }

  async function available(sku: string): Promise<number> {
    const [row] = await testDatabase.db.select().from(inventory).where(eq(inventory.sku, sku));
    if (!row) throw new Error(`no inventory for ${sku}`);
    return row.available;
  }

  function search(id: number, query: Record<string, string>): ModelResponse {
    return callsTool("search_products", query, `call_search_${id}`);
  }

  const e005Script: ModelResponse[] = [
    callsTool("find_customer", { email: "ops@metrofitness.example" }),
    callsTool("list_ship_tos", { customer_id: "C005" }),
    callsTool("find_duplicate", { customer_id: "C005" }),
    search(1, { description: "hand sanitizer gel", size: "1000 ml" }),
    search(2, { description: "trash liners", size: "33 gal", colour: "black" }),
    search(3, { description: "foam soap refill" }),
    search(4, { description: "multifold paper towels" }),
    callsTool("note_for_reviewer", {
      note: "SO-24052 for Downtown still has 4 cs HPS-1305 and 12 cs HPS-1201 unshipped; the 4 cs of sanitizer may repeat it.",
    }),
    callsTool(
      "propose_new_order",
      {
        customer_id: "C005",
        ship_to_id: "S006",
        requested_date: "2026-11-04",
        lines: [
          { sku: "HPS-1305", quantity: 4, search_id: 1, unit_as_written: "cs" },
          { sku: "HPS-1201", quantity: 6, search_id: 2, unit_as_written: "cs" },
        ],
      },
      "call_propose_downtown",
    ),
    callsTool(
      "propose_new_order",
      {
        customer_id: "C005",
        ship_to_id: "S007",
        requested_date: "2026-11-04",
        lines: [
          { sku: "HPS-1305", quantity: 3, search_id: 1, unit_as_written: "cs" },
          { sku: "HPS-1304", quantity: 3, search_id: 3, unit_as_written: "cs" },
        ],
      },
      "call_propose_eastside",
    ),
    callsTool(
      "propose_new_order",
      {
        customer_id: "C005",
        ship_to_id: "S008",
        requested_date: "2026-11-04",
        lines: [{ sku: "HPS-1101", quantity: 5, search_id: 4, unit_as_written: "cs" }],
      },
      "call_propose_northgate",
    ),
    callsTool("draft_reply", {
      body: "Hi Jenna,\n\nWe have the three club orders and will confirm them shortly. For Downtown: are the 4 cases of sanitizer in addition to the 4 still open on SO-24052?\n\nHarbor Point",
    }),
    repliesWith("Proposed one order per club."),
  ];

  it("splits E005 into one Proposal per club, each held for the split (policy 7, U8)", async () => {
    const { summary, proposals: made, model } = await run("E005", e005Script);

    expect(summary).toMatchObject({ outcome: "proposal", gateVerdict: "review", errorClass: null });
    expect(made.map(({ shipToId, status, totalCents, lines }) => ({ shipToId, status, totalCents, lines }))).toEqual([
      { shipToId: "S006", status: "open", totalCents: 46600, lines: [["HPS-1305", 4], ["HPS-1201", 6]] },
      { shipToId: "S007", status: "open", totalCents: 32100, lines: [["HPS-1305", 3], ["HPS-1304", 3]] },
      { shipToId: "S008", status: "open", totalCents: 21250, lines: [["HPS-1101", 5]] },
    ]);
    // Even the first order, proposed before the others existed, is held: the email names all three.
    for (const proposal of made) {
      expect(proposal.failing).toEqual(["single-ship-to"]);
      expect(proposal.reasons).toEqual(["P7-multi-ship-to"]);
    }
    expect(await available("HPS-1305")).toBe(35);

    // The partial overlap with SO-24052 is context, not a flag.
    expect(resultOf(model, "call_find_duplicate")).toMatchObject({
      emailsToday: [],
      openOrders: [
        {
          soNumber: "SO-24052",
          shipToId: "S006",
          status: "PARTIALLY_SHIPPED",
          unshippedLines: [
            { sku: "HPS-1305", unshipped: 4 },
            { sku: "HPS-1201", unshipped: 12 },
          ],
        },
      ],
    });
    const work = await findEmailWork(testDatabase.db, "E005");
    expect(work?.flags).toEqual([]);
    expect(work?.context).toEqual([expect.stringContaining("SO-24052")]);
  });

  it("releases E034's two clean Northgate lines and leaves its towels remark on E005's Proposal (U6)", async () => {
    await run("E005", e005Script);
    const before = await testDatabase.db.select().from(proposals).orderBy(asc(proposals.id));

    const { summary, proposals: made, flags, model } = await run("E034", [
      callsTool("find_customer", { email: "ops@metrofitness.example" }),
      callsTool("find_duplicate", { customer_id: "C005" }),
      callsTool("link_related_email", {
        email_id: "E005",
        why: "Jenna's forward of Matt's Northgate list, after E005's Northgate towels order.",
        possibly_same_order: false,
        remark: "E034 says to skip the towels for Northgate: \"we still have plenty\". E005's 5 cs of towels may no longer stand.",
      }),
      search(1, { description: "hand sanitizer gel", size: "1000 ml" }),
      search(2, { description: "trash liners", size: "55 gal", colour: "black" }),
      callsTool("propose_new_order", {
        customer_id: "C005",
        ship_to_id: "S008",
        requested_date: "2026-11-04",
        lines: [
          { sku: "HPS-1305", quantity: 4, search_id: 5, unit_as_written: "cs" },
          { sku: "HPS-1202", quantity: 8, search_id: 6, unit_as_written: "cs" },
        ],
      }),
      callsTool("draft_reply", {
        body: "Hi Jenna,\n\nSO-24059 is confirmed for Northgate: 4 cases of hand sanitizer refills and 8 cases of 55 gal black bags, no towels. Do the 5 cases of towels from your earlier email still stand?\n\nHarbor Point",
      }),
      repliesWith("Released the Northgate order as SO-24059."),
    ]);

    expect(summary).toMatchObject({ outcome: "released", gateVerdict: "released", errorClass: null });
    expect(made).toMatchObject([
      { shipToId: "S008", status: "released", soNumber: "SO-24059", totalCents: 58400, failing: [], lines: [["HPS-1305", 4], ["HPS-1202", 8]] },
    ]);
    expect(flags).toEqual([]);
    expect(await available("HPS-1305")).toBe(31);
    expect(await available("HPS-1202")).toBe(22);

    // The lookup saw E005's three open Proposals.
    expect(resultOf(model, "call_find_duplicate")).toMatchObject({
      emailsToday: [
        {
          emailId: "E005",
          outcome: "proposal",
          proposals: [
            { shipToId: "S006", status: "open" },
            { shipToId: "S007", status: "open" },
            { shipToId: "S008", status: "open", lines: [{ sku: "HPS-1101", quantity: 5 }] },
          ],
        },
      ],
    });

    // E005's Proposals are untouched; the remark and the link are shown on E005.
    expect(await testDatabase.db.select().from(proposals).where(eq(proposals.emailId, "E005")).orderBy(asc(proposals.id))).toEqual(
      before,
    );
    const e005 = await findEmailWork(testDatabase.db, "E005");
    expect(e005?.notes).toEqual([{ sourceEmailId: "E034", note: expect.stringContaining("skip the towels") }]);
    expect(e005?.related).toEqual([{ emailId: "E034", why: expect.stringContaining("Northgate") }]);
    expect((await findEmailWork(testDatabase.db, "E034"))?.related).toEqual([{ emailId: "E005", why: expect.any(String) }]);
  });

  it("matches E013's Kevin by his clinic's domain and holds his order, flagged P5-unverified-contact", async () => {
    const { summary, proposals: made, model } = await run("E013", [
      callsTool("find_customer", { email: "kevin.osei@riversideclinic.example" }),
      callsTool("find_duplicate", { customer_id: "C008" }),
      search(1, { description: "hand sanitizer gel", size: "1000 ml" }),
      search(2, { description: "gloves", size: "medium", material: "nitrile" }),
      search(3, { description: "gloves", size: "large", material: "nitrile" }),
      callsTool("propose_new_order", {
        customer_id: "C008",
        ship_to_id: "S011",
        requested_date: "2026-11-03",
        lines: [
          { sku: "HPS-1305", quantity: 4, search_id: 1, unit_as_written: "cases" },
          { sku: "HPS-1001", quantity: 6, search_id: 2, unit_as_written: "cases" },
          { sku: "HPS-1002", quantity: 6, search_id: 3, unit_as_written: "cases" },
        ],
      }),
      callsTool("draft_reply", {
        body: "Hi Kevin,\n\nThanks for your order. As you're new to us, we'll confirm it once we've checked with Nora Fields.\n\nHarbor Point",
      }),
      repliesWith("Proposed Kevin's order for verification."),
    ]);

    expect(resultOf(model, "call_find_customer")).toMatchObject({
      found: true,
      matchedBy: "domain",
      customer: { customerId: "C008" },
      flag: "P5-unverified-contact",
    });
    expect(summary).toMatchObject({ outcome: "proposal", gateVerdict: "review", errorClass: null });
    expect(made).toMatchObject([{ status: "open", totalCents: 104800, failing: ["known-contact"], reasons: ["P5-unverified-contact"] }]);
  });

  it("releases E039 from Nora's own address and shows it on E013's review (U7)", async () => {
    await run("E013", [
      callsTool("find_customer", { email: "kevin.osei@riversideclinic.example" }),
      callsTool("propose_new_order", {
        customer_id: "C008",
        ship_to_id: "S011",
        requested_date: "2026-11-03",
        lines: [{ sku: "HPS-1305", quantity: 4 }],
      }),
      repliesWith("Proposed."),
    ]);

    const { summary, proposals: made } = await run("E039", [
      callsTool("find_customer", { email: "nora@riversideclinic.example" }),
      callsTool("find_duplicate", { customer_id: "C008" }),
      callsTool("link_related_email", {
        email_id: "E013",
        why: "Nora orders herself at 11:10; Kevin wrote at 08:17 that she is on leave.",
        possibly_same_order: false,
        remark: "Nora Fields ordered from her own address at 11:10 (E039), so check Kevin's claim that she is on leave with her.",
      }),
      search(1, { description: "foam soap refill" }),
      search(2, { description: "toilet tissue", size: "jumbo" }),
      callsTool("propose_new_order", {
        customer_id: "C008",
        ship_to_id: "S011",
        requested_date: "2026-11-03",
        lines: [
          { sku: "HPS-1304", quantity: 4, search_id: 1, unit_as_written: "cases" },
          { sku: "HPS-1104", quantity: 5, search_id: 2, unit_as_written: "cases" },
        ],
      }),
      callsTool("draft_reply", { body: "Hi Nora,\n\nSO-24059 is confirmed: 4 cases of foam soap refills and 5 cases of jumbo toilet tissue.\n\nHarbor Point" }),
      repliesWith("Released Nora's order."),
    ]);

    expect(summary).toMatchObject({ outcome: "released", gateVerdict: "released", errorClass: null });
    expect(made).toMatchObject([{ status: "released", soNumber: "SO-24059", totalCents: 47100, failing: [] }]);
    const e013 = await findEmailWork(testDatabase.db, "E013");
    expect(e013?.notes).toEqual([{ sourceEmailId: "E039", note: expect.stringContaining("check Kevin's claim") }]);
    expect(e013?.related).toEqual([{ emailId: "E039", why: expect.any(String) }]);
  });

  it("makes E031 a Proposal flagged RELATED-E023, possibly E023's missing PO (U4)", async () => {
    await run("E023", [
      callsTool("find_customer", { email: "procurement@harborviewhotel.example" }),
      callsTool("route_to_person", {
        reason: "missing-attachment",
        summary: "Aisha says PO HV-3405 for the conference center (dock B) is attached; there is no attachment.",
        reply: "Hi Aisha,\n\nThe PO HV-3405 attachment didn't come through. Could you resend it?\n\nHarbor Point",
      }),
      repliesWith("Routed the missing attachment."),
    ]);

    const { summary, proposals: made, flags, model } = await run("E031", [
      callsTool("find_customer", { email: "procurement@harborviewhotel.example" }),
      callsTool("find_duplicate", { customer_id: "C003" }),
      callsTool("link_related_email", {
        email_id: "E023",
        why: "Possibly PO HV-3405, which E023 said was attached: same contact, same ship-to, 58 minutes later.",
        possibly_same_order: true,
      }),
      search(1, { description: "dinner napkins" }),
      search(2, { description: "wooden cutlery kit" }),
      search(3, { description: "paper straws" }),
      callsTool("propose_new_order", {
        customer_id: "C003",
        ship_to_id: "S004",
        requested_date: "2026-11-03",
        lines: [
          { sku: "HPS-1407", quantity: 10, search_id: 1, unit_as_written: "cases" },
          { sku: "HPS-1408", quantity: 8, search_id: 2, unit_as_written: "cases" },
          { sku: "HPS-1406", quantity: 4, search_id: 3, unit_as_written: "cases" },
        ],
      }),
      callsTool("draft_reply", { body: "Hi Aisha,\n\nThanks for the order. Is this PO HV-3405? We'll ship it once you confirm.\n\nHarbor Point" }),
      repliesWith("Proposed E031, linked to E023."),
    ]);

    expect(resultOf(model, "call_find_duplicate")).toMatchObject({
      emailsToday: [
        { emailId: "E004", outcome: "not run yet" },
        { emailId: "E023", outcome: "routed", routed: [{ reason: "missing-attachment" }] },
      ],
    });
    expect(summary).toMatchObject({ outcome: "proposal", gateVerdict: "review", errorClass: null });
    expect(flags).toEqual(["RELATED-E023"]);
    expect(made).toMatchObject([{ status: "open", totalCents: 101600, failing: ["no-flags"] }]);
    expect(await available("HPS-1408")).toBe(30);
    expect((await findEmailWork(testDatabase.db, "E023"))?.related).toEqual([{ emailId: "E031", why: expect.stringContaining("HV-3405") }]);
  });

  it("logs E033's mention of a cancellation as a note, not a Request (U5)", async () => {
    const { summary, proposals: made, flags } = await run("E033", [
      callsTool("find_customer", { email: "facilities@summitoffice.example" }),
      callsTool("find_duplicate", { customer_id: "C012" }),
      callsTool("note_for_reviewer", {
        note: "Mentions \"the PO I'm cancelling\" but names none; C012's only OPEN order is SO-24055 (SOP-1182).",
      }),
      search(1, { description: "disinfectant spray", material: "quat" }),
      search(2, { description: "glass cleaner" }),
      callsTool("propose_new_order", {
        customer_id: "C012",
        ship_to_id: "S015",
        requested_date: "2026-11-03",
        lines: [
          { sku: "HPS-1302", quantity: 12, search_id: 1, unit_as_written: "cases" },
          { sku: "HPS-1303", quantity: 4, search_id: 2, unit_as_written: "cases" },
        ],
      }),
      callsTool("draft_reply", { body: "Hi Karen,\n\n5 cases of quat spray can ship now and the other 7 after the 9 Nov delivery. Which would you like?\n\nHarbor Point" }),
      repliesWith("Proposed E033."),
    ]);

    expect(summary).toMatchObject({ outcome: "proposal", errorClass: null });
    expect(flags).toEqual([]);
    expect(made).toMatchObject([{ status: "open", totalCents: 89600, failing: ["full-stock"] }]);
    const work = await findEmailWork(testDatabase.db, "E033");
    expect(work?.run.requestKinds).toEqual(["new order"]);
    expect(work?.context).toEqual([expect.stringContaining("SO-24055")]);
  });

  it("refuses a link to an email from another customer, or one that has not arrived yet", async () => {
    const { model } = await run("E031", [
      callsTool("link_related_email", { email_id: "E001", why: "Not the same customer.", possibly_same_order: true }, "call_other_customer"),
      callsTool("link_related_email", { email_id: "E040", why: "Arrives later.", possibly_same_order: false }, "call_later"),
      repliesWith("Done."),
    ]);

    const messages = model.requests.at(-1)?.messages ?? [];
    const results = messages.flatMap((message) => message.content).filter((part) => part.type === "tool_result");
    expect(results).toMatchObject([
      { toolCallId: "call_other_customer", isError: true },
      { toolCallId: "call_later", isError: true },
    ]);
    expect(await testDatabase.db.select().from(emailLinks)).toEqual([]);
    expect(await testDatabase.db.select().from(agentFlags)).toEqual([]);
  });

  it("matches no customer for a stranger at mail.example, a domain three customers share (U16)", async () => {
    const tool = findTool("find_customer");
    if (!tool) throw new Error("no find_customer");
    const call = tool.validate({ email: "stranger@mail.example" });
    if (!call.valid) throw new Error(call.problems);

    const result = await call.run(testDatabase.db, {
      runId: "run-stranger",
      emailId: "E012",
      senderEmail: "stranger@mail.example",
      orderDate: "2026-11-02",
      now: () => new Date(),
    });

    expect(result).toMatchObject({ found: false });
  });
});

describe("shipTosNamedIn", () => {
  const metroFitness = [
    { shipToId: "S006", name: "Metro Fitness - Downtown" },
    { shipToId: "S007", name: "Metro Fitness - Eastside" },
    { shipToId: "S008", name: "Metro Fitness - Northgate" },
  ];

  it("reads each ship-to by the part of its name that tells it apart", () => {
    expect(shipTosNamedIn("Downtown: 4 cs\nEastside: 3 cs\nNorthgate: 5 cs", metroFitness)).toEqual(["S006", "S007", "S008"]);
    expect(shipTosNamedIn("can you get these ordered for Northgate", metroFitness)).toEqual(["S008"]);
  });

  it("names nothing for a customer with one ship-to", () => {
    expect(shipTosNamedIn("Riverside Medical Clinic", [{ shipToId: "S011", name: "Riverside Medical Clinic" }])).toEqual([]);
  });
});
