import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgent } from "@/agent/run-agent";
import {
  auditEvents,
  draftReplies,
  inventory,
  proposalLines,
  proposals,
  salesOrderLines,
  salesOrders,
  users,
} from "@/db/schema";
import { ScriptedModel } from "@/model/scripted-model";
import { ingestSnapshot } from "@/snapshot/snapshot";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import { e007Script, e012Script, e019Script } from "@/test/review-scripts";
import type { ModelResponse } from "@/model/model";
import {
  approveProposal,
  editProposal,
  markReplyReady,
  ReviewRefused,
  searchProducts,
  setProposalAside,
  undoRelease,
  UNDO_WINDOW_MS,
} from "./review";

const MODEL_ID = "claude-opus-5-5";
const AT = new Date("2026-11-02T14:00:00Z");
const later = (ms: number) => new Date(AT.getTime() + ms);

describe("reviewing a Proposal", () => {
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

  async function proposalFor(emailId: string, script: ModelResponse[]) {
    const summary = await runAgent(testDatabase.db, new ScriptedModel(script), { emailId, modelId: MODEL_ID });
    expect(summary).toMatchObject({ outcome: "proposal", gateVerdict: "review" });
    const [proposal] = await testDatabase.db.select().from(proposals).where(eq(proposals.runId, summary.runId));
    if (!proposal) throw new Error(`no Proposal for ${emailId}`);
    return proposal;
  }

  async function proposalNow(id: number) {
    const [proposal] = await testDatabase.db.select().from(proposals).where(eq(proposals.id, id));
    if (!proposal) throw new Error(`no Proposal ${id}`);
    return proposal;
  }

  async function available(sku: string): Promise<number> {
    const [row] = await testDatabase.db.select().from(inventory).where(eq(inventory.sku, sku));
    if (!row) throw new Error(`no inventory for ${sku}`);
    return row.available;
  }

  async function personEvents(emailId: string) {
    return testDatabase.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.emailId, emailId), eq(auditEvents.actor, "person")))
      .orderBy(asc(auditEvents.id));
  }

  describe("E019, a product swap (soft)", () => {
    it("refuses to approve until the swap has a note, then releases HPS-1001 and records the override and the approval", async () => {
      const db = testDatabase.db;
      const proposal = await proposalFor("E019", e019Script());
      expect(proposal.checks.filter((check) => !check.passes).map((check) => check.check)).toEqual(["no-substitution"]);

      const refused = await approveProposal(db, {
        proposalId: proposal.id,
        userId,
        notes: { "no-substitution": "  " },
        at: AT,
      });
      expect(refused).toEqual({ released: false, hardRules: [], missingNotes: ["no-substitution"] });
      expect((await proposalNow(proposal.id)).status).toBe("open");
      expect(await available("HPS-1001")).toBe(60);

      const approved = await approveProposal(db, {
        proposalId: proposal.id,
        userId,
        notes: { "no-substitution": "James confirmed nitrile by phone." },
        at: AT,
      });

      expect(approved).toEqual({
        released: true,
        emailId: "E019",
        soNumber: "SO-24059",
        totalCents: 27200,
        customerName: "Northside Community Center",
      });
      expect(await proposalNow(proposal.id)).toMatchObject({
        status: "released",
        soNumber: "SO-24059",
        decidedBy: userId,
      });
      const lines = await db.select().from(salesOrderLines).where(eq(salesOrderLines.soNumber, "SO-24059"));
      expect(lines.map(({ sku, qtyOrdered, unitPriceCents }) => ({ sku, qtyOrdered, unitPriceCents }))).toEqual([
        { sku: "HPS-1001", qtyOrdered: 4, unitPriceCents: 6800 },
      ]);
      expect(await available("HPS-1001")).toBe(56);

      const events = await personEvents("E019");
      expect(events.map((event) => [event.action, event.userId])).toEqual([
        ["proposal.approval_refused", userId],
        ["proposal.override", userId],
        ["proposal.approved", userId],
      ]);
      expect(events[1]?.detail).toMatchObject({ check: "no-substitution", note: "James confirmed nitrile by phone." });
      expect(events[2]?.detail).toMatchObject({ soNumber: "SO-24059", totalCents: 27200 });
    });

    it("undoes the release within 10 seconds: the order goes, the stock comes back, the Proposal reopens", async () => {
      const db = testDatabase.db;
      const proposal = await proposalFor("E019", e019Script());
      await approveProposal(db, { proposalId: proposal.id, userId, notes: { "no-substitution": "Confirmed." }, at: AT });

      const undone = await undoRelease(db, { proposalId: proposal.id, userId, at: later(UNDO_WINDOW_MS - 1) });

      expect(undone).toEqual({ soNumber: "SO-24059", emailId: "E019" });
      expect(await available("HPS-1001")).toBe(60);
      expect(await db.select().from(salesOrders).where(eq(salesOrders.soNumber, "SO-24059"))).toEqual([]);
      expect(await proposalNow(proposal.id)).toMatchObject({ status: "open", soNumber: null, decidedBy: null });
      const events = await personEvents("E019");
      expect(events.at(-1)).toMatchObject({ action: "release.undone", userId });
      expect(events.at(-1)?.detail).toMatchObject({
        soNumber: "SO-24059",
        returned: [{ sku: "HPS-1001", quantity: 4 }],
      });

      // Approved again, it takes a new number: SO-24059 stays the withdrawn order's alone.
      const again = await approveProposal(db, {
        proposalId: proposal.id,
        userId,
        notes: { "no-substitution": "Confirmed." },
        at: later(20_000),
      });
      expect(again).toMatchObject({ released: true, soNumber: "SO-24060" });
    });

    it("makes the release final after 10 seconds", async () => {
      const db = testDatabase.db;
      const proposal = await proposalFor("E019", e019Script());
      await approveProposal(db, { proposalId: proposal.id, userId, notes: { "no-substitution": "Confirmed." }, at: AT });

      await expect(
        undoRelease(db, { proposalId: proposal.id, userId, at: later(UNDO_WINDOW_MS + 1) }),
      ).rejects.toBeInstanceOf(ReviewRefused);
      expect(await available("HPS-1001")).toBe(56);
      expect((await proposalNow(proposal.id)).status).toBe("released");
    });

    it("lets a person edit the quantity and the SKU, records each edit and re-runs the checks at once", async () => {
      const db = testDatabase.db;
      const proposal = await proposalFor("E019", e019Script());

      // 61 cases of HPS-1001 is more than the 60 available, and $4,148.00 is over the $3,000.00 limit.
      const afterQuantity = await editProposal(db, {
        proposalId: proposal.id,
        userId,
        edit: { kind: "quantity", lineNo: 1, quantity: 61 },
        at: AT,
      });
      expect(afterQuantity.filter((check) => !check.passes).map((check) => check.check)).toEqual([
        "no-substitution",
        "full-stock",
        "credit-limit",
      ]);
      expect(await proposalNow(proposal.id)).toMatchObject({ totalCents: 61 * 6800 });

      // Back to the discontinued HPS-1004 at $45.00: within the limit again, but a hard rule fails.
      const afterSku = await editProposal(db, {
        proposalId: proposal.id,
        userId,
        edit: { kind: "sku", lineNo: 1, sku: "HPS-1004" },
        at: AT,
      });
      expect(afterSku.filter((check) => !check.passes).map((check) => check.check)).toEqual([
        "skus-sellable",
        "no-substitution",
        "full-stock",
      ]);
      const [line] = await db.select().from(proposalLines).where(eq(proposalLines.proposalId, proposal.id));
      expect(line).toMatchObject({ sku: "HPS-1004", quantity: 61, unitPriceCents: 4500 });

      const events = await testDatabase.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.emailId, "E019"))
        .orderBy(asc(auditEvents.id));
      const edits = events.filter((event) => event.action === "proposal.edited");
      expect(edits.map((event) => [event.userId, event.detail.edit, event.detail.before])).toEqual([
        [userId, { kind: "quantity", lineNo: 1, quantity: 61 }, { sku: "HPS-1001", quantity: 4 }],
        [userId, { kind: "sku", lineNo: 1, sku: "HPS-1004" }, { sku: "HPS-1001", quantity: 61 }],
      ]);
      expect(events.filter((event) => event.action === "gate.verdict" && event.detail.recheck === true)).toHaveLength(
        2,
      );
    });

    it("adds and removes lines and changes the ship-to only among the customer's own", async () => {
      const db = testDatabase.db;
      const proposal = await proposalFor("E019", e019Script());

      await editProposal(db, {
        proposalId: proposal.id,
        userId,
        edit: { kind: "add-line", sku: "HPS-1002", quantity: 2 },
        at: AT,
      });
      let lines = await db
        .select()
        .from(proposalLines)
        .where(eq(proposalLines.proposalId, proposal.id))
        .orderBy(asc(proposalLines.lineNo));
      expect(lines.map((line) => [line.lineNo, line.sku, line.quantity])).toEqual([
        [1, "HPS-1001", 4],
        [2, "HPS-1002", 2],
      ]);

      await editProposal(db, { proposalId: proposal.id, userId, edit: { kind: "remove-line", lineNo: 2 }, at: AT });
      lines = await db.select().from(proposalLines).where(eq(proposalLines.proposalId, proposal.id));
      expect(lines.map((line) => line.sku)).toEqual(["HPS-1001"]);

      await expect(
        editProposal(db, { proposalId: proposal.id, userId, edit: { kind: "remove-line", lineNo: 1 }, at: AT }),
      ).rejects.toBeInstanceOf(ReviewRefused);
      // S001 is Bluefin Bistro's, not Northside's.
      await expect(
        editProposal(db, { proposalId: proposal.id, userId, edit: { kind: "ship-to", shipToId: "S001" }, at: AT }),
      ).rejects.toBeInstanceOf(ReviewRefused);
      expect((await proposalNow(proposal.id)).shipToId).toBe("S018");
    });

    it("has no way to edit the price or the customer", async () => {
      const db = testDatabase.db;
      const proposal = await proposalFor("E019", e019Script());

      for (const edit of [
        { kind: "price", lineNo: 1, unitPriceCents: 100 },
        { kind: "customer", customerId: "C001" },
        { kind: "quantity", lineNo: 1, quantity: 4, unitPriceCents: 100 },
      ]) {
        await expect(
          editProposal(db, { proposalId: proposal.id, userId, edit: edit as never, at: AT }),
        ).rejects.toThrow();
      }
      expect(await proposalNow(proposal.id)).toMatchObject({ customerId: "C015", totalCents: 27200 });
    });
  });

  describe("E007, credit hold and over the limit (hard)", () => {
    it("refuses an approval even with a note for every failing check, and releases nothing", async () => {
      const db = testDatabase.db;
      const proposal = await proposalFor("E007", e007Script());

      const result = await approveProposal(db, {
        proposalId: proposal.id,
        userId,
        notes: { "credit-hold": "Accounts said it is fine.", "credit-limit": "Only a little over." },
        at: AT,
      });

      expect(result).toMatchObject({ released: false, missingNotes: [] });
      expect(result.released === false && result.hardRules.map((check) => check.check)).toEqual([
        "credit-hold",
        "credit-limit",
      ]);
      expect(await proposalNow(proposal.id)).toMatchObject({ status: "open", soNumber: null });
      expect(await available("HPS-1408")).toBe(30);
      const events = await personEvents("E007");
      expect(events.map((event) => event.action)).toEqual(["proposal.approval_refused"]);
      expect(events.filter((event) => event.action === "proposal.override")).toEqual([]);
    });

    it("holds with a reason, then rejects with a reason; a decided Proposal cannot be approved", async () => {
      const db = testDatabase.db;
      const proposal = await proposalFor("E007", e007Script());

      await expect(
        setProposalAside(db, { proposalId: proposal.id, userId, kind: "hold", reason: "   ", at: AT }),
      ).rejects.toBeInstanceOf(ReviewRefused);
      await setProposalAside(db, {
        proposalId: proposal.id,
        userId,
        kind: "hold",
        reason: "Waiting for accounts to call back.",
        at: AT,
      });
      expect(await proposalNow(proposal.id)).toMatchObject({
        status: "held",
        decidedBy: userId,
        decisionReason: "Waiting for accounts to call back.",
      });

      await setProposalAside(db, {
        proposalId: proposal.id,
        userId,
        kind: "reject",
        reason: "Accounts won't lift the hold.",
        at: later(1),
      });
      expect(await proposalNow(proposal.id)).toMatchObject({
        status: "rejected",
        decisionReason: "Accounts won't lift the hold.",
      });

      await expect(
        approveProposal(db, { proposalId: proposal.id, userId, notes: {}, at: later(2) }),
      ).rejects.toBeInstanceOf(ReviewRefused);
      const events = await personEvents("E007");
      expect(events.map((event) => [event.action, event.detail.reason])).toEqual([
        ["proposal.held", "Waiting for accounts to call back."],
        ["proposal.rejected", "Accounts won't lift the hold."],
      ]);
    });
  });

  describe("E012, an instruction inside the email (soft)", () => {
    it("releases at system prices, with no discount, once the flag has a note", async () => {
      const db = testDatabase.db;
      const proposal = await proposalFor("E012", e012Script());
      expect(proposal.totalCents).toBe(14100);

      const result = await approveProposal(db, {
        proposalId: proposal.id,
        userId,
        notes: { "no-flags": "Ignored the note in the email; standard prices." },
        at: AT,
      });

      expect(result).toMatchObject({ released: true, totalCents: 14100, customerName: "Maple Leaf Bakery" });
      const soNumber = result.released ? result.soNumber : "";
      const lines = await db
        .select()
        .from(salesOrderLines)
        .where(eq(salesOrderLines.soNumber, soNumber))
        .orderBy(asc(salesOrderLines.lineNo));
      expect(lines.map(({ sku, qtyOrdered, unitPriceCents }) => [sku, qtyOrdered, unitPriceCents])).toEqual([
        ["HPS-1502", 3, 3300],
        ["HPS-1501", 2, 2100],
      ]);
    });

    it("lets the Draft reply be edited and marked ready once, recording who; it is never sent", async () => {
      const db = testDatabase.db;
      await proposalFor("E012", e012Script());
      const body = "Hi Hannah,\n\nYour order is on its way at standard prices, $141.00.\n\nHarbor Point";

      await markReplyReady(db, { emailId: "E012", userId, body, at: AT });

      const [reply] = await db.select().from(draftReplies).where(eq(draftReplies.emailId, "E012"));
      expect(reply).toMatchObject({ body, readyBy: userId, readyAt: AT });
      await expect(
        markReplyReady(db, { emailId: "E012", userId, body: "changed", at: later(1) }),
      ).rejects.toBeInstanceOf(ReviewRefused);
      expect((await personEvents("E012")).map((event) => [event.action, event.detail.edited])).toEqual([
        ["reply.ready", true],
      ]);
    });
  });

  it("finds products by SKU or name, active ones first", async () => {
    const matches = await searchProducts(testDatabase.db, "vinyl gloves");
    expect(matches.map((match) => match.sku)).toContain("HPS-1004");
    expect(matches.at(-1)?.status).toBe("DISCONTINUED");
    expect(await searchProducts(testDatabase.db, "   ")).toEqual([]);
  });
});
