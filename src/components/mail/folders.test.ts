import { describe, expect, it } from "vitest";
import { folderCounts, inFolder, mailHref, parseFolder, type DeskEmail } from "./folders";
import { groupEmails, sortEmails } from "./mail-list";

function email(overrides: Partial<DeskEmail>): DeskEmail {
  return {
    emailId: "E001",
    receivedAt: new Date("2026-11-02T12:02:00Z"),
    fromName: "Maria Lopez",
    fromEmail: "maria@bluefinbistro.example",
    subject: "Order for this week",
    preview: "Please send the following to Pier Street",
    customerName: "Bluefin Bistro Group",
    status: "not_run",
    triageStatus: "new",
    flag: "none",
    labelIds: [],
    reply: "none",
    ...overrides,
  };
}

const day = [
  email({ emailId: "E001", status: "released", fromName: "Maria Lopez" }),
  email({ emailId: "E002", status: "needs_you", fromName: "Paul Ng", receivedAt: new Date("2026-11-02T12:09:00Z"), customerName: "Sunrise Daycare" }),
  email({ emailId: "E003", status: "failed", flag: "follow-up", fromName: "Dana White", receivedAt: new Date("2026-11-02T12:14:00Z"), labelIds: [7] }),
  email({ emailId: "E004", status: "not_run", reply: "draft", fromName: "Aisha Khan", receivedAt: new Date("2026-11-02T12:21:00Z"), triageStatus: "waiting" }),
  email({ emailId: "E005", status: "approved", reply: "ready", fromName: "Jenna Brooks", receivedAt: new Date("2026-11-02T12:26:00Z"), customerName: null }),
];

describe("the mail view's folders (ADR 0005)", () => {
  it("files every email by the agent's outcome, a person's flag, its reply and its labels", () => {
    expect(folderCounts(day)).toEqual({ inbox: 5, "needs-review": 2, flagged: 1, done: 2, "not-run": 1, drafts: 1, ready: 1 });
    expect(inFolder(day[2]!, "label-7")).toBe(true);
    expect(inFolder(day[0]!, "label-7")).toBe(false);
  });

  it("reads the folder from the URL, and falls back to the inbox for anything else", () => {
    expect(parseFolder("needs-review")).toBe("needs-review");
    expect(parseFolder("label-12")).toBe("label-12");
    expect(parseFolder("label-x")).toBe("inbox");
    expect(parseFolder("<script>")).toBe("inbox");
    expect(parseFolder(undefined)).toBe("inbox");
  });

  it("keeps the inbox's address short and puts everything else in the query", () => {
    expect(mailHref({ folder: "inbox" })).toBe("/");
    expect(mailHref({ folder: "flagged", emailId: "E003", view: "detail" })).toBe("/?folder=flagged&email=E003&view=detail");
  });
});

describe("sorting and grouping the list", () => {
  it("sorts oldest or newest first, by sender, by customer, or with what needs review on top", () => {
    expect(sortEmails(day, "oldest").map((e) => e.emailId)).toEqual(["E001", "E002", "E003", "E004", "E005"]);
    expect(sortEmails(day, "newest").map((e) => e.emailId)[0]).toBe("E005");
    expect(sortEmails(day, "sender").map((e) => e.fromName)[0]).toBe("Aisha Khan");
    expect(sortEmails(day, "customer").map((e) => e.emailId).at(-1)).toBe("E005");
    expect(sortEmails(day, "attention").map((e) => e.emailId).slice(0, 2)).toEqual(["E002", "E003"]);
  });

  it("groups by what needs review, by status and by label, an unlabelled email under No label", () => {
    expect(groupEmails(day, "attention", []).map((group) => [group.title, group.emails.length])).toEqual([
      ["Needs review", 2],
      ["Everything else", 3],
    ]);
    expect(groupEmails(day, "triage", []).map((group) => group.title)).toEqual(["New", "Waiting on customer"]);
    const byLabel = groupEmails(day, "label", [{ id: 7, name: "Key account", color: "dusk", count: 1 }]);
    expect(byLabel.map((group) => group.title)).toEqual(["Key account", "No label"]);
  });
});
