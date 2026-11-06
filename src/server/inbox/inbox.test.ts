import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentRuns, users } from "@/db/schema";
import { ingestSnapshot } from "@/snapshot/snapshot";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import {
  countByFilter,
  dismissTip,
  findInboxEmail,
  isTipDismissed,
  listInboxEmails,
  parseInboxQuery,
} from "./inbox";

describe("the inbox", () => {
  let testDatabase: TestDatabase;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await ingestSnapshot(testDatabase.db);
  });

  afterAll(async () => {
    await testDatabase.close();
  });

  async function addUser(username: string): Promise<number> {
    const [user] = await testDatabase.db
      .insert(users)
      .values({ username, passwordHash: "not a real hash", role: "reviewer" })
      .returning({ id: users.id });
    if (!user) throw new Error(`could not add ${username}`);
    return user.id;
  }

  it("lists all 40 emails in received_at order, none run yet", async () => {
    const emails = await listInboxEmails(testDatabase.db);

    expect(emails).toHaveLength(40);
    expect(emails[0]).toMatchObject({ emailId: "E001", fromName: "Maria Lopez", subject: "Order for this week" });
    const times = emails.map((email) => email.receivedAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(emails.map((email) => email.status))).toEqual(new Set(["not_run"]));
  });

  it("finds one email with its body, and nothing for an unknown id", async () => {
    const email = await findInboxEmail(testDatabase.db, "E005");

    expect(email).toMatchObject({ emailId: "E005", fromEmail: "ops@metrofitness.example" });
    expect(email?.body).toContain("Downtown: 4 cs hand sanitizer refills");
    expect(await findInboxEmail(testDatabase.db, "E999")).toBeNull();
  });

  it("counts an email that has not been run under All and Other only", async () => {
    const emails = await listInboxEmails(testDatabase.db);

    expect(countByFilter(emails)).toEqual({ all: 40, "needs-you": 0, done: 0, other: 40 });
  });

  it("remembers a dismissed tip for that user only", async () => {
    const ana = await addUser("ana");
    const ben = await addUser("ben");

    expect(await isTipDismissed(testDatabase.db, ana)).toBe(false);
    await dismissTip(testDatabase.db, ana, new Date("2026-11-02T12:05:00Z"));

    expect(await isTipDismissed(testDatabase.db, ana)).toBe(true);
    expect(await isTipDismissed(testDatabase.db, ben)).toBe(false);
  });
});

describe("an email's status after an Agent run", () => {
  let testDatabase: TestDatabase;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await ingestSnapshot(testDatabase.db);
    const startedAt = new Date("2026-11-02T12:05:00Z");
    const endedAt = new Date("2026-11-02T12:06:00Z");
    await testDatabase.db.insert(agentRuns).values([
      { runId: "run-1", emailId: "E001", modelId: "fake", startedAt, endedAt, outcome: "released" },
      { runId: "run-2", emailId: "E002", modelId: "fake", startedAt },
      { runId: "run-3", emailId: "E003", modelId: "fake", startedAt, endedAt, outcome: "proposal" },
      { runId: "run-4", emailId: "E004", modelId: "fake", startedAt, endedAt, outcome: "failed" },
    ]);
  });

  afterAll(async () => {
    await testDatabase.close();
  });

  it("shows the latest run: done, still reading, needs you, or failed", async () => {
    const emails = await listInboxEmails(testDatabase.db);
    const statuses = Object.fromEntries(emails.slice(0, 5).map((email) => [email.emailId, email.status]));

    expect(statuses).toEqual({ E001: "released", E002: "reading", E003: "needs_you", E004: "failed", E005: "not_run" });
    expect(await findInboxEmail(testDatabase.db, "E001")).toMatchObject({ status: "released" });
    expect(countByFilter(emails)).toEqual({ all: 40, "needs-you": 2, done: 1, other: 37 });
  });
});

describe("parseInboxQuery", () => {
  it("reads the filter, the selected email and the phone's view from the URL", () => {
    expect(parseInboxQuery({ filter: "needs-you", email: "E005", view: "detail" })).toEqual({
      filter: "needs-you",
      emailId: "E005",
      view: "detail",
    });
  });

  it("falls back to All, no selection and the list for anything it does not know", () => {
    expect(parseInboxQuery({ filter: "spam", email: "<script>", view: ["a", "b"] })).toEqual({
      filter: "all",
      emailId: null,
      view: "list",
    });
    expect(parseInboxQuery({})).toEqual({ filter: "all", emailId: null, view: "list" });
  });
});
