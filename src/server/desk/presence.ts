import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { isCutOff, SPEND_LIMIT_ERROR_CLASS } from "@/agent/run-errors";
import type { Database } from "@/db/database";
import { agentRuns, emails, inboxRuns } from "@/db/schema";
import { isAgentConfigured, modelChoiceFromEnv } from "@/model/agent-switch";
import { getSchedule } from "@/server/agent/schedule";

// The agent's presence, as Teams shows a person's (ADR 0005): a dot and a word, never a sentence.
//   active  reading at least one email now
//   idle    switched on, nothing being read
//   paused  the model's limit stopped a run in the last hour
//   off     no model key on this deploy
export type PresenceState = "active" | "idle" | "paused" | "off";

export interface ReadingNow {
  emailId: string;
  fromName: string;
  subject: string;
  startedAt: Date;
}

export interface AgentPresence {
  state: PresenceState;
  modelId: string | null;
  reading: ReadingNow[];
  // A Run all is going, and how it was started.
  runAll: { trigger: "person" | "schedule"; selected: number | null } | null;
  schedule: { enabled: boolean; intervalMinutes: number; nextRunAt: Date | null; configured: boolean };
}

const PAUSE_WINDOW_MS = 60 * 60 * 1000;

export async function agentPresence(db: Database, now: Date = new Date()): Promise<AgentPresence> {
  const choice = modelChoiceFromEnv();
  const [unfinished, activeRun, limited, schedule] = await Promise.all([
    db
      .select({ emailId: agentRuns.emailId, startedAt: agentRuns.startedAt, fromName: emails.fromName, subject: emails.subject })
      .from(agentRuns)
      .innerJoin(emails, eq(emails.emailId, agentRuns.emailId))
      .where(isNull(agentRuns.endedAt))
      .orderBy(desc(agentRuns.startedAt)),
    db.select().from(inboxRuns).where(isNull(inboxRuns.endedAt)).orderBy(desc(inboxRuns.startedAt)).limit(1),
    db
      .select({ runId: agentRuns.runId })
      .from(agentRuns)
      .where(and(eq(agentRuns.errorClass, SPEND_LIMIT_ERROR_CLASS), gt(agentRuns.startedAt, new Date(now.getTime() - PAUSE_WINDOW_MS))))
      .limit(1),
    getSchedule(db),
  ]);

  const reading = unfinished
    .filter((run) => !isCutOff({ startedAt: run.startedAt, endedAt: null }, now))
    .map((run) => ({ emailId: run.emailId, fromName: run.fromName, subject: run.subject, startedAt: run.startedAt }));
  const going = activeRun[0];

  let state: PresenceState = "idle";
  if (!isAgentConfigured()) state = "off";
  else if (reading.length > 0 || going) state = "active";
  else if (limited.length > 0) state = "paused";

  return {
    state,
    modelId: choice?.modelId ?? null,
    reading,
    runAll: going ? { trigger: going.trigger, selected: going.emailIds?.length ?? null } : null,
    schedule: {
      enabled: schedule.enabled,
      intervalMinutes: schedule.intervalMinutes,
      nextRunAt: schedule.nextRunAt,
      configured: schedule.configured,
    },
  };
}
