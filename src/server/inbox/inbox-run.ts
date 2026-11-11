import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { recordAudit } from "@/agent/audit";
import { isReading, runAgent, type AgentRunSummary } from "@/agent/run-agent";
import { SPEND_LIMIT_ERROR_CLASS } from "@/agent/run-errors";
import type { Database } from "@/db/database";
import { agentRuns, inboxRuns, type InboxRunEndReason } from "@/db/schema";
import type { Model } from "@/model/model";
import { listInboxEmails, type InboxStatus } from "./inbox";

// An Inbox run (ADR 0004, replacing ADR 0003): the server reads one email per function, in
// received_at order, and each function asks the app for the next. This module holds the lock that
// allows one Inbox run at a time. Security 2: an admin's.

// Between two emails the browser is a round trip away; inside this a quiet Inbox run still holds
// the lock. Past it, with no email being read, the tab is taken to be gone.
export const STEP_GRACE_MS = 15_000;

// Only one Inbox run starts or stops at a time.
const INBOX_RUN_LOCK = 0x48500605;

export class InboxRunRefused extends Error {
  override name = "InboxRunRefused";
}

export const RUN_ALL_ALREADY_GOING = "Run all is already going. Let it finish, or stop it first.";
// The same refusal while the agent works through emails a person selected (ADR 0005).
export const SELECTED_RUN_ALREADY_GOING = "The agent is already reading the selected emails. Let it finish, or stop it first.";
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

export type InboxRunTrigger = InboxRunRow["trigger"];

export interface InboxRunStart {
  userId: number;
  at: Date;
  // Only these emails, when a person selected them (ADR 0005); every email left when absent.
  emailIds?: string[];
  // A person (Run all, or selected emails) or the schedule, which starts it in an admin's name.
  trigger?: InboxRunTrigger;
  // Runs in the transaction that starts the Inbox run, after the lock: a refusal here (such as a
  // rate limit) starts nothing and counts nothing.
  admit?: (tx: Database) => Promise<void>;
}

