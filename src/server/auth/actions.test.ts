import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db/database";
import { sessions, users } from "@/db/schema";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import { signInAction, signOutAction } from "./actions";
import { SESSION_COOKIE } from "./gate";
import { hashPassword } from "./password";
import { SIGN_IN_FAILED_MESSAGE, findSessionUser } from "./sessions";

interface StoredCookie {
  value: string;
  options?: Record<string, unknown>;
}

const cookieJar = new Map<string, StoredCookie>();
let database: Database;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const cookie = cookieJar.get(name);
      return cookie && { name, value: cookie.value };
    },
    set: (name: string, value: string, options?: Record<string, unknown>) => cookieJar.set(name, { value, options }),
    delete: (name: string) => cookieJar.delete(name),
  }),
}));
vi.mock("@/db/client", () => ({ getDatabase: () => database }));

const PASSWORD = "a long enough password";
const emptyState = { message: null, username: "" };

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

// redirect() throws; its digest carries the destination.
async function redirectedTo(action: Promise<unknown>): Promise<string> {
  const error: unknown = await action.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof Error) || !("digest" in error) || typeof error.digest !== "string") {
    throw new Error("expected a redirect");
  }
  return error.digest.split(";")[2] ?? "";
}

describe("signInAction", () => {
  let testDatabase: TestDatabase;

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    database = testDatabase.db;
    await database.insert(users).values({
      username: "ops.reviewer",
      passwordHash: await hashPassword(PASSWORD),
      role: "reviewer",
    });
  });

  afterEach(async () => {
    cookieJar.clear();
    await testDatabase.close();
  });

  it("sets an HttpOnly, Secure, SameSite=Lax session cookie and goes where the person was heading", async () => {
    const destination = await redirectedTo(
      signInAction(emptyState, form({ username: "ops.reviewer", password: PASSWORD, next: "/emails/E005" })),
    );

    expect(destination).toBe("/emails/E005");
    const cookie = cookieJar.get(SESSION_COOKIE);
    expect(cookie?.options).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    expect(await findSessionUser(database, cookie?.value ?? "", new Date())).toMatchObject({
      username: "ops.reviewer",
    });
  });

  it("never sends a person to another site after signing in", async () => {
    const destination = await redirectedTo(
      signInAction(emptyState, form({ username: "ops.reviewer", password: PASSWORD, next: "//evil.example" })),
    );

    expect(destination).toBe("/");
  });

  it("replaces the session the browser already held", async () => {
    await redirectedTo(signInAction(emptyState, form({ username: "ops.reviewer", password: PASSWORD })));
    const firstToken = cookieJar.get(SESSION_COOKIE)?.value ?? "";

    await redirectedTo(signInAction(emptyState, form({ username: "ops.reviewer", password: PASSWORD })));

    expect(cookieJar.get(SESSION_COOKIE)?.value).not.toBe(firstToken);
    expect(await database.$count(sessions)).toBe(1);
  });

  it("answers a wrong password with the generic message, keeps the username, and sets no cookie", async () => {
    const state = await signInAction(emptyState, form({ username: "ops.reviewer", password: "wrong" }));

    expect(state).toEqual({ message: SIGN_IN_FAILED_MESSAGE, username: "ops.reviewer" });
    expect(cookieJar.has(SESSION_COOKIE)).toBe(false);
  });

  it("asks for both fields when one is empty", async () => {
    const state = await signInAction(emptyState, form({ username: "ops.reviewer", password: "" }));

    expect(state.message).toMatch(/username and password/);
  });
});

describe("signOutAction", () => {
  let testDatabase: TestDatabase;

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    database = testDatabase.db;
    await database.insert(users).values({
      username: "ops.reviewer",
      passwordHash: await hashPassword(PASSWORD),
      role: "reviewer",
    });
  });

  afterEach(async () => {
    cookieJar.clear();
    await testDatabase.close();
  });

  it("deletes the session on the server and the cookie, then shows the sign-in page", async () => {
    await redirectedTo(signInAction(emptyState, form({ username: "ops.reviewer", password: PASSWORD })));
    const token = cookieJar.get(SESSION_COOKIE)?.value ?? "";

    const destination = await redirectedTo(signOutAction());

    expect(destination).toBe("/sign-in");
    expect(cookieJar.has(SESSION_COOKIE)).toBe(false);
    expect(await findSessionUser(database, token, new Date())).toBeNull();
    expect(await database.$count(sessions)).toBe(0);
  });
});
