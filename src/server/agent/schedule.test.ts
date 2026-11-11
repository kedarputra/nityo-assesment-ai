import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db/database";
import { agentRuns, agentSchedule, auditEvents, inboxRuns, users } from "@/db/schema";
import type { InboxRunChain } from "@/server/inbox/inbox-run";
import { listInboxEmails } from "@/server/inbox/inbox";
import { ingestSnapshot } from "@/snapshot/snapshot";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import { ScheduleRefused, TICK_SLACK_MS, getSchedule, isCronBearer, scheduleTick, setSchedule } from "./schedule";

const AGENT_ON = { GEMINI_API_KEY: "test-key-never-sent" };
const origin = "https://desk.test";

describe("the agent's schedule (ADR 0005)", () => {
  let testDatabase: TestDatabase;
  let db: Database;
  let adminId: number;
  const at = new Date("2026-11-02T12:00:00Z");
  const minutes = (count: number) => new Date(at.getTime() + count * 60_000);

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    db = testDatabase.db;
    await ingestSnapshot(db);
    const [admin] = await db.insert(users).values({ username: "admin", passwordHash: "x", role: "admin" }).returning();
    if (!admin) throw new Error("no admin");
    adminId = admin.id;
  });

  afterEach(async () => {
    await testDatabase.close();
  });

  function tick(when: Date, env: Record<string, string | undefined> = AGENT_ON) {
    const started: InboxRunChain[] = [];
    return { started, result: scheduleTick(db, { at: when, origin, env, start: (chain) => void started.push(chain) }) };
  }

  describe("its settings", () => {
    it("is off, every 15 minutes, until an admin sets it", async () => {
      expect(await getSchedule(db, {})).toEqual({
        enabled: false,
        intervalMinutes: 15,
        lastStartedAt: null,
        nextRunAt: null,
        configured: false,
      });
    });

    it("says whether CRON_SECRET is set on this deploy", async () => {
      expect((await getSchedule(db, { CRON_SECRET: "s" })).configured).toBe(true);
      expect((await getSchedule(db, { CRON_SECRET: "  " })).configured).toBe(false);
    });

    it("is switched on with an interval, audited, and runs at the next tick", async () => {
      await setSchedule(db, { enabled: true, intervalMinutes: 5, userId: adminId, at });

      expect(await getSchedule(db, {})).toMatchObject({ enabled: true, intervalMinutes: 5, nextRunAt: at });
      const [changed] = await db.select().from(auditEvents);
      expect(changed).toMatchObject({ actor: "person", userId: adminId, action: "schedule.changed", detail: { enabled: true, intervalMinutes: 5 } });
    });

    it("refuses an interval other than 5, 10, 15, 30 or 60 minutes", async () => {
      await expect(setSchedule(db, { enabled: true, intervalMinutes: 7, userId: adminId, at })).rejects.toBeInstanceOf(ScheduleRefused);
      expect(await db.$count(agentSchedule)).toBe(0);
    });
  });

  describe("a tick", () => {
    it("does nothing while the schedule is off, but records that it came", async () => {
      expect(await tick(at).result).toBe("disabled");

      await setSchedule(db, { enabled: false, intervalMinutes: 15, userId: adminId, at });
      expect(await tick(minutes(1)).result).toBe("disabled");
      const [row] = await db.select().from(agentSchedule);
      expect(row?.lastTickAt).toEqual(minutes(1));
      expect(await db.$count(inboxRuns)).toBe(0);
    });

    it("does nothing with the agent switched off", async () => {
      await setSchedule(db, { enabled: true, intervalMinutes: 15, userId: adminId, at });

      expect(await tick(minutes(1), {}).result).toBe("agent-off");
      expect(await db.$count(inboxRuns)).toBe(0);
    });

    it("starts a background Run all in the admin's name, and hands the chain on", async () => {
      await setSchedule(db, { enabled: true, intervalMinutes: 15, userId: adminId, at });
      const due = tick(minutes(1));

      expect(await due.result).toBe("started");
      expect(due.started).toHaveLength(1);
      const [run] = await db.select().from(inboxRuns);
      expect(run).toMatchObject({ id: due.started[0]?.inboxRunId, startedBy: adminId, trigger: "schedule", emailIds: null, origin });
      expect(await getSchedule(db, {})).toMatchObject({ lastStartedAt: minutes(1), nextRunAt: minutes(16) });
    });

    it("waits for the interval to pass, give or take a little slack for GitHub's clock", async () => {
      await setSchedule(db, { enabled: true, intervalMinutes: 15, userId: adminId, at });
      await tick(at).result;
      await db.update(inboxRuns).set({ endedAt: at, endReason: "finished" });

      expect(await tick(minutes(10)).result).toBe("not-due");
      expect(await tick(new Date(minutes(15).getTime() - TICK_SLACK_MS - 1)).result).toBe("not-due");
      expect(await tick(new Date(minutes(15).getTime() - TICK_SLACK_MS)).result).toBe("started");
    });

    it("is busy while a run is going", async () => {
      await setSchedule(db, { enabled: true, intervalMinutes: 5, userId: adminId, at });
      await tick(at).result;

      // The first Run all asked for an email a moment ago, so it is still working.
      await db.update(inboxRuns).set({ lastStepAt: minutes(5) });
      expect(await tick(minutes(5)).result).toBe("busy");
    });

    it("is busy while a person's own run is reading an email", async () => {
      await setSchedule(db, { enabled: true, intervalMinutes: 5, userId: adminId, at });
      await db.insert(agentRuns).values({ runId: "reading", emailId: "E001", modelId: "fake", startedAt: at });

      expect(await tick(minutes(1)).result).toBe("busy");
      expect(await db.$count(inboxRuns)).toBe(0);
    });

    it("starts nothing when every email has been read", async () => {
      await setSchedule(db, { enabled: true, intervalMinutes: 5, userId: adminId, at });
      const inbox = await listInboxEmails(db);
      await db.insert(agentRuns).values(
        inbox.map((email) => ({ runId: `done-${email.emailId}`, emailId: email.emailId, modelId: "fake", startedAt: at, endedAt: at, outcome: "no_action" as const })),
      );

      expect(await tick(minutes(1)).result).toBe("nothing-to-read");
      expect(await db.$count(inboxRuns)).toBe(0);
    });

    it("starts nothing in the name of someone who is no longer an admin", async () => {
      await setSchedule(db, { enabled: true, intervalMinutes: 5, userId: adminId, at });
      await db.update(users).set({ role: "reviewer" }).where(eq(users.id, adminId));

      expect(await tick(minutes(1)).result).toBe("disabled");
    });
  });

  describe("the tick's secret", () => {
    it("accepts exactly Bearer <CRON_SECRET>", () => {
      expect(isCronBearer("Bearer s3cret-value", "s3cret-value")).toBe(true);
      expect(isCronBearer("bearer s3cret-value", "s3cret-value")).toBe(true);
      expect(isCronBearer("Bearer s3cret-valu", "s3cret-value")).toBe(false);
      expect(isCronBearer("s3cret-value", "s3cret-value")).toBe(false);
      expect(isCronBearer(null, "s3cret-value")).toBe(false);
      expect(isCronBearer("Bearer ", "")).toBe(false);
    });
  });
});
