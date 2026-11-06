import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { appSettings } from "@/db/schema";
import { createTestDatabase, type TestDatabase } from "./database";

describe("createTestDatabase", () => {
  let databases: TestDatabase[] = [];

  async function freshDatabase() {
    const database = await createTestDatabase();
    databases.push(database);
    return database.db;
  }

  afterEach(async () => {
    await Promise.all(databases.map((database) => database.close()));
    databases = [];
  });

  it("gives a database with every migration applied", async () => {
    const db = await freshDatabase();

    await db.insert(appSettings).values({ key: "business_clock", value: "2026-11-02T07:00" });
    const rows = await db.select().from(appSettings).where(eq(appSettings.key, "business_clock"));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe("2026-11-02T07:00");
    expect(rows[0]?.updatedAt).toBeInstanceOf(Date);
  });

  it("gives each test its own database", async () => {
    const first = await freshDatabase();
    const second = await freshDatabase();

    await first.insert(appSettings).values({ key: "only_in_first", value: "yes" });

    expect(await second.$count(appSettings)).toBe(0);
  });
});
