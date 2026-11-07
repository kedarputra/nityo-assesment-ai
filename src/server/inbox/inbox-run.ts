import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { recordAudit } from "@/agent/audit";
import { isReading, runAgent, type AgentRunSummary } from "@/agent/run-agent";
import { SPEND_LIMIT_ERROR_CLASS } from "@/agent/run-errors";
import type { Database } from "@/db/database";
import { agentRuns, inboxRuns, type InboxRunEndReason } from "@/db/schema";
import type { Model } from "@/model/model";
import { takeRateLimit } from "@/server/rate-limits";
import { listInboxEmails, type InboxStatus } from "./inbox";

// An Inbox run (ADR 0003): the browser asks for one email at a time, in received_at order, and
// this module holds the lock that allows one Inbox run at a time. Security 2: an admin's.

// Between two emails the browser is a round trip away; inside this a quiet Inbox run still holds
// the lock. Past it, with no email being read, the tab is taken to be gone.
export const STEP_GRACE_MS = 15_000;

// Only one Inbox run starts or stops at a time.
const INBOX_RUN_LOCK = 0x48500605;

export class InboxRunRefused extends Error {
  override name = "InboxRunRefused";
}

export const RUN_ALL_ALREADY_GOING = "Run all is already going. Let it finish, or stop it first.";
export const INBOX_RUN_ENDED = "This Run all has stopped. Press Run all to carry on from where it got to.";
// DESIGN.md, "Voice and words": the calm words for a spend limit.
export const SPEND_LIMIT_MESSAGE = "The model’s limit is used up for now, so runs are paused. A free key’s daily quota comes back on its own; a paid key needs its spend limit raised.";

// An email Run all reads: one the agent has not run on, or whose latest run did not finish.
export function isUnprocessed(status: InboxStatus): boolean {
  return status === "not_run" || status === "failed";
}

export interface InboxRunPlan {
  inboxRunId: number;
  // The emails to read, in order, each with its place in the day's inbox ("Reading 12 of 40…").
  emails: { emailId: string; position: number }[];
  total: number;
}

type InboxRunRow = typeof inboxRuns.$inferSelect;

async function activeInboxRun(tx: Database): Promise<InboxRunRow | undefined> {
  const [active] = await tx
    .select()
    .from(inboxRuns)
    .where(isNull(inboxRuns.endedAt))
    .orderBy(desc(inboxRuns.startedAt))
    .limit(1);
  return active;
}

// Whether an Inbox run is working now: an email of it is being read, or the browser asked for one
// a moment ago.
async function isBusy(tx: Database, inboxRun: InboxRunRow, at: Date): Promise<boolean> {
  if (at.getTime() - inboxRun.lastStepAt.getTime() < STEP_GRACE_MS) return true;
  const unfinished = await tx
    .select({ startedAt: agentRuns.startedAt, endedAt: agentRuns.endedAt })
    .from(agentRuns)
    .where(and(eq(agentRuns.inboxRunId, inboxRun.id), isNull(agentRuns.endedAt)));
  return unfinished.some((run) => isReading(run, at));
}

// Whether any run holds the lock a Reset needs: an Inbox run that has not ended, or an Agent run
// still reading an email.
export async function isAnyRunGoing(tx: Database, at: Date): Promise<boolean> {
  if (await activeInboxRun(tx)) return true;
  const unfinished = await tx
    .select({ startedAt: agentRuns.startedAt, endedAt: agentRuns.endedAt })
    .from(agentRuns)
    .where(isNull(agentRuns.endedAt));
  return unfinished.some((run) => isReading(run, at));
}

async function endInboxRun(
  tx: Database,
  inboxRun: InboxRunRow,
  end: { reason: InboxRunEndReason; at: Date; userId: number | null },
): Promise<void> {
  await tx.update(inboxRuns).set({ endedAt: end.at, endReason: end.reason }).where(eq(inboxRuns.id, inboxRun.id));
  await recordAudit(tx, {
    at: end.at,
    actor: end.userId === null ? "agent" : "person",
    userId: end.userId,
    action: "inbox_run.ended",
    emailId: null,
    runId: null,
    detail: { inboxRunId: inboxRun.id, reason: end.reason },
  });
}

