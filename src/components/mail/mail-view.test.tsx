import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentPresence } from "@/server/desk/presence";
import type { ReplyView } from "@/server/desk/replies";
import type { InboxEmailWithBody } from "@/server/inbox/inbox";
import type { DeskEmail } from "./folders";
import { MailView, type MailViewProps } from "./mail-view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/server/desk/actions", () => ({}));
vi.mock("@/server/inbox/actions", () => ({}));

const idle: AgentPresence = {
  state: "idle",
  modelId: "gemini-3.5-flash-lite",
  reading: [],
  runAll: null,
  schedule: { enabled: false, intervalMinutes: 15, nextRunAt: null, configured: false },
};

function desk(overrides: Partial<DeskEmail>): DeskEmail {
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

const emails = Array.from({ length: 25 }, (_, index) =>
  desk({
    emailId: `E${String(index + 1).padStart(3, "0")}`,
    receivedAt: new Date(Date.UTC(2026, 10, 2, 12, index)),
    status: index === 1 ? "needs_you" : "not_run",
    flag: index === 2 ? "follow-up" : "none",
    labelIds: index === 0 ? [7] : [],
  }),
);

const maria: InboxEmailWithBody = {
  emailId: "E001",
  receivedAt: new Date("2026-11-02T12:00:00Z"),
  fromName: "Maria Lopez",
  fromEmail: "maria@bluefinbistro.example",
  subject: "Order for this week",
  body: "Please send HPS-1408 x 4.",
  status: "not_run",
};

const agentDraft: ReplyView = {
  emailId: "E001",
  to: "maria@bluefinbistro.example",
  subject: "RE: Order for this week",
  body: "Hi Maria, SO-24059 is confirmed.",
  state: "agent-draft",
  updatedAt: null,
  updatedByName: null,
};

function render(overrides: Partial<MailViewProps> = {}): string {
  return renderToStaticMarkup(
    <MailView
      folder="inbox"
      view="list"
      emails={emails}
      labels={[{ id: 7, name: "Key account", color: "dusk", count: 1 }]}
      selected={null}
      work={null}
      reply={null}
      presence={idle}
      isAdmin={false}
      notFound={false}
      {...overrides}
    />,
  );
}

describe("MailView, the list (ADR 0005)", () => {
  it("titles the folder with its count and purpose, with a search box for the folder alone", () => {
    const html = render();

    expect(html).toContain('<h1 id="mail-list-title" class="list-title">Inbox</h1>');
    expect(html).toContain('aria-label="25 emails"');
    expect(html).toContain('placeholder="Search Inbox"');
  });

  it("gives every row a checkbox and the page one, and pages the list by 20", () => {
    const html = render();

    expect(html.match(/<label class="row-check"><input type="checkbox"/g)).toHaveLength(20);
    expect(html).toContain("Select every email on this page");
    expect(html).toContain("1–20 of 25");
    expect(html).toContain("Page 1 of 2");
    expect(html).toMatch(/aria-label="Previous page" disabled=""/);
  });

  it("marks what needs review with a red filled flag and a follow-up with an amber one", () => {
    const html = render();

    expect(html).toMatch(/flag-mark--review" title="Needs review">.*fill="currentColor"/);
    expect(html).toContain('class="flag-mark flag-mark--follow" title="Flagged to follow up"');
    expect(html).toContain('<span class="label-chip label-chip--dusk">');
  });

  it("offers Sort, Group and Filter", () => {
    const html = render();

    expect(html).toContain('<option value="attention">Needs review first</option>');
    expect(html).toContain('<option value="label">Label</option>');
    expect(html).toContain("Needs review (red)");
  });
});

describe("MailView, the live box", () => {
  it("shows the emails being read as one box with a count, not as a sentence", () => {
    const html = render({
      presence: {
        ...idle,
        state: "active",
        reading: [
          { emailId: "E004", fromName: "Aisha Khan", subject: "RE: HV-3391", startedAt: new Date() },
          { emailId: "E005", fromName: "Jenna Brooks", subject: "Orders for 3 clubs", startedAt: new Date() },
        ],
        runAll: { trigger: "schedule", selected: null },
      },
    });

    expect(html).toContain('<span class="processing-number">2</span>');
    expect(html).toContain("emails being read");
    expect(html).toContain('<span class="run-tag">Scheduled run</span>');
    expect(html).toContain('<span class="id">E004</span>');
  });

  it("shows no box while the agent is idle", () => {
    expect(render()).not.toContain("processing-box");
  });
});

describe("MailView, the reading pane", () => {
  it("shows the email like Outlook, with a command bar and its place in the folder", () => {
    const html = render({ selected: maria, view: "detail", reply: agentDraft });

    expect(html).toContain('<h1 class="message-subject">Order for this week</h1>');
    expect(html).toContain("To orders@harborpointsupply.example");
    expect(html).toMatch(/<p class="message-customer-line">.*Bluefin Bistro Group<\/p>/);
    expect(html).toContain(">Reply</button>");
    expect(html).toContain("1 of 25");
    expect(html).toMatch(/aria-label="Next email"/);
    expect(html).toContain('<span class="label-chip label-chip--dusk">');
  });

  it("opens the composer at once when a person has a draft, prefilled, with Approve for sending", () => {
    const html = render({ selected: maria, view: "detail", reply: { ...agentDraft, state: "draft", updatedAt: new Date(), updatedByName: "ops.reviewer" } });

    expect(html).toContain('value="RE: Order for this week"');
    expect(html).toContain("Hi Maria, SO-24059 is confirmed.</textarea>");
    expect(html).toContain("Approve for sending");
    expect(html).toContain("Replies aren’t sent from this desk.");
  });

  it("renders a subject and body containing markup as text, never as HTML", () => {
    const hostile = { ...maria, subject: "<b>Urgent</b>", body: '<script>alert("x")</script>' };
    const html = render({ selected: hostile, emails: [desk({ subject: "<b>Urgent</b>" })], view: "detail", reply: agentDraft });

    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).toContain("&lt;b&gt;Urgent&lt;/b&gt;");
  });
});
