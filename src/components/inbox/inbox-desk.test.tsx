import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { InboxEmail, InboxEmailWithBody, InboxQuery } from "@/server/inbox/inbox";
import { countByFilter, isInFilter } from "@/server/inbox/inbox";
import { InboxDesk, type InboxDeskProps } from "./inbox-desk";

const maria: InboxEmailWithBody = {
  emailId: "E001",
  receivedAt: new Date("2026-11-02T07:02:00-05:00"),
  fromName: "Maria Lopez",
  fromEmail: "maria@bluefinbistro.example",
  subject: "Order for this week",
  body: "Hi Harbor Point team,\n\nPlease send the following to Pier Street:\n\nHPS-1408  x 4",
  status: "not_run",
};

const jenna: InboxEmailWithBody = {
  emailId: "E005",
  receivedAt: new Date("2026-11-02T07:26:00-05:00"),
  fromName: "Jenna Brooks",
  fromEmail: "ops@metrofitness.example",
  subject: "Orders for 3 clubs",
  body: "Hi there,\n\nOrders for this week, please deliver to each club separately.",
  status: "not_run",
};

function listed(email: InboxEmailWithBody): InboxEmail {
  const { emailId, receivedAt, fromName, fromEmail, subject, status } = email;
  return { emailId, receivedAt, fromName, fromEmail, subject, status };
}

type DeskOverrides = Partial<Omit<InboxDeskProps, "query">> & { query?: Partial<InboxQuery> };

function renderDesk(overrides: DeskOverrides = {}): string {
  const query: InboxQuery = { filter: "all", emailId: null, view: "list", ...overrides.query };
  const emails = overrides.emails ?? [listed(maria), listed(jenna)];
  return renderToStaticMarkup(
    <InboxDesk
      emails={emails}
      counts={countByFilter(emails)}
      shown={overrides.shown ?? emails.filter((email) => isInFilter(email, query.filter))}
      selected={overrides.selected ?? null}
      tipDismissed={overrides.tipDismissed ?? false}
      query={query}
    />,
  );
}

function count(html: string, pattern: RegExp): number {
  return html.match(new RegExp(pattern, "g"))?.length ?? 0;
}

describe("InboxDesk, the empty state", () => {
  it("says when a filter shows nothing, and that no email is chosen yet", () => {
    const html = renderDesk({ query: { filter: "needs-you" }, shown: [] });

    expect(html).toContain("Nothing here right now.");
    expect(html).not.toContain('value="E001"');
    expect(html).toContain("No email chosen");
    expect(html).toContain("Nothing to decide yet");
  });

  it("greets an empty day without dividing by zero", () => {
    const html = renderDesk({ emails: [], shown: [] });

    expect(html).toContain("No emails have come in today.");
    expect(html).toContain('style="width:0%"');
    expect(html).toContain("0 of 0 handled");
  });
});

