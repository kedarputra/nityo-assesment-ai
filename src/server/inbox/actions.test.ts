import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db/database";
import { users } from "@/db/schema";
import { SESSION_COOKIE } from "@/server/auth/gate";
import { signIn } from "@/server/auth/sessions";
import { hashPassword } from "@/server/auth/password";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import { dismissTipAction } from "./actions";
import { isTipDismissed } from "./inbox";

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
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/db/client", () => ({ getDatabase: () => database }));

describe("dismissTipAction", () => {
  let testDatabase: TestDatabase;

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    database = testDatabase.db;
  });

  afterEach(async () => {
    cookieJar.clear();
    await testDatabase.close();
  });

  it("dismisses the tip for the signed-in person, on the server", async () => {
    const password = "a long enough password";
    await database.insert(users).values({ username: "ops.reviewer", passwordHash: await hashPassword(password), role: "reviewer" });
    const session = await signIn(database, { username: "ops.reviewer", password }, new Date());
    if (!session.ok) throw new Error("sign-in failed");
    cookieJar.set(SESSION_COOKIE, session.token);

    await dismissTipAction();

    expect(await isTipDismissed(database, session.user.id)).toBe(true);
  });

  it("does nothing for someone who is not signed in", async () => {
    await expect(dismissTipAction()).rejects.toThrow();
  });
});
