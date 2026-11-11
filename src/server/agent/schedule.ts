import { createHash, timingSafeEqual } from "node:crypto";
import { eq, isNull } from "drizzle-orm";
import { recordAudit } from "@/agent/audit";
import { isReading } from "@/agent/run-agent";
import type { Database } from "@/db/database";
import { agentRuns, agentSchedule, users } from "@/db/schema";
import { isAgentConfigured } from "@/model/agent-switch";
import { InboxRunRefused, isUnprocessed, startBackgroundInboxRun, type InboxRunChain } from "@/server/inbox/inbox-run";
import { listInboxEmails } from "@/server/inbox/inbox";

// The agent's schedule (ADR 0005). An admin switches on an automatic run every 5 to 60 minutes.
// A GitHub Actions workflow calls /api/agent/tick every 5 minutes with CRON_SECRET; each tick
// starts a background Run all (ADR 0004) in the admin's name when the schedule is on, its interval
// has passed, nothing is running and an email is waiting. One row, id 1; kept by a Reset.

type Env = Record<string, string | undefined>;

export const SCHEDULE_INTERVALS = [5, 10, 15, 30, 60] as const;
export type ScheduleInterval = (typeof SCHEDULE_INTERVALS)[number];
const DEFAULT_INTERVAL = 15;
const SCHEDULE_ID = 1;
// GitHub's cron is not punctual: a tick that comes a little early still counts, so a 5-minute
// schedule is not stretched to 10 by a tick that lands seconds before the interval is up.
export const TICK_SLACK_MS = 60_000;

export class ScheduleRefused extends Error {
  override name = "ScheduleRefused";
}

export interface ScheduleView {
  enabled: boolean;
  intervalMinutes: number;
  lastStartedAt: Date | null;
  // When the schedule next starts a run, give or take a tick; null while it is off.
  nextRunAt: Date | null;
  // Whether this deploy has CRON_SECRET, without which no tick is accepted.
  configured: boolean;
}

export type TickResult = "started" | "disabled" | "not-due" | "busy" | "nothing-to-read" | "agent-off";

export function isCronConfigured(env: Env = process.env): boolean {
  return Boolean(env.CRON_SECRET?.trim());
}

// Whether an Authorization header carries `Bearer <secret>`. Compared as SHA-256 digests in
// constant time, so neither the secret's content nor its length leaks through timing.
export function isCronBearer(header: string | null, secret: string): boolean {
  const match = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? "");
  if (!match?.[1] || secret.length === 0) return false;
  const given = createHash("sha256").update(match[1]).digest();
  const expected = createHash("sha256").update(secret).digest();
  return timingSafeEqual(given, expected);
}

export async function getSchedule(db: Database, env: Env = process.env): Promise<ScheduleView> {
  const [row] = await db.select().from(agentSchedule).where(eq(agentSchedule.id, SCHEDULE_ID));
  const enabled = row?.enabled ?? false;
  const intervalMinutes = row?.intervalMinutes ?? DEFAULT_INTERVAL;
  const lastStartedAt = row?.lastStartedAt ?? null;
  return {
    enabled,
    intervalMinutes,
    lastStartedAt,
    // Never started: due at the next tick after it was switched on.
    nextRunAt: !enabled ? null : lastStartedAt ? new Date(lastStartedAt.getTime() + intervalMinutes * 60_000) : (row?.updatedAt ?? null),
    configured: isCronConfigured(env),
  };
}

export async function setSchedule(
  db: Database,
  change: { enabled: boolean; intervalMinutes: number; userId: number; at: Date },
): Promise<void> {
  if (!(SCHEDULE_INTERVALS as readonly number[]).includes(change.intervalMinutes)) {
    throw new ScheduleRefused(`Choose an interval of ${SCHEDULE_INTERVALS.join(", ")} minutes.`);
  }
  const values = { enabled: change.enabled, intervalMinutes: change.intervalMinutes, updatedBy: change.userId, updatedAt: change.at };
  await db.transaction(async (tx) => {
    await tx
      .insert(agentSchedule)
      .values({ id: SCHEDULE_ID, ...values })
      .onConflictDoUpdate({ target: agentSchedule.id, set: values });
    await recordAudit(tx, {
      at: change.at,
      actor: "person",
      userId: change.userId,
      action: "schedule.changed",
      emailId: null,
      runId: null,
      detail: { enabled: change.enabled, intervalMinutes: change.intervalMinutes },
    });
  });
}

export interface Tick {
  at: Date;
  // The app's own address, where the background steps ask for the next email.
  origin: string;
  // Sets the chain going once the run is recorded; the route hands it to `after`.
  start: (chain: InboxRunChain) => void | Promise<void>;
  env?: Env;
}

// One tick of the schedule. It records that it came, then starts a run if one is due.
export async function scheduleTick(db: Database, tick: Tick): Promise<TickResult> {
  const [row] = await db
    .update(agentSchedule)
    .set({ lastTickAt: tick.at })
    .where(eq(agentSchedule.id, SCHEDULE_ID))
    .returning();
  if (!row || !row.enabled || row.updatedBy === null) return "disabled";
  if (!isAgentConfigured(tick.env)) return "agent-off";
  if (row.lastStartedAt && tick.at.getTime() - row.lastStartedAt.getTime() < row.intervalMinutes * 60_000 - TICK_SLACK_MS) {
    return "not-due";
  }
  // The run carries the name of the admin who set the schedule; one who is no longer an admin
  // starts nothing.
  const [admin] = await db.select({ role: users.role }).from(users).where(eq(users.id, row.updatedBy));
  if (admin?.role !== "admin") return "disabled";

  // A person's own "Run the agent" counts as running too; a Run all already going is refused below.
  const unfinished = await db
    .select({ startedAt: agentRuns.startedAt, endedAt: agentRuns.endedAt })
    .from(agentRuns)
    .where(isNull(agentRuns.endedAt));
  if (unfinished.some((run) => isReading(run, tick.at))) return "busy";

  const inbox = await listInboxEmails(db);
  if (!inbox.some((email) => isUnprocessed(email.status))) return "nothing-to-read";

  let chain: InboxRunChain;
  try {
    chain = await startBackgroundInboxRun(db, { userId: row.updatedBy, at: tick.at, origin: tick.origin, trigger: "schedule" });
  } catch (error) {
    if (error instanceof InboxRunRefused) return "busy";
    throw error;
  }
  await db.update(agentSchedule).set({ lastStartedAt: tick.at }).where(eq(agentSchedule.id, SCHEDULE_ID));
  await tick.start(chain);
  return "started";
}
