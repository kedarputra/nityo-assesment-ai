import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db/database";
import { appSettings, users } from "@/db/schema";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import { ForbiddenError, hasRole, requireRole } from "./current-user";
import { SESSION_COOKIE } from "./gate";
import { hashPassword } from "./password";
import { signIn } from "./sessions";

const cookieJar = new Map<string, string>();
let database: Database;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));
vi.mock("@/db/client", () => ({ getDatabase: () => database }));

// Stands in for an admin-only server action such as starting an inbox run: the role check is
// the action's own first line, so calling it directly gets no further than calling it from a form.
async function startInboxRun(): Promise<void> {
  await requireRole("admin");
  await database.insert(appSettings).values({ key: "inbox_run", value: "started" });
}

async function approveProposal(): Promise<string> {
  const user = await requireRole("reviewer");
  return user.username;
}

describe("requireRole", () => {
  let testDatabase: TestDatabase;

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    database = testDatabase.db;
    const passwordHash = await hashPassword("a long enough password");
    await database.insert(users).values([
      { username: "ops.reviewer", passwordHash, role: "reviewer" },
      { username: "admin", passwordHash, role: "admin" },
    ]);
  });

  afterEach(async () => {
    cookieJar.clear();
    await testDatabase.close();
  });

  async function signInAs(username: string): Promise<void> {
    const result = await signIn(database, { username, password: "a long enough password" }, new Date());
    if (!result.ok) throw new Error(result.message);
    cookieJar.set(SESSION_COOKIE, result.token);
  }

  it("refuses a reviewer who calls an admin-only action directly, and changes nothing", async () => {
    await signInAs("ops.reviewer");

    await expect(startInboxRun()).rejects.toBeInstanceOf(ForbiddenError);
    expect(await database.$count(appSettings)).toBe(0);
  });

  it("lets an admin run an admin-only action", async () => {
    await signInAs("admin");

    await startInboxRun();

    expect(await database.$count(appSettings)).toBe(1);
  });

  it("returns the signed-in user, so the action can record who did it", async () => {
    await signInAs("ops.reviewer");

    expect(await approveProposal()).toBe("ops.reviewer");
  });

  it("sends a request with no session to the sign-in page", async () => {
    await expect(approveProposal()).rejects.toMatchObject({ digest: expect.stringContaining("/sign-in") });
  });

  it("does not trust a cookie whose session is unknown", async () => {
    cookieJar.set(SESSION_COOKIE, "forged-token");

    await expect(startInboxRun()).rejects.toMatchObject({ digest: expect.stringContaining("/sign-in") });
    expect(await database.$count(appSettings)).toBe(0);
  });
});

describe("hasRole", () => {
  it("gives an admin every reviewer permission, but not the reverse", () => {
    const admin = { id: 1, username: "admin", role: "admin" as const };
    const reviewer = { id: 2, username: "ops.reviewer", role: "reviewer" as const };

    expect(hasRole(admin, "reviewer")).toBe(true);
    expect(hasRole(admin, "admin")).toBe(true);
    expect(hasRole(reviewer, "reviewer")).toBe(true);
    expect(hasRole(reviewer, "admin")).toBe(false);
  });
});
