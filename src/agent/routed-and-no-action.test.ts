import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentRuns,
  draftReplies,
  emailNotes,
  inventory,
  proposals,
  routedRequests,
  salesOrders,
} from "@/db/schema";
import type { ModelResponse } from "@/model/model";
import { ScriptedModel, callsTool, repliesWith } from "@/model/scripted-model";
import { ingestSnapshot } from "@/snapshot/snapshot";
import { findEmailWork } from "@/server/inbox/email-work";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import { runAgent } from "./run-agent";

// The walkthrough's routed and no-action emails (per-email-expected-outcomes.md), each played by
// a scripted model the way the live agent is expected to work it.

const MODEL_ID = "claude-opus-5-5";

describe("Requests that are routed or need no action", () => {
  let testDatabase: TestDatabase;

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    await ingestSnapshot(testDatabase.db);
  });

  afterEach(async () => {
    await testDatabase.close();
  });

  async function run(emailId: string, turns: ModelResponse[]) {
    const model = new ScriptedModel(turns);
    const summary = await runAgent(testDatabase.db, model, { emailId, modelId: MODEL_ID });
    const [record] = await testDatabase.db.select().from(agentRuns).where(eq(agentRuns.runId, summary.runId));
    if (!record) throw new Error(`no run record for ${emailId}`);
    return { summary, record, model };
  }

  async function routedOf(runId: string) {
    return testDatabase.db
      .select({ kind: routedRequests.kind, reason: routedRequests.reason, summary: routedRequests.summary })
      .from(routedRequests)
      .where(eq(routedRequests.runId, runId))
      .orderBy(asc(routedRequests.id));
  }

  async function repliesOf(runId: string): Promise<string[]> {
    const rows = await testDatabase.db.select({ body: draftReplies.body }).from(draftReplies).where(eq(draftReplies.runId, runId));
    return rows.map((row) => row.body);
  }

  async function available(sku: string): Promise<number> {
    const [row] = await testDatabase.db.select().from(inventory).where(eq(inventory.sku, sku));
    if (!row) throw new Error(`no inventory for ${sku}`);
    return row.available;
  }

  // A routed email: no Proposal, no stock moved, one routed Request and its Draft reply.
  async function expectRouted(
    result: Awaited<ReturnType<typeof run>>,
    expected: { kind: string; reason: string; reply: RegExp },
  ) {
    expect(result.summary).toMatchObject({ outcome: "routed", gateVerdict: null, errorClass: null });
    expect(result.record.requestKinds).toEqual([expected.kind]);
    expect(await routedOf(result.summary.runId)).toEqual([
      { kind: expected.kind, reason: expected.reason, summary: expect.any(String) },
    ]);
    expect(await testDatabase.db.select().from(proposals).where(eq(proposals.runId, result.summary.runId))).toEqual([]);
    const replies = await repliesOf(result.summary.runId);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(expected.reply);
  }

  it("routes E009's quote request with list prices and the cups' restock date", async () => {
    const result = await run("E009", [
      callsTool("find_customer", { email: "taproom@lakesidebrew.example" }),
      callsTool("price_line", { customer_id: "C010", sku: "HPS-1405", quantity: 20 }),
      callsTool("price_line", { customer_id: "C010", sku: "HPS-1406", quantity: 10 }, "call_price_straws"),
      callsTool("check_stock", { sku: "HPS-1405", quantity: 20 }),
      callsTool("route_to_person", {
        reason: "quote",
        summary: "Ben asks for a quote, not an order: 20 cs HPS-1405 ($1,640.00) and 10 cs HPS-1406 ($340.00), $1,980.00 at list.",
        reply:
          "Hi Ben,\n\nHere's your quote: 16 oz clear cups at $82/case (20 cases, $1,640) and paper straws at $34/case (10 cases, $340), $1,980 in all. The cups are out of stock until 13 November.\n\nHarbor Point",
      }),
      repliesWith("Routed the quote request with a quote at list prices."),
    ]);

    await expectRouted(result, { kind: "quote request", reason: "quote", reply: /\$82\/case[\s\S]*13 November/ });
    expect(await findEmailWork(testDatabase.db, "E009")).toMatchObject({
      run: { outcome: "routed", requestKinds: ["quote request"] },
      proposals: [],
      routed: [{ kind: "quote request", reason: "quote" }],
      noAction: null,
    });
    expect(await available("HPS-1405")).toBe(0);
    expect(await available("HPS-1406")).toBe(30);
  });

  it("routes E014 as a prospect, since no customer sent it (policy 5)", async () => {
    const result = await run("E014", [
      callsTool("find_customer", { email: "sofia@freshstartjuice.example" }),
      callsTool("route_to_person", {
        reason: "prospect",
        summary: "A new juice bar, Fresh Start, wants 5 cs 16 oz cups and 3 cs straws ($512.00 at list) and asks how to pay.",
        reply: "Hi Sofia,\n\nThanks for thinking of us. To order, we first open an account for you; a colleague will be in touch about payment terms.\n\nHarbor Point",
      }),
      repliesWith("Routed a prospect."),
    ]);

    const found = result.model.requests[1]?.messages.at(-1)?.content[0];
    expect(found).toMatchObject({ type: "tool_result", content: JSON.stringify({ found: false }) });
    await expectRouted(result, { kind: "new order", reason: "prospect", reply: /open an account/ });
  });

  it("routes E018's return on a SHIPPED order to a person", async () => {
    const result = await run("E018", [
      callsTool("find_customer", { email: "events@bayfrontvenue.example" }),
      callsTool("get_orders", { customer_id: "C016", customer_po: "BV-0412" }),
      callsTool("route_to_person", {
        reason: "return",
        summary: "Olivia wants to return 2 of 5 cs HPS-1406 from BV-0412 (SO-24056, SHIPPED): a $68.00 credit if accepted.",
        reply: "Hi Olivia,\n\nWe've got your request to return 2 cases of straws from BV-0412. A colleague will confirm the return and the $68 credit.\n\nHarbor Point",
      }),
      repliesWith("Routed the return."),
    ]);

    await expectRouted(result, { kind: "return", reason: "return", reply: /return 2 cases/ });
  });

  it("routes E022 with a clarifying reply and never invents quantities (U3)", async () => {
    const result = await run("E022", [
      callsTool("find_customer", { email: "manager@ironworksgym.example" }),
      callsTool("get_orders", { customer_id: "C019" }),
      callsTool("route_to_person", {
        reason: "no-quantities",
        summary: "Derek wants more 33 gal trash liners (HPS-1201) and quat disinfectant spray (HPS-1302) but gives no quantities, and C019 has no history.",
        reply:
          "Hi Derek,\n\nHappy to help. How many cases of the 33 gal trash liners and of the quat disinfectant spray would you like? Only 5 cases of the spray are in stock until 9 November.\n\nHarbor Point",
      }),
      repliesWith("Asked Derek how many."),
    ]);

    await expectRouted(result, { kind: "new order", reason: "no-quantities", reply: /How many cases/ });
  });

  it("routes E023, whose PO attachment is missing, with a reply asking for it again (U4)", async () => {
    const result = await run("E023", [
      callsTool("find_customer", { email: "procurement@harborviewhotel.example" }),
      callsTool("route_to_person", {
        reason: "missing-attachment",
        summary: "Aisha refers to an attached PO HV-3405 for the conference center (S004, dock B), but the email has no attachment.",
        reply: "Hi Aisha,\n\nThe PO HV-3405 attachment didn't come through on our side. Could you resend it?\n\nHarbor Point",
      }),
      repliesWith("Asked for the PO again."),
    ]);

    await expectRouted(result, { kind: "new order", reason: "missing-attachment", reply: /resend/ });
  });

  it("routes E030's billing dispute to accounts without changing the ERP", async () => {
    const result = await run("E030", [
      callsTool("find_customer", { email: "maria@bluefinbistro.example" }),
      callsTool("get_orders", { customer_id: "C001" }),
      callsTool("route_to_person", {
        reason: "billing",
        summary: "Maria says INV-55120 charges 6 cs hot cups on SO-24053; the ERP shows 5 ordered and 5 shipped at $78.00. $78.00 disputed.",
        reply: "Hi Maria,\n\nOur record for SO-24053 shows 5 cases of hot cups shipped. Accounts will check INV-55120 and send a correction.\n\nHarbor Point",
      }),
      repliesWith("Routed the billing dispute."),
    ]);

    await expectRouted(result, { kind: "billing dispute", reason: "billing", reply: /INV-55120/ });
  });

  it("gives E027 a hard-rule Proposal and a routed inquiry, with one honest reply (U12)", async () => {
    const result = await run("E027", [
      callsTool("find_customer", { email: "goldenspoondiner@mail.example" }),
      callsTool("get_orders", { customer_id: "C014" }),
      callsTool("propose_new_order", {
        customer_id: "C014",
        ship_to_id: "S017",
        requested_date: "2026-11-02",
        lines: [
          { sku: "HPS-1401", quantity: 3, customer_words: "3 cases of the takeout clamshells" },
          { sku: "HPS-1407", quantity: 1, customer_words: "1 case of napkins" },
        ],
      }),
      callsTool("route_to_person", {
        reason: "inquiry",
        summary: "Rita says her last order never came; C014 has no sales orders on file. The account is on credit hold.",
        reply:
          "Hi Rita,\n\nI'm sorry for the trouble. We can't find a recent order on file; could you send its date or PO number? Your new order can't ship today because the account is on hold; accounts will be in touch.\n\nHarbor Point",
      }),
      repliesWith("Proposed the order for review and routed the inquiry."),
    ]);

    expect(result.summary).toMatchObject({ outcome: "proposal", gateVerdict: "review", errorClass: null });
    expect(result.record.requestKinds).toEqual(["new order", "order inquiry"]);
    expect(await routedOf(result.summary.runId)).toEqual([
      { kind: "order inquiry", reason: "inquiry", summary: expect.stringContaining("no sales orders") },
    ]);
    const [proposal] = await testDatabase.db.select().from(proposals).where(eq(proposals.runId, result.summary.runId));
    expect(proposal).toMatchObject({ status: "open", totalCents: 24400 });
    expect(proposal?.checks.filter((check) => !check.passes).map((check) => check.check)).toEqual([
      "credit-hold",
      "credit-limit",
    ]);
    const replies = await repliesOf(result.summary.runId);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/date or PO number[\s\S]*on hold/);
  });

  it("closes E016 as a duplicate of E015's PO SSL-7781, linked to it, with no second order and no reply", async () => {
    const e015 = await run("E015", [
      callsTool("find_customer", { email: "purchasing@seasideseniorliving.example" }),
      callsTool("propose_new_order", {
        customer_id: "C020",
        ship_to_id: "S023",
        requested_date: "2026-11-05",
        customer_po: "SSL-7781",
        lines: [
          { sku: "HPS-1103", quantity: 15 },
          { sku: "HPS-1104", quantity: 6 },
          { sku: "HPS-1305", quantity: 6 },
        ],
      }),
      callsTool("draft_reply", { body: "Hi Grace,\n\nPO SSL-7781 is confirmed.\n\nHarbor Point" }),
      repliesWith("Released SSL-7781."),
    ]);
    expect(e015.summary.outcome).toBe("released");
    expect(await available("HPS-1103")).toBe(65);

    const e016 = await run("E016", [
      callsTool("find_customer", { email: "purchasing@seasideseniorliving.example" }),
      callsTool("get_orders", { customer_id: "C020", customer_po: "SSL-7781" }),
      callsTool("close_no_action", {
        reason: "duplicate",
        note: "A resend of PO SSL-7781, already released from E015 with the same three lines.",
        duplicate_of: "E015",
      }),
      repliesWith("Closed as a duplicate of E015."),
    ]);

    const orders = e016.model.requests[2]?.messages.at(-1)?.content[0];
    expect(orders?.type === "tool_result" ? JSON.parse(orders.content) : null).toMatchObject({
      orders: [{ customerPo: "SSL-7781", fromEmailId: "E015" }],
    });
    expect(e016.summary).toMatchObject({ outcome: "no_action", gateVerdict: null, errorClass: null });
    expect(e016.record).toMatchObject({
      requestKinds: ["no action"],
      noActionReason: "duplicate",
      duplicateOfEmailId: "E015",
    });
    const ssl7781 = await testDatabase.db.select().from(salesOrders).where(eq(salesOrders.customerPo, "SSL-7781"));
    expect(ssl7781).toHaveLength(1);
    expect(await available("HPS-1103")).toBe(65);
    expect(await repliesOf(e016.summary.runId)).toEqual([]);
    expect(await findEmailWork(testDatabase.db, "E016")).toMatchObject({
      run: { outcome: "no_action", requestKinds: ["no action"] },
      noAction: { reason: "duplicate", duplicateOf: "E015" },
      draftReply: null,
    });
  });

  it("refuses to close a duplicate of an email whose order is not in the system yet", async () => {
    const e016 = await run("E016", [
      callsTool("close_no_action", { reason: "duplicate", note: "Same PO as E015.", duplicate_of: "E015" }),
      repliesWith("Could not close it."),
    ]);

    const refused = e016.model.requests[1]?.messages.at(-1)?.content[0];
    expect(refused).toMatchObject({ type: "tool_result", isError: true });
    expect(refused?.type === "tool_result" ? refused.content : "").toMatch(/would lose it/);
    expect(e016.summary).toMatchObject({ outcome: "failed", errorClass: "no-outcome" });
  });

  it("closes E028's auto-reply and attaches what it says to the sender's open Requests (U17)", async () => {
    const e033 = await run("E033", [
      callsTool("find_customer", { email: "facilities@summitoffice.example" }),
      callsTool("propose_new_order", {
        customer_id: "C012",
        ship_to_id: "S015",
        requested_date: "2026-11-02",
        lines: [{ sku: "HPS-1302", quantity: 12, customer_words: "12 cases of the quat disinfectant spray" }],
      }),
      callsTool("draft_reply", { body: "Hi Karen,\n\nWe're checking stock on the spray.\n\nHarbor Point" }),
      repliesWith("Proposed E033 for review."),
    ]);
    expect(e033.summary.outcome).toBe("proposal");
    // Another sender's open Proposal must not get Karen's note.
    await run("E007", [
      callsTool("propose_new_order", {
        customer_id: "C009",
        ship_to_id: "S012",
        requested_date: "2026-11-07",
        lines: [{ sku: "HPS-1408", quantity: 6 }],
      }),
      repliesWith("Proposed E007."),
    ]);

    const e028 = await run("E028", [
      callsTool("find_customer", { email: "facilities@summitoffice.example" }),
      callsTool("close_no_action", {
        reason: "auto-reply",
        note: "Karen Liu is away until 9 November; for urgent matters call the front desk.",
      }),
      repliesWith("Closed the auto-reply."),
    ]);

    expect(e028.summary).toMatchObject({ outcome: "no_action", errorClass: null });
    expect(e028.record).toMatchObject({ requestKinds: ["no action"], noActionReason: "auto-reply", duplicateOfEmailId: null });
    const notes = await testDatabase.db.select().from(emailNotes).orderBy(asc(emailNotes.id));
    expect(notes.map(({ emailId, sourceEmailId, note }) => ({ emailId, sourceEmailId, note }))).toEqual([
      { emailId: "E033", sourceEmailId: "E028", note: "Karen Liu is away until 9 November; for urgent matters call the front desk." },
    ]);
    expect(await repliesOf(e028.summary.runId)).toEqual([]);
    expect((await findEmailWork(testDatabase.db, "E033"))?.notes).toEqual([
      { sourceEmailId: "E028", note: "Karen Liu is away until 9 November; for urgent matters call the front desk." },
    ]);
  });

  it("closes E029 as spam, not as a prospect", async () => {
    const result = await run("E029", [
      callsTool("close_no_action", { reason: "spam", note: "An unsolicited SEO offer from rankboost-seo.example." }),
      repliesWith("Closed as spam."),
    ]);

    expect(result.summary).toMatchObject({ outcome: "no_action", errorClass: null });
    expect(result.record).toMatchObject({ requestKinds: ["no action"], noActionReason: "spam" });
    expect(await routedOf(result.summary.runId)).toEqual([]);
  });

  it("records a clean order's Request kind as a new order", async () => {
    const result = await run("E015", [
      callsTool("propose_new_order", {
        customer_id: "C020",
        ship_to_id: "S023",
        requested_date: "2026-11-05",
        lines: [{ sku: "HPS-1103", quantity: 1 }],
      }),
      repliesWith("Released."),
    ]);

    expect(result.record).toMatchObject({ outcome: "released", requestKinds: ["new order"] });
  });

  describe("the code checks the model's routing", () => {
    async function refusalOf(emailId: string, call: ModelResponse, before: ModelResponse[] = []) {
      const turns = [...before, call, repliesWith("Done.")];
      const result = await run(emailId, turns);
      const refused = result.model.requests[before.length + 1]?.messages.at(-1)?.content[0];
      expect(refused).toMatchObject({ type: "tool_result", isError: true });
      return { result, problem: refused?.type === "tool_result" ? refused.content : "" };
    }

    it("refuses to route a known contact as a prospect", async () => {
      const { problem } = await refusalOf(
        "E009",
        callsTool("route_to_person", { reason: "prospect", summary: "A new company.", reply: "Hi" }),
      );
      expect(problem).toMatch(/known contact of C010/);
    });

    it("refuses a routed Request without a Draft reply", async () => {
      const { result } = await refusalOf("E018", callsTool("route_to_person", { reason: "return", summary: "A return." }));
      expect(await routedOf(result.summary.runId)).toEqual([]);
    });

    it("keeps one Draft reply per email", async () => {
      const { result } = await refusalOf(
        "E030",
        callsTool("draft_reply", { body: "A second reply." }, "call_second_reply"),
        [callsTool("route_to_person", { reason: "billing", summary: "A dispute.", reply: "Hi Maria" })],
      );
      expect(await repliesOf(result.summary.runId)).toEqual(["Hi Maria"]);
    });

    it("gives an email closed as needing no action no Draft reply (U13)", async () => {
      const { result } = await refusalOf(
        "E029",
        callsTool("draft_reply", { body: "Thanks for reaching out." }, "call_spam_reply"),
        [callsTool("close_no_action", { reason: "spam", note: "Spam." })],
      );
      expect(result.summary).toMatchObject({ outcome: "no_action" });
      expect(await repliesOf(result.summary.runId)).toEqual([]);
    });

    it("refuses to close an email that already has a Draft reply", async () => {
      const { result } = await refusalOf("E029", callsTool("close_no_action", { reason: "spam", note: "Spam." }, "call_close"), [
        callsTool("draft_reply", { body: "Thanks for reaching out." }),
      ]);
      expect(result.record.noActionReason).toBeNull();
    });

    it("refuses a duplicate_of on anything but a duplicate", async () => {
      const { result } = await refusalOf(
        "E029",
        callsTool("close_no_action", { reason: "spam", note: "Spam.", duplicate_of: "E001" }),
      );
      expect(result.summary).toMatchObject({ outcome: "failed", errorClass: "no-outcome" });
    });
  });
});
