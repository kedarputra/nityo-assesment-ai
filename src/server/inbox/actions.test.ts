import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db/database";
import { agentRuns, auditEvents, inboxRuns, inventory, users } from "@/db/schema";
import { AGENT_OFF_MESSAGE } from "@/model/agent-switch";
import type { ModelRequest } from "@/model/model";
import { ScriptedModel } from "@/model/scripted-model";
import { SESSION_COOKIE } from "@/server/auth/gate";
import { signIn } from "@/server/auth/sessions";
import { hashPassword } from "@/server/auth/password";
import { ingestSnapshot } from "@/snapshot/snapshot";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import { e001Script } from "@/test/e001-script";
import {
  dismissTipAction,
  resetToSnapshotAction,
  runAgentAction,
  startInboxRunAction,
  stopInboxRunAction,
} from "./actions";
import { findEmailWork } from "./email-work";
import { findInboxEmail, isTipDismissed } from "./inbox";

const cookieJar = new Map<string, string>();
let database: Database;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
  headers: async () => new Headers({ host: "desk.test", "x-forwarded-proto": "https" }),
}));
// The agent reads on after the action answers (`after`, ADR 0004); a test waits for that work.
const background = vi.hoisted(() => ({ pending: [] as Promise<unknown>[] }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (work: () => unknown) => {
    background.pending.push(Promise.resolve().then(work));
  },
}));

async function settled(): Promise<void> {
  while (background.pending.length > 0) await Promise.all(background.pending.splice(0));
}
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// The Reset's owner connection is the same test database here.
vi.mock("@/db/client", () => ({
  getDatabase: () => database,
  withOwnerDatabase: (work: (db: Database) => Promise<unknown>) => work(database),
}));
// The action builds the real model; here it gets the scripted fake, so no test calls the API.
vi.mock("@/model/anthropic-model", () => ({
  AnthropicModel: class {
    private readonly scripted = new ScriptedModel(e001Script());
    send(request: ModelRequest) {
      return this.scripted.send(request);
    }
  },
  modelIdFromEnv: () => "claude-opus-5-5",
}));

async function signInAs(role: "reviewer" | "admin"): Promise<number> {
  const password = "a long enough password";
  await database.insert(users).values({ username: `ops.${role}`, passwordHash: await hashPassword(password), role });
  const session = await signIn(database, { username: `ops.${role}`, password }, new Date());
  if (!session.ok) throw new Error("sign-in failed");
  cookieJar.set(SESSION_COOKIE, session.token);
  return session.user.id;
}

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

describe("runAgentAction", () => {
  let testDatabase: TestDatabase;

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    database = testDatabase.db;
    await ingestSnapshot(database);
    // The action runs only with a key (src/model/agent-switch.ts); the model itself is the fake.
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-never-sent");
  });

  afterEach(async () => {
    await settled();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    cookieJar.clear();
    await testDatabase.close();
  });

  it("refuses calmly, and writes no Agent run, when the deploy has no Anthropic key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await signInAs("reviewer");

    expect(await runAgentAction("E001")).toEqual({
      ok: false,
      message: "The agent is switched off on this desk for now, so it won’t read emails.",
    });
    expect(await database.select().from(agentRuns)).toHaveLength(0);
    expect(await findInboxEmail(database, "E001")).toMatchObject({ status: "not_run" });
  });

  it("runs the agent on E001 for a reviewer: released, with the Proposal pane's headline facts and reply", async () => {
    const reviewerId = await signInAs("reviewer");

    expect(await runAgentAction("E001")).toEqual({ ok: true });
    // Answered at once: the run is recorded and the agent is reading in the background.
    expect(await findInboxEmail(database, "E001")).toMatchObject({ status: "reading" });
    await settled();

    expect(await findInboxEmail(database, "E001")).toMatchObject({ status: "released" });
    const work = await findEmailWork(database, "E001");
    expect(work?.run).toMatchObject({ finished: true, outcome: "released" });
    expect(work?.proposals).toHaveLength(1);
    expect(work?.proposals[0]).toMatchObject({
      status: "released",
      soNumber: "SO-24059",
      customerName: "Bluefin Bistro Group",
      shipToName: "Bluefin Bistro - Pier Street",
      totalCents: 67200,
    });
    expect(work?.proposals[0]?.lines.map((line) => [line.sku, line.quantity, line.lineTotalCents])).toEqual([
      ["HPS-1408", 4, 18000],
      ["HPS-1402", 6, 42600],
      ["HPS-1502", 2, 6600],
    ]);
    expect(work?.draftReply?.body).toContain("SO-24059");
    const [stock] = await database.select().from(inventory).where(eq(inventory.sku, "HPS-1408"));
    expect(stock?.available).toBe(26);
    const [started] = await database.select().from(auditEvents).where(eq(auditEvents.action, "run.started"));
    expect(started?.userId).toBe(reviewerId);
  });

  it("refuses an email that has already run, without running it again", async () => {
    await signInAs("reviewer");
    await runAgentAction("E001");
    await settled();

    const again = await runAgentAction("E001");

    expect(again).toEqual({ ok: false, message: "The agent has already run on E001." });
  });

  it("refuses an id that is not an email", async () => {
    await signInAs("reviewer");

    expect(await runAgentAction("'; drop table emails; --")).toMatchObject({ ok: false });
  });

  it("does nothing for someone who is not signed in", async () => {
    await expect(runAgentAction("E001")).rejects.toThrow();
    expect(await findEmailWork(database, "E001")).toBeNull();
  });
});

