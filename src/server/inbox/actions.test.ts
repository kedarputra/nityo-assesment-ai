import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db/database";
import { agentRuns, auditEvents, inboxRuns, inventory, users } from "@/db/schema";
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
  finishInboxRunAction,
  resetToSnapshotAction,
  runAgentAction,
  runInboxEmailAction,
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
}));
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
  });

  afterEach(async () => {
    cookieJar.clear();
    await testDatabase.close();
  });

  it("runs the agent on E001 for a reviewer: released, with the Proposal pane's headline facts and reply", async () => {
    const reviewerId = await signInAs("reviewer");

    expect(await runAgentAction("E001")).toEqual({ ok: true });

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
  });

  afterEach(async () => {
    cookieJar.clear();
    await testDatabase.close();
  });

  it("refuses a reviewer every admin action, and changes nothing", async () => {
    await signInAs("reviewer");

    await expect(startInboxRunAction()).rejects.toThrow(/admin/);
    await expect(runInboxEmailAction({ inboxRunId: 1, emailId: "E001" })).rejects.toThrow(/admin/);
    await expect(stopInboxRunAction()).rejects.toThrow(/admin/);
    await expect(finishInboxRunAction(1)).rejects.toThrow(/admin/);
    await expect(resetToSnapshotAction({ confirmed: true })).rejects.toThrow(/admin/);

    expect(await database.$count(inboxRuns)).toBe(0);
    expect(await database.$count(agentRuns)).toBe(0);
    expect(await database.$count(auditEvents)).toBe(0);
  });

  it("runs the inbox one email at a time for an admin, and refuses a second Run all", async () => {
    await signInAs("admin");

    const started = await startInboxRunAction();
    if (!started.ok) throw new Error(started.message);
    expect(started.plan.emails[0]).toEqual({ emailId: "E001", position: 1 });
    expect(await runInboxEmailAction({ inboxRunId: started.plan.inboxRunId, emailId: "E001" })).toEqual({ ok: true, outcome: "done" });

    expect(await startInboxRunAction()).toEqual({ ok: false, message: "Run all is already going. Let it finish, or stop it first." });
  });

  it("refuses a reset while a run holds the lock, with the words from the decision", async () => {
    await signInAs("admin");
    await startInboxRunAction();

    expect(await resetToSnapshotAction({ confirmed: true })).toEqual({ ok: false, message: "A run is in progress. Stop it first." });

    await stopInboxRunAction();
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