// Starts an Inbox run over every unprocessed email (or every unprocessed one of those selected),
// so pressing Run all again after a closed tab carries on from the first one left. A second Inbox
// run is refused while one is working; one whose tab has gone quiet is ended as abandoned and
// replaced.
export async function startInboxRun(db: Database, start: InboxRunStart): Promise<InboxRunPlan> {
  const emailIds = start.emailIds === undefined ? null : [...new Set(start.emailIds)];
  const trigger = start.trigger ?? "person";
  const inboxRunId = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${INBOX_RUN_LOCK})`);
    const active = await activeInboxRun(tx);
    if (active) {
      if (await isBusy(tx, active, start.at)) {
        throw new InboxRunRefused(active.emailIds === null ? RUN_ALL_ALREADY_GOING : SELECTED_RUN_ALREADY_GOING);
      }
      await endInboxRun(tx, active, { reason: "abandoned", at: start.at, userId: start.userId });
    }
    await start.admit?.(tx);
    const [created] = await tx
      .insert(inboxRuns)
      .values({ startedBy: start.userId, startedAt: start.at, lastStepAt: start.at, emailIds, trigger })
      .returning({ id: inboxRuns.id });
    if (!created) throw new Error("The Inbox run was not stored.");
    await recordAudit(tx, {
      at: start.at,
      // The schedule starts a run in the admin's name, but no person pressed anything.
      actor: trigger === "schedule" ? "agent" : "person",
      userId: start.userId,
      action: "inbox_run.started",
      emailId: null,
      runId: null,
      detail: {
        inboxRunId: created.id,
        ...(emailIds === null ? {} : { emailIds }),
        ...(trigger === "schedule" ? { trigger } : {}),
      },
    });
    return created.id;
  });

  const inbox = await listInboxEmails(db);
  return {
    inboxRunId,
    emails: inbox
      .map((email, index) => ({ emailId: email.emailId, position: index + 1, status: email.status }))
      .filter((email) => isUnprocessed(email.status) && (emailIds === null || emailIds.includes(email.emailId)))
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
      // Run all is an admin's, and bounded by the day's inbox, so its emails don't count against
      // the per-person agent-run limit (security 7); 40 emails would otherwise stop it at 30.
      await tx.update(inboxRuns).set({ lastStepAt: now() }).where(eq(inboxRuns.id, inboxRun.id));
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

// ---- Run all in the background (ADR 0004) ----------------------------------------------------
//
// Starting a Run all stores a secret for it (as a hash) and the address the admin used. Each step
// reads one email inside its own function, then posts the secret to the step route at that
// address, which answers at once and reads the next email in a function of its own. A Stop ends
// the run, and the next step finds it ended. If a step's function is cut off, the chain stops;
// pressing Run all again carries on from the first email left.

export interface InboxRunChain {
  inboxRunId: number;
  token: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Whether `token` is this Inbox run's secret, compared in constant time.
export async function isInboxRunToken(db: Database, chain: InboxRunChain): Promise<boolean> {
  const [inboxRun] = await db
    .select({ hash: inboxRuns.stepTokenHash })
    .from(inboxRuns)
    .where(and(eq(inboxRuns.id, chain.inboxRunId), isNotNull(inboxRuns.stepTokenHash)));
  if (!inboxRun?.hash) return false;
  const expected = Buffer.from(inboxRun.hash, "hex");
  const given = Buffer.from(hashToken(chain.token), "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// Starts an Inbox run that the server drives, and gives back its secret for the first step.
export async function startBackgroundInboxRun(db: Database, start: InboxRunStart & { origin: string }): Promise<InboxRunChain> {
  const plan = await startInboxRun(db, start);
  const token = randomBytes(32).toString("hex");
  await db
    .update(inboxRuns)
    .set({ stepTokenHash: hashToken(token), origin: start.origin })
    .where(eq(inboxRuns.id, plan.inboxRunId));
  return { inboxRunId: plan.inboxRunId, token };
}

// The next email this Inbox run should read: the first, in received_at order, that is not done,
// that this run has not tried yet (so a failure is not retried in a loop) and, on a run over
// selected emails, that was selected.
export async function nextEmailOf(db: Database, inboxRunId: number): Promise<string | null> {
  const [inboxRun] = await db.select({ emailIds: inboxRuns.emailIds }).from(inboxRuns).where(eq(inboxRuns.id, inboxRunId));
  const selected = inboxRun?.emailIds ? new Set(inboxRun.emailIds) : null;
  const tried = await db.select({ emailId: agentRuns.emailId }).from(agentRuns).where(eq(agentRuns.inboxRunId, inboxRunId));
  const triedIds = new Set(tried.map((row) => row.emailId));
  const inbox = await listInboxEmails(db);
  const next = inbox.find(
    (email) => isUnprocessed(email.status) && !triedIds.has(email.emailId) && (selected === null || selected.has(email.emailId)),
  );
  return next?.emailId ?? null;
}

export interface ChainStepDeps {
  model: Model;
  modelId: string;
  deadline?: Date;
  // Asks the app for the next step; never awaited past the app's quick answer.
  triggerNext: (chain: InboxRunChain, origin: string) => Promise<void>;
  now?: () => Date;
}

export type ChainStepResult = "read" | "skipped" | "finished" | "ended";

// One step of a background Run all: reads the next email, then asks for the step after it.
export async function runChainStep(db: Database, chain: InboxRunChain, deps: ChainStepDeps): Promise<ChainStepResult> {
  const now = deps.now ?? (() => new Date());
  const [inboxRun] = await db.select().from(inboxRuns).where(eq(inboxRuns.id, chain.inboxRunId));
  if (!inboxRun || inboxRun.endedAt !== null || !inboxRun.origin) return "ended";

  const emailId = await nextEmailOf(db, chain.inboxRunId);
  if (emailId === null) {
    await finishInboxRun(db, { inboxRunId: chain.inboxRunId, userId: inboxRun.startedBy, at: now() });
    return "finished";
  }

  let result: ChainStepResult = "read";
  try {
    const summary = await runInboxRunStep(db, deps.model, {
      inboxRunId: chain.inboxRunId,
      emailId,
      userId: inboxRun.startedBy,
      modelId: deps.modelId,
      deadline: deps.deadline,
      now,
    });
    // A spend limit has ended the Inbox run; asking for more would only be refused.
    if (summary.errorClass === SPEND_LIMIT_ERROR_CLASS) return "ended";
  } catch (error) {
    if (error instanceof InboxRunRefused) return "ended";
    // Being read, or read, outside this run: move on to the next email.
    if (error instanceof Error && error.name === "AgentRunRefused") result = "skipped";
    else throw error;
  }
  await deps.triggerNext(chain, inboxRun.origin);
  return result;
}

// Whether a Run all is going now, for the desk's progress line and its refresh.
export async function isInboxRunActive(db: Database): Promise<boolean> {
  return (await activeInboxRun(db)) !== undefined;
}
