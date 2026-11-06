import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentRuns, proposals, users } from "@/db/schema";
import { ingestSnapshot } from "@/snapshot/snapshot";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import {
  countByFilter,
  dismissTip,
  findInboxEmail,
  isTipDismissed,
  listInboxEmails,
  nextNeedingYou,
  parseInboxQuery,
  type InboxEmail,
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

describe("an email's status after a person decides", () => {
  let testDatabase: TestDatabase;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await ingestSnapshot(testDatabase.db);
    const startedAt = new Date("2026-11-02T12:05:00Z");
    const endedAt = new Date("2026-11-02T12:06:00Z");
    const runs = ["E001", "E002", "E003", "E004", "E005"].map((emailId) => ({
      runId: `run-${emailId}`,
      emailId,
      modelId: "fake",
      startedAt,
      endedAt,
      outcome: "proposal" as const,
    }));
    await testDatabase.db.insert(agentRuns).values(runs);
    const proposal = { customerId: "C001", shipToId: "S001", requestedDate: "2026-11-05", totalCents: 100, checks: [] };
    await testDatabase.db.insert(proposals).values([
      { ...proposal, runId: "run-E001", emailId: "E001", status: "released" },
      { ...proposal, runId: "run-E002", emailId: "E002", status: "rejected" },
      { ...proposal, runId: "run-E003", emailId: "E003", status: "held" },
      // E004's run left two Proposals: one approved, one still open.
      { ...proposal, runId: "run-E004", emailId: "E004", status: "released" },
      { ...proposal, runId: "run-E004", emailId: "E004", status: "open" },
      { ...proposal, runId: "run-E005", emailId: "E005", status: "rejected" },
      { ...proposal, runId: "run-E005", emailId: "E005", status: "released" },
    ]);
  });

  afterAll(async () => {
    await testDatabase.close();
  });

  it("is approved, rejected or on hold once every Proposal is decided, and needs you while one is open", async () => {
    const emails = await listInboxEmails(testDatabase.db);
    const statuses = Object.fromEntries(emails.slice(0, 5).map((email) => [email.emailId, email.status]));

    expect(statuses).toEqual({ E001: "approved", E002: "rejected", E003: "on_hold", E004: "needs_you", E005: "approved" });
    expect(countByFilter(emails)).toEqual({ all: 40, "needs-you": 1, done: 3, other: 36 });
  });
});

describe("nextNeedingYou", () => {
  const at = new Date("2026-11-02T12:00:00Z");
  const email = (emailId: string, status: InboxEmail["status"]): InboxEmail => ({
    emailId,
    receivedAt: at,
    fromName: "Someone",
    fromEmail: "someone@example.test",
    subject: "An order",
    status,
  });
  const inbox = [email("E001", "needs_you"), email("E002", "released"), email("E003", "approved"), email("E004", "failed")];

  it("moves to the next email after this one that needs you, wrapping to the start", () => {
    expect(nextNeedingYou(inbox, "E002")).toBe("E004");
    expect(nextNeedingYou(inbox, "E004")).toBe("E001");
    expect(nextNeedingYou(inbox, "E003")).toBe("E004");
  });

  it("is null when nothing else needs you", () => {
    expect(nextNeedingYou([email("E001", "needs_you"), email("E002", "approved")], "E001")).toBeNull();
  });
});
