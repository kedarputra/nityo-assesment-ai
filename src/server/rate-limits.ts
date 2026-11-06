import { and, eq, gt, sql } from "drizzle-orm";
import type { Database } from "@/db/database";
import { rateLimitEvents, type RateLimitedAction } from "@/db/schema";

// Security 7: how often one person may take each action in an hour, counted in Postgres so every
// function instance sees the same count.
export const RATE_LIMITS: Record<RateLimitedAction, number> = { "agent-run": 30, reset: 3 };
const WINDOW_MS = 60 * 60 * 1000;

// A person's counts are serialised, so two requests at once cannot both take the last one.
const RATE_LIMIT_LOCK_SPACE = 0x48500604;

const LIMIT_REACHED: Record<RateLimitedAction, string> = {
  "agent-run": `You’ve run the agent ${RATE_LIMITS["agent-run"]} times in the last hour, which is the limit. Try again in a little while.`,
  reset: `You’ve reset ${RATE_LIMITS.reset} times in the last hour, which is the limit. Try again in a little while.`,
};

export class RateLimited extends Error {
  override name = "RateLimited";
}

// Counts one use of the action, or refuses it when the person has used up the hour. Call it in
// the transaction that takes the action, so a refused or failed action is never counted.
export async function takeRateLimit(
  tx: Database,
  use: { userId: number; action: RateLimitedAction; at: Date },
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${RATE_LIMIT_LOCK_SPACE}, ${use.userId})`);
  const since = new Date(use.at.getTime() - WINDOW_MS);
  const used = await tx.$count(
    rateLimitEvents,
    and(eq(rateLimitEvents.userId, use.userId), eq(rateLimitEvents.action, use.action), gt(rateLimitEvents.at, since)),
  );
  if (used >= RATE_LIMITS[use.action]) throw new RateLimited(LIMIT_REACHED[use.action]);
  await tx.insert(rateLimitEvents).values(use);
}
