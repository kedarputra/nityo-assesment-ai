import { recordAudit } from "@/agent/audit";
import { takeSnapshotLock } from "@/agent/run-agent";
import type { Database } from "@/db/database";
import { agentSchedule, labels, rateLimitEvents, sessions, signInThrottle, users } from "@/db/schema";
import type { Snapshot } from "@/snapshot/data-pack";
import { resetToSnapshot } from "@/snapshot/snapshot";
import { takeRateLimit } from "@/server/rate-limits";
import { isAnyRunGoing } from "./inbox-run";

// The admin's "Reset to 07:00" (issue 05, answer 3): the ERP, the inbox and the audit log go back
// to the Snapshot through the same Reset as `npm run db:reset`, in one transaction. It runs on the
// owner's connection, the one role that may empty the append-only audit log (security 6).

// Who may sign in, and how often they have acted, are not part of the Snapshot: a Reset from the
// app keeps everyone signed in and never refills its own rate limit. The team's labels and the
// agent's schedule are the team's own settings, so they stay too (ADR 0005); which emails carry a
// label is the day's work, and goes back with the rest.
const KEPT_BY_THE_APP = [users, sessions, signInThrottle, rateLimitEvents, labels, agentSchedule];

export const RUN_IN_PROGRESS = "A run is in progress. Stop it first.";

export class ResetRefused extends Error {
  override name = "ResetRefused";
}

export async function resetInbox(
  ownerDb: Database,
  reset: { userId: number; username: string; at: Date; snapshot?: Snapshot },
): Promise<void> {
  await resetToSnapshot(ownerDb, reset.snapshot, {
    keep: KEPT_BY_THE_APP,
    before: async (tx) => {
      // Taken alone, so it waits for any run that is starting and no run starts until it is done.
      await takeSnapshotLock(tx);
      if (await isAnyRunGoing(tx, reset.at)) throw new ResetRefused(RUN_IN_PROGRESS);
      await takeRateLimit(tx, { userId: reset.userId, action: "reset", at: reset.at });
    },
    // The new audit log's first event.
    after: (tx) =>
      recordAudit(tx, {
        at: reset.at,
        actor: "person",
        userId: reset.userId,
        action: "snapshot.reset",
        emailId: null,
        runId: null,
        detail: { by: reset.username },
      }),
  });
}
