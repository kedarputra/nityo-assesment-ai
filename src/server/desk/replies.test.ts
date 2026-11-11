import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db/database";
import { agentRuns, auditEvents, draftReplies, replyCompositions, users } from "@/db/schema";
import { ingestSnapshot } from "@/snapshot/snapshot";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import { ReplyRefused, discardReply, findReply, listReplies, replySubject, saveReply } from "./replies";

describe("the reply composer (ADR 0005)", () => {
  let testDatabase: TestDatabase;
  let db: Database;
  let userId: number;
  const at = new Date("2026-11-02T12:00:00Z");

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    db = testDatabase.db;
    await ingestSnapshot(db);
    const [user] = await db.insert(users).values({ username: "ops.reviewer", passwordHash: "x", role: "reviewer" }).returning();
    if (!user) throw new Error("no user");
    userId = user.id;
  });

  afterEach(async () => {
    await testDatabase.close();
  });

  async function agentDraft(emailId: string, runId: string, body: string, startedAt = at) {
    await db.insert(agentRuns).values({ runId, emailId, modelId: "fake", startedAt, endedAt: startedAt, outcome: "routed" });
    await db.insert(draftReplies).values({ runId, emailId, body, createdAt: startedAt });
  }

  it("starts from the agent's Draft reply, to the sender, with RE: before the subject", async () => {
    await agentDraft("E001", "run-1", "Thanks Maria, your order is in.");

    expect(await findReply(db, "E001")).toEqual({
      emailId: "E001",
      to: "maria@bluefinbistro.example",
      subject: "RE: Order for this week",
      body: "Thanks Maria, your order is in.",
      state: "agent-draft",
      updatedAt: at,
      updatedByName: null,
    });
  });

  it("does not double RE: on a subject that already has it", async () => {
    expect((await findReply(db, "E004")).subject).toBe("RE: HV-3391 - update");
    expect(replySubject("re: hello")).toBe("re: hello");
    expect(replySubject("Order")).toBe("RE: Order");
  });

  it("takes the Draft reply of the email's latest run", async () => {
    await agentDraft("E001", "run-old", "Old draft.", new Date(at.getTime() - 60_000));
    await agentDraft("E001", "run-new", "New draft.");

    expect((await findReply(db, "E001")).body).toBe("New draft.");
  });

  it("is empty when there is no draft at all", async () => {
    expect(await findReply(db, "E002")).toMatchObject({ state: "none", body: "", subject: "RE: supplies", to: "admin@sunrisedaycare.example" });
  });

  it("refuses an email that is not in the inbox", async () => {
    await expect(findReply(db, "E999")).rejects.toBeInstanceOf(ReplyRefused);
  });

  it("saves a person's draft, which wins over the agent's, and audits it", async () => {
    await agentDraft("E001", "run-1", "Agent words.");

    await saveReply(db, { emailId: "E001", subject: "RE: Your order", body: "My words.", state: "draft", userId, at });

    expect(await findReply(db, "E001")).toMatchObject({
      subject: "RE: Your order",
      body: "My words.",
      state: "draft",
      updatedAt: at,
      updatedByName: "ops.reviewer",
    });
    const [saved] = await db.select().from(auditEvents);
    expect(saved).toMatchObject({ actor: "person", userId, action: "reply.saved", emailId: "E001" });
    expect(saved?.detail).not.toHaveProperty("wouldSend");
  });

  it("approves a reply for sending, which is logged as would send and never sent", async () => {
    await saveReply(db, { emailId: "E002", subject: "RE: supplies", body: "On its way.", state: "draft", userId, at });
    await saveReply(db, { emailId: "E002", subject: "RE: supplies", body: "On its way Thursday.", state: "ready", userId, at });

    expect(await findReply(db, "E002")).toMatchObject({ state: "ready", body: "On its way Thursday." });
    expect(await db.$count(replyCompositions)).toBe(1);
    const log = await db.select().from(auditEvents).orderBy(asc(auditEvents.id));
    expect(log.map((event) => event.action)).toEqual(["reply.saved", "reply.approved"]);
    expect(log[1]?.detail).toMatchObject({ wouldSend: true, to: "admin@sunrisedaycare.example" });
  });

  it("refuses an empty reply for sending, and a subject or body that is too long", async () => {
    const save = { emailId: "E002", subject: "RE: supplies", body: "ok", state: "draft" as const, userId, at };

    await expect(saveReply(db, { ...save, body: "   ", state: "ready" })).rejects.toBeInstanceOf(ReplyRefused);
    await expect(saveReply(db, { ...save, subject: "x".repeat(201) })).rejects.toBeInstanceOf(ReplyRefused);
    await expect(saveReply(db, { ...save, body: "x".repeat(10_001) })).rejects.toBeInstanceOf(ReplyRefused);
    await expect(saveReply(db, { ...save, emailId: "E999" })).rejects.toBeInstanceOf(ReplyRefused);
    expect(await db.$count(replyCompositions)).toBe(0);
    expect(await db.$count(auditEvents)).toBe(0);
  });

  it("discards the person's composition, leaving the agent's draft to start from again", async () => {
    await agentDraft("E001", "run-1", "Agent words.");
    await saveReply(db, { emailId: "E001", subject: "RE: x", body: "Mine.", state: "draft", userId, at });

    await discardReply(db, { emailId: "E001", userId, at });

    expect(await findReply(db, "E001")).toMatchObject({ state: "agent-draft", body: "Agent words." });
    const [discarded] = await db.select().from(auditEvents).where(eq(auditEvents.action, "reply.discarded"));
    expect(discarded).toMatchObject({ userId, emailId: "E001", detail: { state: "draft" } });
  });

  it("lists each email's reply state for the Drafts folder", async () => {
    await agentDraft("E001", "run-1", "Agent words.");
    await agentDraft("E003", "run-3", "Agent words.");
    await saveReply(db, { emailId: "E003", subject: "RE: PO", body: "Mine.", state: "ready", userId, at });
    await saveReply(db, { emailId: "E005", subject: "RE: Orders", body: "Mine.", state: "draft", userId, at });

    expect(Object.fromEntries(await listReplies(db))).toEqual({ E001: "agent-draft", E003: "ready", E005: "draft" });
  });

  it("shows a Draft reply marked ready on the Proposal pane as ready", async () => {
    await agentDraft("E001", "run-1", "Agent words.");
    await db.update(draftReplies).set({ readyBy: userId, readyAt: at }).where(eq(draftReplies.runId, "run-1"));

    expect(await findReply(db, "E001")).toMatchObject({ state: "ready", updatedByName: "ops.reviewer" });
    expect(await listReplies(db)).toEqual(new Map([["E001", "ready"]]));
  });
});
