import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db/database";
import { sessions, users } from "@/db/schema";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import { hashPassword } from "./password";
import {
  SESSION_LIFETIME_MS,
  SIGN_IN_FAILED_MESSAGE,
  findSessionUser,
  signIn,
  signOut,
} from "./sessions";

const PASSWORD = "correct horse battery staple";
const MINUTE = 60_000;
const start = new Date("2026-11-02T07:00:00Z");

function minutesAfterStart(minutes: number): Date {
  return new Date(start.getTime() + minutes * MINUTE);
}

describe("sign-in and sessions", () => {
  let testDatabase: TestDatabase;
  let db: Database;

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    db = testDatabase.db;
    await db.insert(users).values({
      username: "ops.reviewer",
      passwordHash: await hashPassword(PASSWORD),
      role: "reviewer",
    });
  });

  afterEach(async () => {
    await testDatabase.close();
  });

  it("signs in with the right password and opens a session that names the user and role", async () => {
    const result = await signIn(db, { username: "ops.reviewer", password: PASSWORD }, start);

    if (!result.ok) throw new Error(`expected a session, got: ${result.message}`);
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.expiresAt).toEqual(new Date(start.getTime() + SESSION_LIFETIME_MS));
    expect(await findSessionUser(db, result.token, start)).toMatchObject({
      username: "ops.reviewer",
      role: "reviewer",
    });
  });

  it("stores only a hash of the session token", async () => {
    const result = await signIn(db, { username: "ops.reviewer", password: PASSWORD }, start);
    if (!result.ok) throw new Error(result.message);

    const stored = await db.select().from(sessions);

    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).not.toBe(result.token);
  });

  it("matches the username however it is cased or padded", async () => {
    const result = await signIn(db, { username: "  Ops.Reviewer ", password: PASSWORD }, start);

    expect(result.ok).toBe(true);
  });

  it("refuses a wrong password with the generic message and opens no session", async () => {
    const result = await signIn(db, { username: "ops.reviewer", password: "wrong" }, start);

    expect(result).toEqual({ ok: false, message: SIGN_IN_FAILED_MESSAGE });
    expect(await db.$count(sessions)).toBe(0);
  });

  it("gives an unknown user the same message as a wrong password", async () => {
    const unknown = await signIn(db, { username: "nobody", password: PASSWORD }, start);
    const wrongPassword = await signIn(db, { username: "ops.reviewer", password: "x" }, start);

    expect(unknown).toEqual(wrongPassword);
  });

  it("locks the account for 15 minutes after five failures in 15 minutes", async () => {
    for (let minute = 0; minute < 5; minute++) {
      await signIn(db, { username: "ops.reviewer", password: "wrong" }, minutesAfterStart(minute));
    }

    const whileLocked = await signIn(
      db,
      { username: "ops.reviewer", password: PASSWORD },
      minutesAfterStart(18),
    );
    expect(whileLocked).toEqual({ ok: false, message: SIGN_IN_FAILED_MESSAGE });
    expect(await db.$count(sessions)).toBe(0);

    const afterLock = await signIn(
      db,
      { username: "ops.reviewer", password: PASSWORD },
      minutesAfterStart(19),
    );
    expect(afterLock.ok).toBe(true);
  });

  it("does not lock when the five failures are spread over more than 15 minutes", async () => {
    for (const minute of [0, 4, 8, 12, 16]) {
      await signIn(db, { username: "ops.reviewer", password: "wrong" }, minutesAfterStart(minute));
    }

    const result = await signIn(
      db,
      { username: "ops.reviewer", password: PASSWORD },
      minutesAfterStart(17),
    );
    expect(result.ok).toBe(true);
  });

  it("forgets earlier failures after a successful sign-in", async () => {
    for (let minute = 0; minute < 4; minute++) {
      await signIn(db, { username: "ops.reviewer", password: "wrong" }, minutesAfterStart(minute));
    }
    await signIn(db, { username: "ops.reviewer", password: PASSWORD }, minutesAfterStart(5));
    await signIn(db, { username: "ops.reviewer", password: "wrong" }, minutesAfterStart(6));

    const result = await signIn(
      db,
      { username: "ops.reviewer", password: PASSWORD },
      minutesAfterStart(7),
    );
    expect(result.ok).toBe(true);
  });

  it("ends a session 12 hours after sign-in", async () => {
    const result = await signIn(db, { username: "ops.reviewer", password: PASSWORD }, start);
    if (!result.ok) throw new Error(result.message);

    const justBefore = new Date(result.expiresAt.getTime() - 1);
    expect(await findSessionUser(db, result.token, justBefore)).not.toBeNull();
    expect(await findSessionUser(db, result.token, result.expiresAt)).toBeNull();
    expect(await db.$count(sessions)).toBe(0);
  });

  it("issues a new session id at sign-in and deletes the one the browser held", async () => {
    const first = await signIn(db, { username: "ops.reviewer", password: PASSWORD }, start);
    if (!first.ok) throw new Error(first.message);

    const second = await signIn(
      db,
      { username: "ops.reviewer", password: PASSWORD, previousToken: first.token },
      start,
    );
    if (!second.ok) throw new Error(second.message);

    expect(second.token).not.toBe(first.token);
    expect(await findSessionUser(db, first.token, start)).toBeNull();
    expect(await findSessionUser(db, second.token, start)).not.toBeNull();
  });

  it("signs out by deleting the session on the server", async () => {
    const result = await signIn(db, { username: "ops.reviewer", password: PASSWORD }, start);
    if (!result.ok) throw new Error(result.message);

    await signOut(db, result.token);

    expect(await findSessionUser(db, result.token, start)).toBeNull();
    expect(await db.$count(sessions)).toBe(0);
  });

  it("finds no user for a token it never issued", async () => {
    expect(await findSessionUser(db, "not-a-real-token", start)).toBeNull();
  });

  it("ends a user's sessions when the user is deleted", async () => {
    const result = await signIn(db, { username: "ops.reviewer", password: PASSWORD }, start);
    if (!result.ok) throw new Error(result.message);

    await db.delete(users).where(eq(users.username, "ops.reviewer"));

    expect(await findSessionUser(db, result.token, start)).toBeNull();
  });
});
