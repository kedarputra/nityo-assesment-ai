import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEADLINE_MARGIN_MS } from "@/agent/run-agent";
import type { Database } from "@/db/database";
import { agentRuns, auditEvents, emails, inboxRuns, inventory, proposals, rateLimitEvents, sessions, users } from "@/db/schema";
import { SpendLimitReached, type Model, type ModelResponse } from "@/model/model";
import { ScriptedModel, callsTool, repliesWith } from "@/model/scripted-model";
import { RATE_LIMITS, RateLimited } from "@/server/rate-limits";
import { ingestSnapshot } from "@/snapshot/snapshot";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import { e001Script } from "@/test/e001-script";
import {
  INBOX_RUN_ENDED,
  InboxRunRefused,
  RUN_ALL_ALREADY_GOING,
  STEP_GRACE_MS,
  finishInboxRun,
  isInboxRunToken,
  nextEmailOf,
  runChainStep,
  runInboxRunStep,
  startBackgroundInboxRun,
  startInboxRun,
  stopInboxRun,
  type InboxRunChain,
} from "./inbox-run";
import { findInboxEmail, listInboxEmails } from "./inbox";
import { RUN_IN_PROGRESS, ResetRefused, resetInbox } from "./reset";

const MODEL_ID = "claude-opus-5-5";

// A fake model that closes whatever email it reads as spam: enough to mark an email processed.
function closesAsSpam(): ScriptedModel {
  return new ScriptedModel([callsTool("close_no_action", { reason: "spam", note: "Nothing for us." }), repliesWith("Closed.")]);
}

// A model that never answers until the test lets it, so a run can be caught while it is reading.
function heldModel(): { model: Model; release: () => void; asked: Promise<void> } {
  let release = () => {};
  let markAsked = () => {};
  const asked = new Promise<void>((resolve) => (markAsked = resolve));
  const answer = new Promise<void>((resolve) => (release = resolve));
  const model: Model = {
    async send(): Promise<ModelResponse> {
      markAsked();
      await answer;
      throw new Error("released without an answer");
    },
  };
  return { model, release, asked };
}

