import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db/database";
import { inboxRuns, users } from "@/db/schema";
import { setSchedule } from "@/server/agent/schedule";
import { ingestSnapshot } from "@/snapshot/snapshot";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import { POST } from "./route";

let database: Database;
vi.mock("@/db/client", () => ({ getDatabase: () => database }));
// The first email is read after the answer (`after`); here the work is only collected, so no model runs.
const background = vi.hoisted(() => ({ scheduled: [] as (() => unknown)[] }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (work: () => unknown) => {
    background.scheduled.push(work);
  },
}));

const SECRET = "a-cron-secret-of-some-length";

function tick(authorization?: string, host = "desk.example"): Request {
  const headers = new Headers({ host, "x-forwarded-proto": "https" });
  if (authorization !== undefined) headers.set("authorization", authorization);
  return new Request(`https://${host}/api/agent/tick`, { method: "POST", headers });
}

describe("POST /api/agent/tick (ADR 0005)", () => {
  let testDatabase: TestDatabase;
  let adminId: number;

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    database = testDatabase.db;
    await ingestSnapshot(database);
    const [admin] = await database.insert(users).values({ username: "admin", passwordHash: "x", role: "admin" }).returning();
    if (!admin) throw new Error("no admin");
    adminId = admin.id;
    background.scheduled = [];
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await testDatabase.close();
  });

  it("answers 503 when this deploy has no CRON_SECRET", async () => {
    vi.stubEnv("CRON_SECRET", "");

    const response = await POST(tick(`Bearer ${SECRET}`));

    expect(response.status).toBe(503);
  });

  it("answers 401 without the secret, or with the wrong one, and starts nothing", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("GEMINI_API_KEY", "test-key-never-sent");
    await setSchedule(database, { enabled: true, intervalMinutes: 5, userId: adminId, at: new Date() });

    expect((await POST(tick())).status).toBe(401);
    expect((await POST(tick("Bearer wrong"))).status).toBe(401);
    expect((await POST(tick(SECRET))).status).toBe(401);
    expect(await database.$count(inboxRuns)).toBe(0);
  });

  it("says what the tick did", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);

    const response = await POST(tick(`Bearer ${SECRET}`));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: "disabled" });
  });

  it("starts a due run at the address it was called on, and reads its first email after answering", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("GEMINI_API_KEY", "test-key-never-sent");
    await setSchedule(database, { enabled: true, intervalMinutes: 5, userId: adminId, at: new Date(Date.now() - 60_000) });

    const response = await POST(tick(`Bearer ${SECRET}`, "harbor-point.example"));

    expect(await response.json()).toEqual({ result: "started" });
    const [run] = await database.select().from(inboxRuns);
    expect(run).toMatchObject({ trigger: "schedule", startedBy: adminId, origin: "https://harbor-point.example" });
    expect(background.scheduled).toHaveLength(1);
  });
});
