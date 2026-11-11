import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db/database";
import { agentRuns, auditEvents, inboxRuns, rateLimitEvents, users } from "@/db/schema";
import { AGENT_OFF_MESSAGE } from "@/model/agent-switch";
import { getSchedule } from "@/server/agent/schedule";
import { SESSION_COOKIE } from "@/server/auth/gate";
import { hashPassword } from "@/server/auth/password";
import { signIn } from "@/server/auth/sessions";
import { RATE_LIMITS } from "@/server/rate-limits";
import { ingestSnapshot } from "@/snapshot/snapshot";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import {
  createLabelAction,
  deleteLabelAction,
  discardReplyAction,
  runSelectedAction,
  saveReplyAction,
  searchAction,
  setLabelsAction,
  setScheduleAction,
  setTriageAction,
} from "./actions";
import { findReply } from "./replies";
import { listLabels, listTriage } from "./triage";

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
// The run's emails are read after the action answers (`after`); here that work is only collected,
// so no model is ever called.
const background = vi.hoisted(() => ({ scheduled: [] as (() => unknown)[] }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (work: () => unknown) => {
    background.scheduled.push(work);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/db/client", () => ({ getDatabase: () => database }));

async function signInAs(role: "reviewer" | "admin"): Promise<number> {
  const password = "a long enough password";
  await database.insert(users).values({ username: `ops.${role}`, passwordHash: await hashPassword(password), role });
  const session = await signIn(database, { username: `ops.${role}`, password }, new Date());
  if (!session.ok) throw new Error("sign-in failed");
  cookieJar.set(SESSION_COOKIE, session.token);
  return session.user.id;
}

describe("the desk's actions (ADR 0005)", () => {
  let testDatabase: TestDatabase;

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    database = testDatabase.db;
    await ingestSnapshot(database);
    background.scheduled = [];
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    cookieJar.clear();
    await testDatabase.close();
  });

  describe("labels and triage", () => {
    it("needs a signed-in person", async () => {
      await expect(createLabelAction({ name: "VIP", color: "dusk" })).rejects.toThrow();
      expect(await listLabels(database)).toEqual([]);
    });

    it("creates a label and hands it back, and refuses a second of the same name in words", async () => {
      await signInAs("reviewer");

      const created = await createLabelAction({ name: "VIP", color: "dusk" });
      const again = await createLabelAction({ name: "vip", color: "red" });

      expect(created).toEqual({ ok: true, label: { id: expect.any(Number), name: "VIP", color: "dusk" } });
      expect(again).toEqual({ ok: false, message: "A label with that name already exists." });
    });

    it("refuses a colour that is not one of the labels'", async () => {
      await signInAs("reviewer");

      const result = await createLabelAction({ name: "VIP", color: "purple" as "dusk" });

      expect(result.ok).toBe(false);
    });

    it("puts labels on emails, and takes a deleted label off them", async () => {
      await signInAs("reviewer");
      const created = await createLabelAction({ name: "VIP", color: "dusk" });
      if (!created.ok) throw new Error(created.message);

      expect(await setLabelsAction({ emailIds: ["E001", "E002"], add: [created.label.id] })).toEqual({ ok: true });
      expect((await listTriage(database)).get("E002")?.labelIds).toEqual([created.label.id]);

      expect(await deleteLabelAction({ labelId: created.label.id })).toEqual({ ok: true });
      expect(await listTriage(database)).toEqual(new Map());
    });

    it("sets a status and a flag on selected emails", async () => {
      await signInAs("reviewer");

      expect(await setTriageAction({ emailIds: ["E003", "E004"], status: "done", flag: "complete" })).toEqual({ ok: true });

      expect((await listTriage(database)).get("E004")).toMatchObject({ status: "done", flag: "complete" });
    });

    it("refuses email ids that are not the inbox's shape, more than 50, or a change of nothing", async () => {
      await signInAs("reviewer");
      const many = Array.from({ length: 51 }, (_, index) => `E${String(index + 1).padStart(3, "0")}`);

      expect((await setTriageAction({ emailIds: ["1; drop"], status: "done" })).ok).toBe(false);
      expect((await setTriageAction({ emailIds: many, status: "done" })).ok).toBe(false);
      expect((await setTriageAction({ emailIds: [], status: "done" })).ok).toBe(false);
      expect((await setTriageAction({ emailIds: ["E001"] })).ok).toBe(false);
      expect(await database.$count(auditEvents)).toBe(0);
    });
  });

  describe("the reply composer", () => {
    it("saves, approves and discards a reply, as the signed-in person", async () => {
      await signInAs("reviewer");

      expect(await saveReplyAction({ emailId: "E002", subject: "RE: supplies", body: "Coming Thursday.", state: "ready" })).toEqual({ ok: true });
      expect(await findReply(database, "E002")).toMatchObject({ state: "ready", updatedByName: "ops.reviewer" });

      expect(await discardReplyAction({ emailId: "E002" })).toEqual({ ok: true });
      expect((await findReply(database, "E002")).state).toBe("none");
    });

    it("refuses an empty reply for sending, in words", async () => {
      await signInAs("reviewer");

      expect(await saveReplyAction({ emailId: "E002", subject: "RE: supplies", body: " ", state: "ready" })).toEqual({
        ok: false,
        message: "The reply is empty. Write what would go out first.",
      });
    });
  });

  describe("running the agent on selected emails", () => {
    it("is refused while the agent is switched off, before any write", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "");
      vi.stubEnv("GEMINI_API_KEY", "");
      await signInAs("reviewer");

      expect(await runSelectedAction({ emailIds: ["E001"] })).toEqual({ ok: false, message: AGENT_OFF_MESSAGE });
      expect(await database.$count(inboxRuns)).toBe(0);
    });

    it("starts a background run over the selected emails left to read, counting each against the hourly limit", async () => {
      vi.stubEnv("GEMINI_API_KEY", "test-key-never-sent");
      const userId = await signInAs("reviewer");
      await database.insert(agentRuns).values({ runId: "done", emailId: "E001", modelId: "fake", startedAt: new Date(), endedAt: new Date(), outcome: "no_action" });

      const result = await runSelectedAction({ emailIds: ["E005", "E001", "E002"] });

      expect(result).toEqual({ ok: true, count: 2 });
      const [run] = await database.select().from(inboxRuns);
      expect(run).toMatchObject({ startedBy: userId, trigger: "person", origin: "https://desk.test" });
      expect(run?.emailIds?.sort()).toEqual(["E002", "E005"]);
      expect(await database.$count(rateLimitEvents)).toBe(2);
      expect(background.scheduled).toHaveLength(1);
    });

    it("is refused, starting and counting nothing, when the emails would pass the hourly limit", async () => {
      vi.stubEnv("GEMINI_API_KEY", "test-key-never-sent");
      const userId = await signInAs("reviewer");
      const used = RATE_LIMITS["agent-run"] - 1;
      await database.insert(rateLimitEvents).values(Array.from({ length: used }, () => ({ userId, action: "agent-run" as const, at: new Date() })));

      const result = await runSelectedAction({ emailIds: ["E001", "E002"] });

      expect(result).toMatchObject({ ok: false, message: expect.stringContaining("limit") });
      expect(await database.$count(inboxRuns)).toBe(0);
      expect(await database.$count(rateLimitEvents)).toBe(used);
      expect(background.scheduled).toHaveLength(0);
    });

    it("is refused while a run is already going", async () => {
      vi.stubEnv("GEMINI_API_KEY", "test-key-never-sent");
      await signInAs("reviewer");
      await runSelectedAction({ emailIds: ["E001"] });

      const second = await runSelectedAction({ emailIds: ["E002"] });

      expect(second).toEqual({ ok: false, message: "The agent is already reading the selected emails. Let it finish, or stop it first." });
      expect(await database.$count(inboxRuns)).toBe(1);
    });

    it("refuses more than 20 emails, emails not in the inbox, and emails already read", async () => {
      vi.stubEnv("GEMINI_API_KEY", "test-key-never-sent");
      await signInAs("reviewer");
      await database.insert(agentRuns).values({ runId: "done", emailId: "E001", modelId: "fake", startedAt: new Date(), endedAt: new Date(), outcome: "no_action" });
      const many = Array.from({ length: 21 }, (_, index) => `E${String(index + 1).padStart(3, "0")}`);

      expect((await runSelectedAction({ emailIds: many })).ok).toBe(false);
      expect((await runSelectedAction({ emailIds: ["E999"] })).ok).toBe(false);
      expect(await runSelectedAction({ emailIds: ["E001"] })).toEqual({ ok: false, message: "The agent has already read the selected emails." });
      expect(await database.$count(inboxRuns)).toBe(0);
    });
  });

  describe("the schedule", () => {
    it("is an admin's to set", async () => {
      await signInAs("reviewer");

      await expect(setScheduleAction({ enabled: true, intervalMinutes: 5 })).rejects.toThrow(/admin/);
      expect((await getSchedule(database, {})).enabled).toBe(false);
    });

    it("is switched on by an admin, with one of the intervals", async () => {
      await signInAs("admin");

      expect((await setScheduleAction({ enabled: true, intervalMinutes: 7 })).ok).toBe(false);
      expect(await setScheduleAction({ enabled: true, intervalMinutes: 30 })).toEqual({ ok: true });
      expect(await getSchedule(database, {})).toMatchObject({ enabled: true, intervalMinutes: 30 });
    });
  });

  describe("search", () => {
    it("searches emails, customers, products and orders for a signed-in person", async () => {
      await signInAs("reviewer");

      const result = await searchAction({ query: "bluefin", mode: "keyword" });

      if (!result.ok) throw new Error(result.message);
      expect(result.results.customers.map((customer) => customer.customerId)).toEqual(["C001"]);
      expect(result.results.emails.map((hit) => hit.emailId)).toContain("E001");
    });

    it("falls back to keywords for search by meaning without a Gemini key", async () => {
      vi.stubEnv("GEMINI_API_KEY", "");
      await signInAs("reviewer");

      const result = await searchAction({ query: "gloves", mode: "meaning" });

      expect(result).toMatchObject({ ok: true, results: { mode: "meaning", fellBack: true, reason: "Search by meaning needs a Gemini key." } });
    });

    it("refuses a query past 200 characters", async () => {
      await signInAs("reviewer");

      expect((await searchAction({ query: "x".repeat(201), mode: "keyword" })).ok).toBe(false);
    });
  });
});
