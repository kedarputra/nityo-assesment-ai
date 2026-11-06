import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db/database";
import { users } from "@/db/schema";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import { verifyPassword } from "./password";
import { seedUsers } from "./seed-users";

const env = {
  SEED_REVIEWER_PASSWORD: "reviewer-password-1",
  SEED_ADMIN_PASSWORD: "admin-password-12",
  SEED_ASSESSOR_USERNAME: "Assessor",
  SEED_ASSESSOR_PASSWORD: "assessor-password-1",
};

describe("seedUsers", () => {
  let testDatabase: TestDatabase;
  let db: Database;

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    db = testDatabase.db;
  });

  afterEach(async () => {
    await testDatabase.close();
  });

  it("creates ops.reviewer, admin and the assessor with their roles", async () => {
    await seedUsers(db, env);

    const seeded = await db.select({ username: users.username, role: users.role }).from(users);
    expect(seeded).toEqual(
      expect.arrayContaining([
        { username: "ops.reviewer", role: "reviewer" },
        { username: "admin", role: "admin" },
        { username: "assessor", role: "reviewer" },
      ]),
    );
    expect(seeded).toHaveLength(3);
  });

  it("stores argon2id hashes that verify, never the plain password", async () => {
    await seedUsers(db, env);

    const [admin] = await db.select().from(users).where(eq(users.username, "admin"));
    expect(admin?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(admin?.passwordHash).not.toContain(env.SEED_ADMIN_PASSWORD);
    expect(await verifyPassword(admin?.passwordHash ?? "", env.SEED_ADMIN_PASSWORD)).toBe(true);
  });

  it("gives the assessor the role its env var names", async () => {
    await seedUsers(db, { ...env, SEED_ASSESSOR_ROLE: "admin" });

    const [assessor] = await db.select().from(users).where(eq(users.username, "assessor"));
    expect(assessor?.role).toBe("admin");
  });

  it("treats an empty assessor role as the default, reviewer", async () => {
    await seedUsers(db, { ...env, SEED_ASSESSOR_ROLE: "" });

    const [assessor] = await db.select().from(users).where(eq(users.username, "assessor"));
    expect(assessor?.role).toBe("reviewer");
  });

  it("updates the passwords when run again, without duplicating anyone", async () => {
    await seedUsers(db, env);
    await seedUsers(db, { ...env, SEED_REVIEWER_PASSWORD: "a-new-reviewer-pass" });

    const [reviewer] = await db.select().from(users).where(eq(users.username, "ops.reviewer"));
    expect(await verifyPassword(reviewer?.passwordHash ?? "", "a-new-reviewer-pass")).toBe(true);
    expect(await db.$count(users)).toBe(3);
  });

  it("refuses to seed when a password is missing or short, and writes nothing", async () => {
    const { SEED_ADMIN_PASSWORD: _omitted, ...withoutAdmin } = env;

    await expect(seedUsers(db, withoutAdmin)).rejects.toThrow(/SEED_ADMIN_PASSWORD/);
    await expect(seedUsers(db, { ...env, SEED_REVIEWER_PASSWORD: "short" })).rejects.toThrow(
      /SEED_REVIEWER_PASSWORD/,
    );
    expect(await db.$count(users)).toBe(0);
  });

  it("refuses an assessor username that would overwrite a seeded account", async () => {
    await expect(seedUsers(db, { ...env, SEED_ASSESSOR_USERNAME: "Admin" })).rejects.toThrow(
      /SEED_ASSESSOR_USERNAME/,
    );
  });
});