// Starts an Inbox run over every unprocessed email, so pressing Run all again after a closed tab
// carries on from the first one left. A second Inbox run is refused while one is working; one whose
// tab has gone quiet is ended as abandoned and replaced.
export async function startInboxRun(db: Database, start: { userId: number; at: Date }): Promise<InboxRunPlan> {
  const inboxRunId = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${INBOX_RUN_LOCK})`);
    const active = await activeInboxRun(tx);
    if (active) {
      if (await isBusy(tx, active, start.at)) throw new InboxRunRefused(RUN_ALL_ALREADY_GOING);
      await endInboxRun(tx, active, { reason: "abandoned", at: start.at, userId: start.userId });
    }
    const [created] = await tx
      .insert(inboxRuns)
      .values({ startedBy: start.userId, startedAt: start.at, lastStepAt: start.at })
      .returning({ id: inboxRuns.id });
    if (!created) throw new Error("The Inbox run was not stored.");
    await recordAudit(tx, {
      at: start.at,
      actor: "person",
      userId: start.userId,
      action: "inbox_run.started",
      emailId: null,
      runId: null,
      detail: { inboxRunId: created.id },
    });
    return created.id;
  });

  const inbox = await listInboxEmails(db);
  return {
    inboxRunId,
    emails: inbox
      .map((email, index) => ({ emailId: email.emailId, position: index + 1, status: email.status }))
      .filter((email) => isUnprocessed(email.status))
      .map(({ emailId, position }) => ({ emailId, position })),
    total: inbox.length,
  };
}

export interface InboxRunStep {
  inboxRunId: number;
  emailId: string;
  userId: number;
  modelId: string;
  deadline?: Date;
  now?: () => Date;
}

// Runs the agent on one email of an Inbox run. The run must still be going: the check is in the
// transaction that starts the Agent run, so a Stop is never overtaken by the next email. A spend
// limit ends the Inbox run there and then.
export async function runInboxRunStep(db: Database, model: Model, step: InboxRunStep): Promise<AgentRunSummary> {
  const now = step.now ?? (() => new Date());
  const summary = await runAgent(db, model, {
    emailId: step.emailId,
    modelId: step.modelId,
    startedBy: step.userId,
    inboxRunId: step.inboxRunId,
    deadline: step.deadline,
    now,
    admit: async (tx) => {
      const [inboxRun] = await tx.select().from(inboxRuns).where(eq(inboxRuns.id, step.inboxRunId)).for("update");
      if (!inboxRun || inboxRun.endedAt !== null) throw new InboxRunRefused(INBOX_RUN_ENDED);
      await tx.update(inboxRuns).set({ lastStepAt: now() }).where(eq(inboxRuns.id, inboxRun.id));
      await takeRateLimit(tx, { userId: step.userId, action: "agent-run", at: now() });
    },
  });
  if (summary.errorClass === SPEND_LIMIT_ERROR_CLASS) {
    await db.transaction(async (tx) => {
      const [inboxRun] = await tx.select().from(inboxRuns).where(eq(inboxRuns.id, step.inboxRunId)).for("update");
      if (inboxRun && inboxRun.endedAt === null) await endInboxRun(tx, inboxRun, { reason: "spend-limit", at: now(), userId: null });
    });
  }
  return summary;
}

// Ends the Inbox run that is going, if any. The email being read finishes; no other starts.
export async function stopInboxRun(db: Database, stop: { userId: number; at: Date }): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${INBOX_RUN_LOCK})`);
    const active = await activeInboxRun(tx);
    if (!active) return false;
    await endInboxRun(tx, active, { reason: "stopped", at: stop.at, userId: stop.userId });
    return true;
  });
}

// The browser has asked for every email of the plan.
export async function finishInboxRun(db: Database, finish: { inboxRunId: number; userId: number; at: Date }): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${INBOX_RUN_LOCK})`);
    const [inboxRun] = await tx.select().from(inboxRuns).where(eq(inboxRuns.id, finish.inboxRunId));
    if (inboxRun && inboxRun.endedAt === null) {
      await endInboxRun(tx, inboxRun, { reason: "finished", at: finish.at, userId: finish.userId });
    }
  });
}
