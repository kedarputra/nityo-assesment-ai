import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db/database";
import { customers, emails, users } from "@/db/schema";
import { verifyPassword } from "@/server/auth/password";
import { readDataPack, type Snapshot } from "@/snapshot/data-pack";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import { prepareDatabase } from "./prepare-database";

const seedEnv = {
  SEED_REVIEWER_PASSWORD: "reviewer-password-1",
  SEED_ADMIN_PASSWORD: "admin-password-12",
  SEED_ASSESSOR_USERNAME: "assessor",
  SEED_ASSESSOR_PASSWORD: "assessor-password-1",
};

describe("prepareDatabase, the deploy's database step", () => {
  let snapshot: Snapshot;
  let testDatabase: TestDatabase;
  let db: Database;
  let migrations: number;

  // The test database is already migrated; the fake counts that the step asked for it.
  const migrate = async () => {
    migrations += 1;
  };

  beforeAll(() => {
    snapshot = readDataPack();
  });

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    db = testDatabase.db;
    migrations = 0;
  });

  afterEach(async () => {
    await testDatabase.close();
  });

  it("migrates, then seeds the Snapshot and the users into an empty database", async () => {
    const result = await prepareDatabase(db, { migrate, seedEnv, snapshot });

    expect(migrations).toBe(1);
    expect(result).toEqual({ snapshotSeeded: true, usersSeeded: true });
    expect(await db.$count(customers)).toBe(snapshot.customers.length);
    expect(await db.$count(emails)).toBe(snapshot.emails.length);
    expect(await db.$count(users)).toBe(3);
  });

  it("never reseeds a database that already has data", async () => {
    await prepareDatabase(db, { migrate, seedEnv, snapshot });
    const customerId = snapshot.customers[0]?.customerId ?? "";
    await db.update(customers).set({ name: "Changed since the seed" }).where(eq(customers.customerId, customerId));

    const rotated = { ...seedEnv, SEED_ADMIN_PASSWORD: "a-different-password" };
    const result = await prepareDatabase(db, { migrate, seedEnv: rotated, snapshot });

    expect(migrations).toBe(2);
    expect(result).toEqual({ snapshotSeeded: false, usersSeeded: false });
    const [customer] = await db.select().from(customers).where(eq(customers.customerId, customerId));
    expect(customer?.name).toBe("Changed since the seed");
    const [admin] = await db.select().from(users).where(eq(users.username, "admin"));
    expect(await verifyPassword(admin?.passwordHash ?? "", seedEnv.SEED_ADMIN_PASSWORD)).toBe(true);
  });

  it("needs no SEED_* variables once the users exist", async () => {
    await prepareDatabase(db, { migrate, seedEnv, snapshot });

    await expect(prepareDatabase(db, { migrate, seedEnv: {}, snapshot })).resolves.toEqual({
      snapshotSeeded: false,
      usersSeeded: false,
    });
  });

  it("fails, writing no Snapshot, when an empty database has no SEED_* variables", async () => {
    await expect(prepareDatabase(db, { migrate, seedEnv: {}, snapshot })).rejects.toThrow(/Cannot seed users/);

    expect(await db.$count(customers)).toBe(0);
    expect(await db.$count(users)).toBe(0);
  });
});
