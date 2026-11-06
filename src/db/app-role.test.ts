import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgent } from "@/agent/run-agent";
import { recordAudit } from "@/agent/audit";
import { auditEvents, salesOrders } from "@/db/schema";
import { ScriptedModel } from "@/model/scripted-model";
import { ingestSnapshot, resetToSnapshot } from "@/snapshot/snapshot";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import { e001Script } from "@/test/e001-script";

// The role the app's login is a member of (drizzle/0005_app_role.sql).
const APP_ROLE = "harbor_point_app";

// Drizzle wraps the driver's error, so look for Postgres's words along the cause chain.
async function refusal(query: Promise<unknown>): Promise<string> {
  try {
    await query;
  } catch (error) {
    const messages: string[] = [];
    for (let link: unknown = error; link instanceof Error; link = link.cause) messages.push(link.message);
    return messages.join(" <- ");
  }
  return "the query succeeded";
}

describe("the app's database role (security 6)", () => {
  let testDatabase: TestDatabase;

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    await ingestSnapshot(testDatabase.db);
  });

  afterEach(async () => {
    await testDatabase.close();
  });

  async function actAsTheApp(): Promise<void> {
    await testDatabase.db.execute(sql.raw(`set role ${APP_ROLE}`));
  }

  async function actAsTheMigrationRole(): Promise<void> {
    await testDatabase.db.execute(sql`reset role`);
  }

  it("can run the agent on E001 end to end, audit included", async () => {
    const db = testDatabase.db;
    await actAsTheApp();

    const summary = await runAgent(db, new ScriptedModel(e001Script()), { emailId: "E001", modelId: "claude-opus-5-5" });

    expect(summary.outcome).toBe("released");
    expect(await db.$count(salesOrders, eq(salesOrders.soNumber, "SO-24059"))).toBe(1);
    expect(await db.$count(auditEvents, eq(auditEvents.runId, summary.runId))).toBeGreaterThan(0);
  });

  it("can add to and read the audit log, but an UPDATE, a DELETE and a TRUNCATE of it all fail", async () => {
    const db = testDatabase.db;
    await actAsTheApp();
    await recordAudit(db, { at: new Date(), actor: "person", action: "test.recorded", emailId: null, runId: null, detail: {} });
    expect(await db.$count(auditEvents)).toBe(1);

    expect(await refusal(db.update(auditEvents).set({ action: "test.rewritten" }))).toMatch(/permission denied/);
    expect(await refusal(db.delete(auditEvents))).toMatch(/permission denied/);
    expect(await refusal(db.execute(sql`truncate table audit_events`))).toMatch(/permission denied/);

    await actAsTheMigrationRole();
    const [event] = await db.select().from(auditEvents);
    expect(event?.action).toBe("test.recorded");
  });

  it("leaves the Reset, which runs as the migration role, able to empty the audit log", async () => {
    const db = testDatabase.db;
    await actAsTheApp();
    await runAgent(db, new ScriptedModel(e001Script()), { emailId: "E001", modelId: "claude-opus-5-5" });
    expect(await refusal(resetToSnapshot(db))).toMatch(/permission denied/);

    await actAsTheMigrationRole();
    await resetToSnapshot(db);

    expect(await db.$count(auditEvents)).toBe(0);
    expect(await db.$count(salesOrders, eq(salesOrders.soNumber, "SO-24059"))).toBe(0);
  });
});