describe("InboxDesk, the list", () => {
  it("shows each email as one button: initials, sender, time, subject and a status in words", () => {
    const html = renderDesk();

    expect(count(html, /<button type="submit" value="E\d{3}" class="row"[^>]*name="email">/)).toBe(2);
    expect(html).toMatch(
      /<button type="submit" value="E005" class="row" name="email"><span class="av av--\d" aria-hidden="true">JB<\/span>/,
    );
    expect(html).toContain('<span class="row-from">Jenna Brooks</span>');
    expect(html).toMatch(/<time[^>]*>07:26<\/time>/);
    expect(html).toContain('<span class="row-subject">Orders for 3 clubs</span>');
    expect(html).toContain('<span class="pill pill--not_run"><span aria-hidden="true">○</span>Not run yet</span>');
    expect(html.indexOf("E001")).toBeLessThan(html.indexOf("E005"));
  });

  it("opens an email in the detail view, keeping the filter in the URL", () => {
    const html = renderDesk({ query: { filter: "other" } });

    expect(html).toMatch(/<form action="\/"[^>]*><input type="hidden" name="filter" value="other"\/>/);
    expect(html).toContain('<input type="hidden" name="view" value="detail"/>');
  });

  it("offers All, Needs you, Done and Other with their counts, the chosen one pressed", () => {
    const html = renderDesk({ query: { filter: "other" } });

    const filter = (value: string, pressed: boolean, words: string, shown: number) =>
      `<button type="submit" value="${value}" class="filter" aria-pressed="${pressed}" name="filter">${words}<span class="filter-count">${shown}</span></button>`;

    expect(html).toContain(filter("all", false, "All", 2));
    expect(html).toContain(filter("needs-you", false, "Needs you", 0));
    expect(html).toContain(filter("done", false, "Done", 0));
    expect(html).toContain(filter("other", true, "Other", 2));
  });

  it("greets with Good morning, the day's count in words and the progress bar, in the screen's one h1", () => {
    const html = renderDesk();

    expect(count(html, /<h1[ >]/)).toBe(1);
    expect(html).toContain('<h1 class="greeting">Good morning</h1>');
    expect(html).toContain("2 emails came in today. The agent hasn’t read any of them yet.");
    expect(html).toMatch(/role="progressbar" aria-label="Emails handled" aria-valuemin="0" aria-valuemax="2" aria-valuenow="0"/);
    expect(html).toContain("0 of 2 handled");
  });

  it("shows the tip card until this person dismisses it", () => {
    expect(renderDesk({ tipDismissed: false })).toContain("How this works:");
    expect(renderDesk({ tipDismissed: true })).not.toContain("How this works:");
  });
});

describe("InboxDesk, the selected state", () => {
  it("marks the selected row and shows its subject, sender, time and body", () => {
    const html = renderDesk({ query: { emailId: "E005", view: "detail" }, selected: jenna });

    expect(count(html, /aria-current="true"/)).toBe(1);
    expect(html).toContain('value="E005" class="row" aria-current="true" name="email"');
    expect(html).toContain('<h2 class="title">Orders for 3 clubs</h2>');
    expect(html).toContain("Jenna Brooks &lt;ops@metrofitness.example&gt;");
    expect(html).toMatch(/<time[^>]*>Mon 2 Nov 07:26<\/time>/);
    expect(html).toContain(
      '<pre class="email-body reading">Hi there,\n\nOrders for this week, please deliver to each club separately.</pre>',
    );
    expect(html).toContain('data-view="detail"');
  });

  it("goes back to the list on a phone, keeping the filter and the selection", () => {
    const html = renderDesk({ query: { filter: "other", emailId: "E005", view: "detail" }, selected: jenna });

    expect(html).toMatch(/<a class="btn btn--ghost" href="\/\?filter=other&amp;email=E005">← All emails<\/a>/);
  });

  it("keeps the selection when the filter changes", () => {
    const html = renderDesk({ query: { emailId: "E005" }, selected: jenna });

    expect(html).toMatch(/aria-label="Show"[^>]*><input type="hidden" name="email" value="E005"\/>/);
  });

  it("shows the Proposal pane's empty state: no agent has run on this email", () => {
    const html = renderDesk({ query: { emailId: "E005" }, selected: jenna });

    expect(html).toContain("The agent hasn’t read this email yet.");
  });

  it("renders a body, subject and sender name containing markup as text, never as HTML", () => {
    const hostile: InboxEmailWithBody = {
      ...jenna,
      fromName: '<img src=x onerror="alert(1)">',
      subject: "<b>Urgent</b>",
      body: 'Please ship.\n<script>alert("pwned")</script>\nThanks',
    };

    const html = renderDesk({ emails: [listed(hostile)], query: { emailId: "E005" }, selected: hostile });

    expect(html).toContain(
      '<pre class="email-body reading">Please ship.\n&lt;script&gt;alert(&quot;pwned&quot;)&lt;/script&gt;\nThanks</pre>',
    );
    expect(html).not.toContain('<script>alert("pwned")</script>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>Urgent</b>");
    expect(html).toContain('<h2 class="title">&lt;b&gt;Urgent&lt;/b&gt;</h2>');
  });
});
