import { desc, eq } from "drizzle-orm";
import type { Database } from "@/db/database";
import { agentRuns, emails, inboxRuns } from "@/db/schema";

export interface RecentRun {
  runId: string;
  emailId: string;
  subject: string;
  startedAt: Date;
  endedAt: Date | null;
  outcome: string | null;
  errorClass: string | null;
  modelCalls: number;
  trigger: "person" | "schedule" | "single";
}

// The agent's latest runs, newest first, for the Activity page.
export async function listRecentRuns(db: Database, limit = 15): Promise<RecentRun[]> {
  const rows = await db
    .select({
      runId: agentRuns.runId,
      emailId: agentRuns.emailId,
      subject: emails.subject,
      startedAt: agentRuns.startedAt,
      endedAt: agentRuns.endedAt,
      outcome: agentRuns.outcome,
      errorClass: agentRuns.errorClass,
      modelCalls: agentRuns.modelCalls,
      trigger: inboxRuns.trigger,
    })
    .from(agentRuns)
    .innerJoin(emails, eq(emails.emailId, agentRuns.emailId))
    .leftJoin(inboxRuns, eq(inboxRuns.id, agentRuns.inboxRunId))
    .orderBy(desc(agentRuns.startedAt))
    .limit(limit);
  return rows.map((row) => ({ ...row, trigger: row.trigger ?? "single" }));
}
