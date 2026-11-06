import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordAudit } from "@/agent/audit";
import { users } from "@/db/schema";
import { ingestSnapshot } from "@/snapshot/snapshot";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import { listAuditEvents } from "./audit-log";

describe("listAuditEvents", () => {
  let testDatabase: TestDatabase;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await ingestSnapshot(testDatabase.db);
  });

  afterAll(async () => {
    await testDatabase.close();
  });

  it("lists events newest first, with the person's name when there is one", async () => {
    const db = testDatabase.db;
    const [user] = await db
      .insert(users)
      .values({ username: "ops.reviewer", passwordHash: "not a real hash", role: "reviewer" })
      .returning({ id: users.id });
    const at = new Date("2026-11-02T12:03:00Z");
    await recordAudit(db, { at, actor: "agent", userId: user?.id, action: "run.started", emailId: "E001", runId: null, detail: {} });
    await recordAudit(db, { at, actor: "gate", action: "gate.verdict", emailId: "E001", runId: null, detail: { verdict: "released" } });

    const events = await listAuditEvents(db);

    expect(events.map((event) => [event.action, event.username])).toEqual([
      ["gate.verdict", null],
      ["run.started", "ops.reviewer"],
    ]);
  });
});