describe("an Inbox run", () => {
  let testDatabase: TestDatabase;
  let db: Database;
  let adminId: number;
  const start = new Date("2026-11-02T12:00:00Z");

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

  function step(inboxRunId: number, emailId: string, model: Model, at = start) {
    return runInboxRunStep(db, model, { inboxRunId, emailId, userId: adminId, modelId: MODEL_ID, now: () => at });
  }

  it("plans every unprocessed email in received_at order, each with its place in the day", async () => {
    const plan = await startInboxRun(db, { userId: adminId, at: start });

    const inbox = await listInboxEmails(db);
    expect(plan.total).toBe(40);
    expect(plan.emails.map((email) => email.emailId)).toEqual(inbox.map((email) => email.emailId));
    expect(plan.emails.map((email) => email.position)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
    const received = await db.select({ emailId: emails.emailId }).from(emails).orderBy(asc(emails.receivedAt), asc(emails.emailId));
    expect(plan.emails.map((email) => email.emailId)).toEqual(received.map((email) => email.emailId));
  });

  it("resumes from the first unprocessed email after the tab was closed, and keeps a failed email in the plan", async () => {
    const first = await startInboxRun(db, { userId: adminId, at: start });
    const [one, two, three] = first.emails;
    if (!one || !two || !three) throw new Error("too few emails");
    await step(first.inboxRunId, one.emailId, closesAsSpam());
    // The model fails on the second email, so it is left for the next Run all.
    await step(first.inboxRunId, two.emailId, new ScriptedModel([]));
    // The tab closes here: nothing finishes the Inbox run.

    const later = new Date(start.getTime() + STEP_GRACE_MS + 1_000);
    const resumed = await startInboxRun(db, { userId: adminId, at: later });

    expect(resumed.emails.map((email) => email.emailId).slice(0, 2)).toEqual([two.emailId, three.emailId]);
    expect(resumed.emails).toHaveLength(39);
    const [abandoned] = await db.select().from(inboxRuns).where(eq(inboxRuns.id, first.inboxRunId));
    expect(abandoned).toMatchObject({ endReason: "abandoned" });
  });

  it("refuses a second Inbox run while one is reading an email", async () => {
    const plan = await startInboxRun(db, { userId: adminId, at: start });
    const held = heldModel();
    const reading = runInboxRunStep(db, held.model, { inboxRunId: plan.inboxRunId, emailId: "E001", userId: adminId, modelId: MODEL_ID });
    await held.asked;

    await expect(startInboxRun(db, { userId: adminId, at: new Date() })).rejects.toThrow(new InboxRunRefused(RUN_ALL_ALREADY_GOING));

    held.release();
    await reading;
  });

  it("refuses a second Inbox run started a moment after the first asked for an email", async () => {
    await startInboxRun(db, { userId: adminId, at: start });

    await expect(startInboxRun(db, { userId: adminId, at: new Date(start.getTime() + 1_000) })).rejects.toBeInstanceOf(InboxRunRefused);
  });

  it("reads no further email once stopped", async () => {
    const plan = await startInboxRun(db, { userId: adminId, at: start });
    await step(plan.inboxRunId, "E001", new ScriptedModel(e001Script()));

    expect(await stopInboxRun(db, { userId: adminId, at: start })).toBe(true);

    await expect(step(plan.inboxRunId, "E002", closesAsSpam())).rejects.toThrow(new InboxRunRefused(INBOX_RUN_ENDED));
    expect(await findInboxEmail(db, "E002")).toMatchObject({ status: "not_run" });
    const stops = await db.select().from(auditEvents).where(eq(auditEvents.action, "inbox_run.ended"));
    expect(stops).toEqual([expect.objectContaining({ userId: adminId, detail: { inboxRunId: plan.inboxRunId, reason: "stopped" } })]);
  });

  it("ends an email that reaches its deadline as timed out, and leaves it for the next Run all", async () => {
    const plan = await startInboxRun(db, { userId: adminId, at: start });
    const model = closesAsSpam();

    const summary = await runInboxRunStep(db, model, {
      inboxRunId: plan.inboxRunId,
      emailId: "E001",
      userId: adminId,
      modelId: MODEL_ID,
      deadline: new Date(start.getTime() + DEADLINE_MARGIN_MS - 1),
      now: () => start,
    });

    expect(summary).toMatchObject({ outcome: "failed", errorClass: "deadline" });
    expect(model.requests).toHaveLength(0);
    await finishInboxRun(db, { inboxRunId: plan.inboxRunId, userId: adminId, at: start });
    const next = await startInboxRun(db, { userId: adminId, at: start });
    expect(next.emails[0]?.emailId).toBe("E001");
  });

  it("stops the whole Inbox run at a spend limit, never retrying", async () => {
    const plan = await startInboxRun(db, { userId: adminId, at: start });
    let calls = 0;
    const capped: Model = {
      async send() {
        calls += 1;
        throw new SpendLimitReached();
      },
    };

    const summary = await step(plan.inboxRunId, "E001", capped);

    expect(calls).toBe(1);
    expect(summary).toMatchObject({ outcome: "failed", errorClass: "spend-limit" });
    const [ended] = await db.select().from(inboxRuns).where(eq(inboxRuns.id, plan.inboxRunId));
    expect(ended).toMatchObject({ endReason: "spend-limit" });
    await expect(step(plan.inboxRunId, "E002", closesAsSpam())).rejects.toBeInstanceOf(InboxRunRefused);
  });

  it("doesn't count Run all's emails against the person's agent-run limit, which 40 emails would pass", async () => {
    const plan = await startInboxRun(db, { userId: adminId, at: start });
    const hourAgo = new Date(start.getTime() - 60 * 60 * 1000 + 60_000);
    await db.insert(rateLimitEvents).values(
      Array.from({ length: RATE_LIMITS["agent-run"] }, () => ({ userId: adminId, action: "agent-run" as const, at: hourAgo })),
    );

    await expect(step(plan.inboxRunId, "E001", closesAsSpam())).resolves.toMatchObject({ outcome: "no_action" });
    expect(await db.$count(rateLimitEvents)).toBe(RATE_LIMITS["agent-run"]);
  });
});

describe("Run all in the background (ADR 0004)", () => {
  let testDatabase: TestDatabase;
  let db: Database;
  let adminId: number;
  const start = new Date("2026-11-02T12:00:00Z");
  const origin = "https://desk.test";

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

  function deps(model: Model = closesAsSpam()) {
    const triggered: { chain: InboxRunChain; origin: string }[] = [];
    return {
      triggered,
      deps: {
        model,
        modelId: MODEL_ID,
        now: () => start,
        triggerNext: async (chain: InboxRunChain, at: string) => {
          triggered.push({ chain, origin: at });
        },
      },
    };
  }

  it("keeps only a hash of the run's secret, and accepts the secret alone", async () => {
    const chain = await startBackgroundInboxRun(db, { userId: adminId, at: start, origin });

    const [stored] = await db.select().from(inboxRuns).where(eq(inboxRuns.id, chain.inboxRunId));
    expect(stored?.stepTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.stepTokenHash).not.toBe(chain.token);
    expect(stored?.origin).toBe(origin);
    expect(await isInboxRunToken(db, chain)).toBe(true);
    expect(await isInboxRunToken(db, { ...chain, token: "0".repeat(64) })).toBe(false);
    expect(await isInboxRunToken(db, { ...chain, inboxRunId: chain.inboxRunId + 1 })).toBe(false);
  });

  it("reads one email per step, in received order, and asks for the next at the admin's address", async () => {
    const chain = await startBackgroundInboxRun(db, { userId: adminId, at: start, origin });
    const first = deps();
    const second = deps();

    expect(await runChainStep(db, chain, first.deps)).toBe("read");
    expect(await runChainStep(db, chain, second.deps)).toBe("read");

    expect(await findInboxEmail(db, "E001")).toMatchObject({ status: "no_action" });
    expect(await findInboxEmail(db, "E002")).toMatchObject({ status: "no_action" });
    expect(await findInboxEmail(db, "E003")).toMatchObject({ status: "not_run" });
    expect(first.triggered).toEqual([{ chain, origin }]);
  });

  it("stops after Stop: the next step reads nothing and asks for nothing", async () => {
    const chain = await startBackgroundInboxRun(db, { userId: adminId, at: start, origin });
    await stopInboxRun(db, { userId: adminId, at: start });
    const next = deps();

    expect(await runChainStep(db, chain, next.deps)).toBe("ended");
    expect(await db.$count(agentRuns)).toBe(0);
    expect(next.triggered).toEqual([]);
  });

  it("moves past an email that failed instead of trying it again in a loop", async () => {
    const chain = await startBackgroundInboxRun(db, { userId: adminId, at: start, origin });
    const broken: Model = {
      async send(): Promise<ModelResponse> {
        throw new Error("the model broke");
      },
    };

    await runChainStep(db, chain, deps(broken).deps);
    expect(await findInboxEmail(db, "E001")).toMatchObject({ status: "failed" });

    await runChainStep(db, chain, deps().deps);
    expect(await findInboxEmail(db, "E002")).toMatchObject({ status: "no_action" });
    expect(await nextEmailOf(db, chain.inboxRunId)).toBe("E003");
  });

  it("finishes the run when no email is left, and asks for nothing more", async () => {
    const chain = await startBackgroundInboxRun(db, { userId: adminId, at: start, origin });
    const inbox = await listInboxEmails(db);
    // Every email but the last already has an outcome from this run.
    await db.insert(agentRuns).values(
      inbox.slice(0, -1).map((email) => ({
        runId: `done-${email.emailId}`,
        emailId: email.emailId,
        modelId: MODEL_ID,
        startedAt: start,
        endedAt: start,
        outcome: "no_action" as const,
        inboxRunId: chain.inboxRunId,
      })),
    );
    const last = deps();

    expect(await runChainStep(db, chain, last.deps)).toBe("read");
    expect(await runChainStep(db, chain, deps().deps)).toBe("finished");
    const [ended] = await db.select().from(inboxRuns).where(eq(inboxRuns.id, chain.inboxRunId));
    expect(ended).toMatchObject({ endReason: "finished" });
  });
});

describe("the Reset", () => {
  let testDatabase: TestDatabase;
  let db: Database;
  let admin: { id: number; username: string };
  const at = new Date("2026-11-02T12:00:00Z");

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    db = testDatabase.db;
    await ingestSnapshot(db);
    const [row] = await db.insert(users).values({ username: "admin", passwordHash: "x", role: "admin" }).returning();
    if (!row) throw new Error("no admin");
    admin = row;
  });

  afterEach(async () => {
    await testDatabase.close();
  });

  it("returns the ERP, the inbox and the audit log to 07:00, keeps who may sign in, and starts the log with the reset", async () => {
    await db.insert(sessions).values({ tokenHash: "hash", userId: admin.id, expiresAt: new Date(at.getTime() + 3_600_000) });
    const plan = await startInboxRun(db, { userId: admin.id, at });
    await runInboxRunStep(db, new ScriptedModel(e001Script()), { inboxRunId: plan.inboxRunId, emailId: "E001", userId: admin.id, modelId: MODEL_ID });
    await finishInboxRun(db, { inboxRunId: plan.inboxRunId, userId: admin.id, at });
    expect(await db.$count(proposals)).toBe(1);

    await resetInbox(db, { userId: admin.id, username: admin.username, at });

    expect(await db.$count(proposals)).toBe(0);
    expect(await db.$count(agentRuns)).toBe(0);
    expect(await db.$count(inboxRuns)).toBe(0);
    const [stock] = await db.select().from(inventory).where(eq(inventory.sku, "HPS-1408"));
    expect(stock?.available).toBe(30);
    expect(await findInboxEmail(db, "E001")).toMatchObject({ status: "not_run" });
    expect(await db.$count(users)).toBe(1);
    expect(await db.$count(sessions)).toBe(1);
    const log = await db.select().from(auditEvents).orderBy(asc(auditEvents.id));
    expect(log).toEqual([
      expect.objectContaining({ id: 1, actor: "person", userId: admin.id, action: "snapshot.reset", detail: { by: "admin" } }),
    ]);
  });

  it("is refused while an Inbox run holds the lock, and changes nothing", async () => {
    await startInboxRun(db, { userId: admin.id, at });

    await expect(resetInbox(db, { userId: admin.id, username: admin.username, at })).rejects.toThrow(new ResetRefused(RUN_IN_PROGRESS));
    expect(await db.$count(inboxRuns)).toBe(1);
    expect(await db.$count(rateLimitEvents)).toBe(0);
  });

  it("is refused while an Agent run is reading an email", async () => {
    await db.insert(agentRuns).values({ runId: "reading", emailId: "E001", modelId: MODEL_ID, startedAt: at });

    await expect(resetInbox(db, { userId: admin.id, username: admin.username, at })).rejects.toBeInstanceOf(ResetRefused);
  });

  it(`allows ${RATE_LIMITS.reset} resets per person per hour, and a reset never refills its own count`, async () => {
    for (let reset = 0; reset < RATE_LIMITS.reset; reset += 1) {
      await resetInbox(db, { userId: admin.id, username: admin.username, at: new Date(at.getTime() + reset * 60_000) });
    }

    await expect(
      resetInbox(db, { userId: admin.id, username: admin.username, at: new Date(at.getTime() + 10 * 60_000) }),
    ).rejects.toBeInstanceOf(RateLimited);
    expect(await db.$count(rateLimitEvents)).toBe(RATE_LIMITS.reset);
  });
});
