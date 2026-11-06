import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import type { Database } from "@/db/database";
import { type UserRole, sessions, signInThrottle, users } from "@/db/schema";
import { hashPassword, verifyPassword } from "./password";

const MINUTE_MS = 60_000;

export const SESSION_LIFETIME_MS = 12 * 60 * MINUTE_MS;
const FAILURE_WINDOW_MS = 15 * MINUTE_MS;
const LOCK_MS = 15 * MINUTE_MS;
const FAILURES_BEFORE_LOCK = 5;

// One message for a wrong password, an unknown user and a locked account (security 1), so the
// sign-in page reveals nothing about which accounts exist or are locked.
export const SIGN_IN_FAILED_MESSAGE =
  "That username and password don't match, or the account is paused for a few minutes. Check them and try again.";

export interface SessionUser {
  id: number;
  username: string;
  role: UserRole;
}

export type SignInResult =
  | { ok: true; user: SessionUser; token: string; expiresAt: Date }
  | { ok: false; message: string };

export interface SignInAttempt {
  username: string;
  password: string;
  // The session token the browser already held, if any; it is deleted so the id rotates.
  previousToken?: string;
}

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export async function signIn(db: Database, attempt: SignInAttempt, now: Date): Promise<SignInResult> {
  const username = normalizeUsername(attempt.username);

  if (await isLocked(db, username, now)) {
    return { ok: false, message: SIGN_IN_FAILED_MESSAGE };
  }

  const [user] = await db.select().from(users).where(eq(users.username, username));
  // An unknown user still costs one argon2 verification, so the response time does not
  // tell an attacker which usernames exist.
  const passwordMatches = await verifyPassword(user?.passwordHash ?? (await dummyHash()), attempt.password);

  if (!user || !passwordMatches) {
    await recordFailure(db, username, now);
    return { ok: false, message: SIGN_IN_FAILED_MESSAGE };
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);

  await db.transaction(async (tx) => {
    await tx.delete(signInThrottle).where(eq(signInThrottle.username, username));
    if (attempt.previousToken) {
      await tx.delete(sessions).where(eq(sessions.tokenHash, hashToken(attempt.previousToken)));
    }
    await tx.delete(sessions).where(lte(sessions.expiresAt, now));
    await tx.insert(sessions).values({ tokenHash: hashToken(token), userId: user.id, expiresAt });
  });

  return { ok: true, user: { id: user.id, username: user.username, role: user.role }, token, expiresAt };
}

// The user a session token belongs to, or null when the token is unknown or expired. An
// expired session is deleted when it is found.
export async function findSessionUser(db: Database, token: string, now: Date): Promise<SessionUser | null> {
  const tokenHash = hashToken(token);
  const [row] = await db
    .select({ id: users.id, username: users.username, role: users.role, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, tokenHash));

  if (!row) return null;
  if (row.expiresAt.getTime() <= now.getTime()) {
    await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    return null;
  }
  return { id: row.id, username: row.username, role: row.role };
}

export async function signOut(db: Database, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function isLocked(db: Database, username: string, now: Date): Promise<boolean> {
  const [lock] = await db
    .select({ username: signInThrottle.username })
    .from(signInThrottle)
    .where(and(eq(signInThrottle.username, username), gt(signInThrottle.lockedUntil, now)));
  return lock !== undefined;
}

// Counts the failure in one statement, so concurrent failures cannot overwrite each other's
// count and slip past the lock.
async function recordFailure(db: Database, username: string, now: Date): Promise<void> {
  const windowOpen = sql`${signInThrottle.windowStartedAt} > ${new Date(now.getTime() - FAILURE_WINDOW_MS).toISOString()}::timestamptz`;
  const [throttle] = await db
    .insert(signInThrottle)
    .values({ username, failureCount: 1, windowStartedAt: now })
    .onConflictDoUpdate({
      target: signInThrottle.username,
      set: {
        failureCount: sql`case when ${windowOpen} then ${signInThrottle.failureCount} + 1 else 1 end`,
        windowStartedAt: sql`case when ${windowOpen} then ${signInThrottle.windowStartedAt} else ${now.toISOString()}::timestamptz end`,
      },
    })
    .returning({ failureCount: signInThrottle.failureCount });

  if (throttle && throttle.failureCount >= FAILURES_BEFORE_LOCK) {
    await db
      .update(signInThrottle)
      .set({ failureCount: 0, windowStartedAt: now, lockedUntil: new Date(now.getTime() + LOCK_MS) })
      .where(eq(signInThrottle.username, username));
  }
}

let dummyHashPromise: Promise<string> | undefined;

function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomBytes(32).toString("base64url"));
  return dummyHashPromise;
}
