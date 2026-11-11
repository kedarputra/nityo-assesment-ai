import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db/database";
import { auditEvents, emailLabels, users } from "@/db/schema";
import { ingestSnapshot } from "@/snapshot/snapshot";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import { LABEL_EXISTS, TriageRefused, createLabel, deleteLabel, listLabels, listTriage, setLabels, setTriage } from "./triage";

describe("a person's triage (ADR 0005)", () => {
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

  async function audit() {
    return db.select().from(auditEvents).orderBy(asc(auditEvents.id));
  }

  describe("labels", () => {
    it("creates a label with a trimmed name, and audits it", async () => {
      const label = await createLabel(db, { name: "  Rush   order ", color: "apricot", userId, at });

      expect(label).toEqual({ id: expect.any(Number), name: "Rush order", color: "apricot" });
      expect(await audit()).toEqual([
        expect.objectContaining({
          actor: "person",
          userId,
          action: "label.created",
          detail: { labelId: label.id, name: "Rush order", color: "apricot" },
        }),
      ]);
    });

    it("refuses a name another label has, whatever its case", async () => {
      await createLabel(db, { name: "Rush", color: "apricot", userId, at });

      await expect(createLabel(db, { name: " rUSH ", color: "green", userId, at })).rejects.toThrow(new TriageRefused(LABEL_EXISTS));
      expect(await listLabels(db)).toHaveLength(1);
    });

    it("refuses an empty name and one past 40 characters", async () => {
      await expect(createLabel(db, { name: "   ", color: "grey", userId, at })).rejects.toBeInstanceOf(TriageRefused);
      await expect(createLabel(db, { name: "x".repeat(41), color: "grey", userId, at })).rejects.toBeInstanceOf(TriageRefused);
      await expect(createLabel(db, { name: "x".repeat(40), color: "grey", userId, at })).resolves.toMatchObject({ name: "x".repeat(40) });
    });

    it("lists labels by name, each with how many emails carry it", async () => {
      const vip = await createLabel(db, { name: "VIP", color: "dusk", userId, at });
      const billing = await createLabel(db, { name: "billing", color: "red", userId, at });
      await setLabels(db, { emailIds: ["E001", "E002"], add: [vip.id], remove: [], userId, at });

      expect(await listLabels(db)).toEqual([
        { id: billing.id, name: "billing", color: "red", count: 0 },
        { id: vip.id, name: "VIP", color: "dusk", count: 2 },
      ]);
    });

    it("deletes a label and takes it off every email, and audits which", async () => {
      const vip = await createLabel(db, { name: "VIP", color: "dusk", userId, at });
      await setLabels(db, { emailIds: ["E003", "E001"], add: [vip.id], remove: [], userId, at });

      await deleteLabel(db, { labelId: vip.id, userId, at });

      expect(await listLabels(db)).toEqual([]);
      expect(await db.$count(emailLabels)).toBe(0);
      const [deleted] = await db.select().from(auditEvents).where(eq(auditEvents.action, "label.deleted"));
      expect(deleted).toMatchObject({ userId, detail: { labelId: vip.id, name: "VIP", emailIds: ["E001", "E003"] } });
      await expect(deleteLabel(db, { labelId: vip.id, userId, at })).rejects.toBeInstanceOf(TriageRefused);
    });
  });

  describe("putting labels on emails", () => {
    it("adds and removes labels on many emails at once, and audits the change once", async () => {
      const vip = await createLabel(db, { name: "VIP", color: "dusk", userId, at });
      const rush = await createLabel(db, { name: "Rush", color: "pumpkin", userId, at });
      await setLabels(db, { emailIds: ["E001", "E002", "E003"], add: [vip.id, rush.id], remove: [], userId, at });

      await setLabels(db, { emailIds: ["E002", "E003"], add: [], remove: [rush.id], userId, at });

      const triage = await listTriage(db);
      expect(triage.get("E001")).toEqual({ emailId: "E001", status: "new", flag: "none", labelIds: [vip.id, rush.id].sort((a, b) => a - b) });
      expect(triage.get("E002")?.labelIds).toEqual([vip.id]);
      expect(triage.get("E004")).toBeUndefined();
      const changes = await db.select().from(auditEvents).where(eq(auditEvents.action, "labels.changed")).orderBy(asc(auditEvents.id));
      expect(changes.map((event) => event.detail)).toEqual([
        { added: ["Rush", "VIP"], removed: [], emailIds: ["E001", "E002", "E003"] },
        { added: [], removed: ["Rush"], emailIds: ["E002", "E003"] },
      ]);
      expect(changes.map((event) => event.emailId)).toEqual([null, null]);
    });

    it("is idempotent: applying what is already there changes nothing and records nothing", async () => {
      const vip = await createLabel(db, { name: "VIP", color: "dusk", userId, at });
      await setLabels(db, { emailIds: ["E001"], add: [vip.id], remove: [], userId, at });
      const before = (await audit()).length;

      await setLabels(db, { emailIds: ["E001"], add: [vip.id], remove: [], userId, at });
      await setLabels(db, { emailIds: ["E002"], add: [], remove: [vip.id], userId, at });

      expect(await db.$count(emailLabels)).toBe(1);
      expect(await audit()).toHaveLength(before);
    });

    it("names the email on an audit event about one email", async () => {
      const vip = await createLabel(db, { name: "VIP", color: "dusk", userId, at });

      await setLabels(db, { emailIds: ["E007"], add: [vip.id], remove: [], userId, at });

      const [change] = await db.select().from(auditEvents).where(eq(auditEvents.action, "labels.changed"));
      expect(change?.emailId).toBe("E007");
    });

    it("refuses a label that no longer exists, or an email not in the inbox, and changes nothing", async () => {
      const vip = await createLabel(db, { name: "VIP", color: "dusk", userId, at });

      await expect(setLabels(db, { emailIds: ["E001"], add: [vip.id + 99], remove: [], userId, at })).rejects.toBeInstanceOf(TriageRefused);
      await expect(setLabels(db, { emailIds: ["E001", "E999"], add: [vip.id], remove: [], userId, at })).rejects.toBeInstanceOf(TriageRefused);
      expect(await db.$count(emailLabels)).toBe(0);
    });
  });

  describe("status and flag", () => {
    it("sets a status on many emails at once, keeping each one's flag", async () => {
      await setTriage(db, { emailIds: ["E001"], flag: "follow-up", userId, at });

      await setTriage(db, { emailIds: ["E001", "E002"], status: "in-progress", userId, at });

      const triage = await listTriage(db);
      expect(triage.get("E001")).toEqual({ emailId: "E001", status: "in-progress", flag: "follow-up", labelIds: [] });
      expect(triage.get("E002")).toEqual({ emailId: "E002", status: "in-progress", flag: "none", labelIds: [] });
    });

    it("audits what changed and on which emails", async () => {
      await setTriage(db, { emailIds: ["E005", "E004"], status: "waiting", flag: "complete", userId, at });

      expect(await audit()).toEqual([
        expect.objectContaining({
          actor: "person",
          userId,
          action: "triage.changed",
          emailId: null,
          detail: { status: "waiting", flag: "complete", emailIds: ["E004", "E005"] },
        }),
      ]);
    });

    it("refuses a change with neither a status nor a flag", async () => {
      await expect(setTriage(db, { emailIds: ["E001"], userId, at })).rejects.toBeInstanceOf(TriageRefused);
    });

    it("refuses an email that is not in the inbox", async () => {
      await expect(setTriage(db, { emailIds: ["E999"], status: "done", userId, at })).rejects.toBeInstanceOf(TriageRefused);
      expect(await audit()).toEqual([]);
    });
  });
});
