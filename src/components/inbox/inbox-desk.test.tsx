import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EmailWork } from "@/server/inbox/email-work";
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
      work={overrides.work ?? null}
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

  it("shows the Proposal pane's empty state: no agent has run on this email, and offers to run it", () => {
    const html = renderDesk({ query: { emailId: "E005" }, selected: jenna });

    expect(html).toContain("The agent hasn’t read this email yet.");
    // A secondary button, not the view's one primary (DESIGN.md, "Buttons").
    expect(html).toContain('<button type="button" class="btn" aria-busy="false">Run the agent</button>');
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

const allChecksPass = [
  "known-contact",
  "skus-sellable",
  "system-price",
  "full-stock",
  "credit-hold",
  "credit-limit",
  "ship-to",
  "no-flags",
].map((check) => ({ check, passes: true, detail: `${check} is fine.` }));

// E001 as the agent leaves it: released as SO-24059 with a confirmation Draft reply.
const e001Released: EmailWork = {
  run: { runId: "run-1", finished: true, outcome: "released", errorClass: null, requestKinds: ["new order"] },
  proposals: [
    {
      id: 1,
      status: "released",
      soNumber: "SO-24059",
      customerName: "Bluefin Bistro Group",
      shipToId: "S001",
      shipToName: "Bluefin Bistro - Pier Street",
      requestedDate: "2026-11-05",
      totalCents: 67200,
      checks: allChecksPass,
      lines: [
        {
          lineNo: 1,
          sku: "HPS-1408",
          productName: "Wooden Cutlery Kit (fork, knife, napkin)",
          quantity: 4,
          unitPriceCents: 4500,
          priceSource: "list",
          lineTotalCents: 18000,
        },
      ],
    },
  ],
  routed: [],
  noAction: null,
  flags: [],
  draftReply: "Hi Maria, SO-24059 is confirmed for Thursday.",
  notes: [],
};

describe("InboxDesk, the Proposal pane after a run", () => {
  const released: InboxEmailWithBody = { ...maria, status: "released" };

  it("shows a released order's headline, its checks folded as good, its lines and the confirmation reply", () => {
    const html = renderDesk({
      emails: [listed(released), listed(jenna)],
      query: { emailId: "E001" },
      selected: released,
      work: e001Released,
    });

    expect(html).toContain('<span class="pill pill--released"><span aria-hidden="true">✓</span>Done by the agent</span>');
    expect(html).toContain('<h2 class="headline">Released SO-24059: $672.00 for Bluefin Bistro Group</h2>');
    expect(html).toContain("Bluefin Bistro - Pier Street · wanted Thu 5 Nov");
    expect(html).toContain("<summary>8 checks look good</summary>");
    expect(html).not.toContain("Why it’s waiting for you");
    expect(html).toContain('<span class="id">HPS-1408</span>');
    expect(html).toContain("$180.00");
    expect(html).toContain(
      '<textarea id="draft-reply" class="reading" readOnly="" rows="8">Hi Maria, SO-24059 is confirmed for Thursday.</textarea>',
    );
    expect(html).toContain("We never send email from here; this is what would go out.");
    expect(html).toContain("1 of 2 handled");
  });

  it("lists only the failing checks under why it’s waiting, with the rest folded", () => {
    const [proposal] = e001Released.proposals;
    if (!proposal) throw new Error("no proposal");
    const review: EmailWork = {
      ...e001Released,
      run: { ...e001Released.run, outcome: "proposal" },
      proposals: [
        {
          ...proposal,
          status: "open",
          soNumber: null,
          checks: allChecksPass.map((check) =>
            check.check === "system-price" ? { ...check, passes: false, detail: "HPS-1408 stated $30.00, system $45.00." } : check,
          ),
        },
      ],
    };
    const waiting: InboxEmailWithBody = { ...maria, status: "needs_you" };

    const html = renderDesk({ query: { emailId: "E001" }, selected: waiting, work: review });

    expect(html).toContain('<h2 class="headline">New order for Bluefin Bistro Group, $672.00, waiting for you</h2>');
    expect(html).toContain("Why it’s waiting for you");
    expect(html).toContain("<b>System prices.</b> HPS-1408 stated $30.00, system $45.00.");
    expect(html).toContain("<summary>7 checks look good</summary>");
  });

  it("says calmly when a run did not finish", () => {
    const failed: InboxEmailWithBody = { ...maria, status: "failed" };
    const work: EmailWork = {
      run: { runId: "run-1", finished: true, outcome: "failed", errorClass: "call-cap", requestKinds: [] },
      proposals: [],
      routed: [],
      noAction: null,
      flags: [],
      draftReply: null,
      notes: [],
    };

    const html = renderDesk({ query: { emailId: "E001" }, selected: failed, work });

    expect(html).toContain("The agent didn’t finish this email");
    expect(html).toContain("call-cap");
  });

  it("shows Reading… while a run is under way", () => {
    const reading: InboxEmailWithBody = { ...maria, status: "reading" };
    const work: EmailWork = {
      run: { runId: "run-1", finished: false, outcome: null, errorClass: null, requestKinds: [] },
      proposals: [],
      routed: [],
      noAction: null,
      flags: [],
      draftReply: null,
      notes: [],
    };

    const html = renderDesk({ emails: [listed(reading)], query: { emailId: "E001" }, selected: reading, work });

    expect(html).toContain('<span class="pill pill--reading"><span aria-hidden="true">…</span>Reading…</span>');
    expect(html).toContain("The agent is reading this email");
  });
});

describe("InboxDesk, routed and no-action emails", () => {
  const ben: InboxEmailWithBody = {
    emailId: "E009",
    receivedAt: new Date("2026-11-02T07:52:00-05:00"),
    fromName: "Ben Carter",
    fromEmail: "taproom@lakesidebrew.example",
    subject: "Quote please",
    body: "Can you quote me 20 cs of the 16 oz clear cups? Not ordering yet.",
    status: "needs_you",
  };
  const grace: InboxEmailWithBody = {
    emailId: "E016",
    receivedAt: new Date("2026-11-02T09:22:00-05:00"),
    fromName: "Grace Kim",
    fromEmail: "purchasing@seasideseniorliving.example",
    subject: "FW: PO SSL-7781",
    body: "Resending in case the first one didn't come through.",
    status: "no_action",
  };
  const nothingElse = { proposals: [], routed: [], noAction: null, flags: [], draftReply: null, notes: [] };

  it("shows a routed Request as Needs you, with its kind, summary and Draft reply, and no lines or gate", () => {
    const work: EmailWork = {
      ...nothingElse,
      run: { runId: "run-9", finished: true, outcome: "routed", errorClass: null, requestKinds: ["quote request"] },
      routed: [{ kind: "quote request", reason: "quote", summary: "Ben wants a quote: $1,980.00 at list." }],
      draftReply: "Hi Ben, here is your quote.",
    };

    const html = renderDesk({ emails: [listed(ben)], query: { emailId: "E009" }, selected: ben, work });

    expect(html).toContain('<span class="pill pill--needs_you"><span aria-hidden="true">!</span>Needs you</span>');
    expect(html).toContain('<li class="tag">Quote request</li>');
    expect(html).toContain('<h2 class="headline">A quote request for you to answer</h2>');
    expect(html).toContain("Ben wants a quote: $1,980.00 at list.");
    expect(html).toContain("Hi Ben, here is your quote.</textarea>");
    expect(html).not.toContain('class="lines"');
    expect(html).not.toContain("Why it’s waiting for you");
    expect(html).not.toContain("look good");
  });

  it("shows a duplicate as No action needed, with its reason and a link to the original email", () => {
    const work: EmailWork = {
      ...nothingElse,
      run: { runId: "run-16", finished: true, outcome: "no_action", errorClass: null, requestKinds: ["no action"] },
      noAction: { reason: "duplicate", note: "A resend of PO SSL-7781.", duplicateOf: "E015" },
    };

    const html = renderDesk({ emails: [listed(grace)], query: { emailId: "E016" }, selected: grace, work });

    expect(html).toContain('<span class="pill pill--no_action"><span aria-hidden="true">–</span>No action needed</span>');
    expect(html).toContain('<li class="tag">No action</li>');
    expect(html).toContain("It repeats an email whose order is already in.");
    expect(html).toContain('Same as <a href="/?filter=all&amp;email=E015">E015</a>.');
    expect(html).toContain("A resend of PO SSL-7781.");
    expect(html).not.toContain('id="draft-reply"');
  });

  it("shows both of E027’s Requests and the notes other emails left", () => {
    const [proposal] = e001Released.proposals;
    if (!proposal) throw new Error("no proposal");
    const work: EmailWork = {
      ...e001Released,
      run: { ...e001Released.run, outcome: "proposal", requestKinds: ["new order", "order inquiry"] },
      proposals: [{ ...proposal, status: "open", soNumber: null }],
      routed: [{ kind: "order inquiry", reason: "inquiry", summary: "No order on file for C014." }],
      notes: [{ sourceEmailId: "E028", note: "Away until 9 November." }],
    };
    const waiting: InboxEmailWithBody = { ...maria, status: "needs_you" };

    const html = renderDesk({ query: { emailId: "E001" }, selected: waiting, work });

    expect(html).toContain('<li class="tag">New order</li><li class="tag">Order inquiry</li>');
    expect(html).toContain('<h2 class="headline">A question about an earlier order</h2>');
    expect(html).toContain('class="lines"');
    expect(html).toContain('<a href="/?filter=all&amp;email=E028">E028</a> Away until 9 November.');
  });
});