describe("the admin's controls", () => {
  let testDatabase: TestDatabase;

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    database = testDatabase.db;
    await ingestSnapshot(database);
    // The fake model never calls out; the key only switches the agent on (agent-switch.ts).
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-never-sent");
    // A step asks the app for the next one over HTTP; here nothing leaves the test.
    vi.stubGlobal("fetch", async () => new Response(null, { status: 202 }));
  });

  afterEach(async () => {
    await settled();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    cookieJar.clear();
    await testDatabase.close();
  });

  it("refuses Run all while the agent is switched off, before any write", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await signInAs("admin");

    expect(await startInboxRunAction()).toEqual({ ok: false, message: AGENT_OFF_MESSAGE });
    expect(await database.$count(inboxRuns)).toBe(0);
    expect(await database.$count(agentRuns)).toBe(0);
  });

  it("refuses a reviewer every admin action, and changes nothing", async () => {
    await signInAs("reviewer");

    await expect(startInboxRunAction()).rejects.toThrow(/admin/);
    await expect(stopInboxRunAction()).rejects.toThrow(/admin/);
    await expect(resetToSnapshotAction({ confirmed: true })).rejects.toThrow(/admin/);

    expect(await database.$count(inboxRuns)).toBe(0);
    expect(await database.$count(agentRuns)).toBe(0);
    expect(await database.$count(auditEvents)).toBe(0);
  });

  it("runs the inbox in the background for an admin, one email per step, and refuses a second Run all", async () => {
    const asked: { url: string; body: unknown; origin: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
      asked.push({ url: String(url), body: JSON.parse(String(init.body)), origin: new Headers(init.headers).get("origin") });
      return new Response(null, { status: 202 });
    });
    await signInAs("admin");

    expect(await startInboxRunAction()).toEqual({ ok: true });
    expect(await startInboxRunAction()).toEqual({ ok: false, message: "Run all is already going. Let it finish, or stop it first." });
    await settled();

    // The first step read E001 in the background, then asked the app for the next step.
    expect(await findInboxEmail(database, "E001")).toMatchObject({ status: "released" });
    expect(asked).toEqual([
      {
        url: "https://desk.test/api/inbox-run/step",
        body: { inboxRunId: 1, token: expect.stringMatching(/^[0-9a-f]{64}$/) },
        origin: "https://desk.test",
      },
    ]);
  });

  it("refuses a reset while a run holds the lock, with the words from the decision", async () => {
    await signInAs("admin");
    await startInboxRunAction();

    expect(await resetToSnapshotAction({ confirmed: true })).toEqual({ ok: false, message: "A run is in progress. Stop it first." });

    await stopInboxRunAction();
    // The email being read when Stop was pressed finishes first.
    await settled();
    expect(await resetToSnapshotAction({ confirmed: true })).toEqual({ ok: true });
    const [first] = await database.select().from(auditEvents);
    expect(first).toMatchObject({ action: "snapshot.reset", detail: { by: "ops.admin" } });
  });

  it("does not reset without the confirmation", async () => {
    await signInAs("admin");

    expect(await resetToSnapshotAction({})).toMatchObject({ ok: false });
    expect(await database.$count(auditEvents)).toBe(0);
  });
});
