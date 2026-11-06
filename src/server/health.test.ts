import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import { checkHealth } from "./health";

describe("checkHealth", () => {
  let testDatabase: TestDatabase | undefined;

  afterEach(async () => {
    await testDatabase?.close();
    testDatabase = undefined;
    vi.restoreAllMocks();
  });

  it("answers 200 when the database answers a query", async () => {
    testDatabase = await createTestDatabase();
    const database = testDatabase.db;

    const response = await checkHealth(() => database);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 503 without the error's detail when the database cannot be reached", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const unreachable = () => {
      throw new Error("connect ECONNREFUSED postgres://user:secret@db.internal:5432/app");
    };

    const response = await checkHealth(unreachable);

    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ status: "unavailable" });
    expect(text).not.toContain("secret");
  });

  it("logs the failure without the connection string", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await checkHealth(() => {
      throw new Error("connect ECONNREFUSED postgres://user:secret@db.internal:5432/app");
    });

    expect(logged).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logged.mock.calls)).not.toContain("secret");
  });
});
