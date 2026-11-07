import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { EmailWork, ProposalView } from "@/server/inbox/email-work";
import type { InboxEmail, InboxEmailWithBody, InboxQuery } from "@/server/inbox/inbox";
import { countByFilter, isInFilter } from "@/server/inbox/inbox";
import { InboxDesk, type InboxDeskProps } from "./inbox-desk";

// The desk moves between emails through the app router, which a static render does not mount.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

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
      agentOn={overrides.agentOn ?? true}
      notFound={overrides.notFound ?? false}
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
  it("shows each email as one link: initials, sender, time, subject and a status in words", () => {
    const html = renderDesk();

    expect(count(html, /<a class="row"[^>]*href="\/\?filter=all&amp;email=E\d{3}&amp;view=detail">/)).toBe(2);
    expect(html).toMatch(
      /<a class="row" href="\/\?filter=all&amp;email=E005&amp;view=detail"><span class="av av--\d" aria-hidden="true">JB<\/span>/,
    );
    expect(html).toContain('<span class="row-from">Jenna Brooks</span>');
    expect(html).toMatch(/<time[^>]*>07:26<\/time>/);
    expect(html).toContain('<span class="row-subject">Orders for 3 clubs</span>');
    expect(html).toContain('<span class="pill pill--not_run"><span aria-hidden="true">○</span>Not run yet</span>');
    expect(html.indexOf("E001")).toBeLessThan(html.indexOf("E005"));
  });

  it("opens an email in the detail view, keeping the filter in the URL", () => {
    const html = renderDesk({ query: { filter: "other" } });

    // Each row's own link carries its email id: a shared form lost the clicked row (next/form).
    expect(html).toContain('href="/?filter=other&amp;email=E001&amp;view=detail"');
    expect(html).toContain('href="/?filter=other&amp;email=E005&amp;view=detail"');
  });

  it("offers All, Needs you, Done and Other with their counts, the chosen one pressed", () => {
    const html = renderDesk({ query: { filter: "other" } });

    const filter = (value: string, current: boolean, words: string, shown: number) =>
      `<a class="filter"${current ? ' aria-current="true"' : ""} href="/?filter=${value}">${words}<span class="filter-count">${shown}</span></a>`;

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

  it("says so when the URL asks for an email that is not in today's inbox", () => {
    expect(renderDesk({ notFound: true })).toContain("That email isn’t in today’s inbox");
    expect(renderDesk()).toContain("No email chosen");
  });

  it("says in the greeting that the emails are the reader's own when the agent is switched off", () => {
    expect(renderDesk({ agentOn: false })).toContain("2 emails came in today. The agent is switched off, so they’re yours to read.");
  });

  it("shows the tip card until this person dismisses it", () => {
    expect(renderDesk({ tipDismissed: false })).toContain("How this works:");
    expect(renderDesk({ tipDismissed: true })).not.toContain("How this works:");
  });
});

describe("InboxDesk, the selected state", () => {
  it("marks the selected row and shows its subject, sender, time and body", () => {
    const html = renderDesk({ query: { emailId: "E005", view: "detail" }, selected: jenna });

    expect(count(html, /class="row" aria-current="true"/)).toBe(1);
    expect(html).toMatch(/<a class="row" aria-current="true" href="[^"]*email=E005[^"]*">/);
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

    expect(html).toContain('<a class="filter" href="/?filter=needs-you&amp;email=E005">');
  });

  it("shows the Proposal pane's empty state: no agent has run on this email, and offers to run it", () => {
    const html = renderDesk({ query: { emailId: "E005" }, selected: jenna });

    expect(html).toContain("The agent hasn’t read this email yet.");
    // A secondary button, not the view's one primary (DESIGN.md, "Buttons").
    expect(html).toContain('<button type="button" class="btn" aria-busy="false">Run the agent</button>');
  });

  it("says the agent is switched off, and offers no run, when the deploy has no Anthropic key", () => {
    const html = renderDesk({ query: { emailId: "E005" }, selected: jenna, agentOn: false });

    expect(html).toContain("Nothing to decide yet");
    expect(html).toContain("The agent is switched off on this desk for now");
    expect(html).not.toContain("Run the agent");
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
      kind: "new order",
      status: "released",
      soNumber: "SO-24059",
      targetSoNumber: null,
      customerName: "Bluefin Bistro Group",
      shipToId: "S001",
      shipToName: "Bluefin Bistro - Pier Street",
      requestedDate: "2026-11-05",
      requestedDateWords: "Thursday",
      requestedDateAlternative: null,
      totalCents: 67200,
      checks: allChecksPass,
      lines: [
        {
          lineNo: 1,
          sku: "HPS-1408",
          productName: "Wooden Cutlery Kit (fork, knife, napkin)",
          pack: "250 kits",
          swappedFor: null,
          quantity: 4,
          unitPriceCents: 4500,
          priceSource: "list",
          lineTotalCents: 18000,
          customerWords: "HPS-1408  x 4",
          available: 26,
          orderLineNo: null,
          before: null,
          after: null,
        },
      ],
      decision: null,
      shipToChoices: [{ shipToId: "S001", name: "Bluefin Bistro - Pier Street" }],
      linked: [],
    },
  ],
  routed: [],
  noAction: null,
  flags: [],
  draftReply: { body: "Hi Maria, SO-24059 is confirmed for Thursday.", readyBy: null, readyAt: null },
  notes: [],
  context: [],
  related: [],
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
    expect(html).toMatch(/<textarea id="draft-reply" class="reading"[^>]*>Hi Maria, SO-24059 is confirmed for Thursday.<\/textarea>/);
    expect(html).not.toMatch(/<textarea[^>]*readOnly/);
    expect(html).toContain("Mark reply ready");
    expect(html).toContain("We never send email from here; this is what would go out.");
    // A released order has nothing left to decide.
    expect(html).not.toContain("Approve &amp; release");
    expect(html).not.toContain("Reject…");
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

  it("shows both dates ambiguous words could mean, and what a person can choose for short stock", () => {
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
          requestedDate: "2026-11-03",
          requestedDateWords: "next Tuesday",
          requestedDateAlternative: "2026-11-10",
          checks: [
            {
              check: "full-stock",
              passes: false,
              detail: "Not enough available: HPS-1302 wants 12, 5 available, 40 due Mon 9 Nov (PO-7712).",
              flags: ["P2-short-stock"],
              choices: ["HPS-1302: ship 5 now and the other 7 from Mon 9 Nov", "HPS-1302: backorder all 12 for Mon 9 Nov"],
            },
          ],
        },
      ],
    };
    const waiting: InboxEmailWithBody = { ...maria, status: "needs_you" };

    const html = renderDesk({ query: { emailId: "E001" }, selected: waiting, work: review });

    expect(html).toContain("wanted Tue 3 Nov or Tue 10 Nov (“next Tuesday”)");
    expect(html).toContain(
      "Choices: HPS-1302: ship 5 now and the other 7 from Mon 9 Nov; HPS-1302: backorder all 12 for Mon 9 Nov.",
    );
  });

  it("shows a swapped line with the discontinued product it replaces, and both packs and prices", () => {
    // E019: HPS-1001 nitrile in place of discontinued HPS-1004 vinyl, at $68.00 instead of $45.00.
    const swap: EmailWork = {
      ...e001Released,
      run: { ...e001Released.run, outcome: "proposal" },
      proposals: [
        {
          id: 1,
          kind: "new order",
          status: "open",
          soNumber: null,
          targetSoNumber: null,
          customerName: "Northside Community Center",
          shipToId: "S018",
          shipToName: "Northside Community Center",
          requestedDate: "2026-11-03",
          requestedDateWords: null,
          requestedDateAlternative: null,
          totalCents: 27200,
          checks: allChecksPass,
          lines: [
            {
              lineNo: 1,
              sku: "HPS-1001",
              productName: "Nitrile Gloves, Blue, Medium",
              pack: "10 boxes x 100 gloves",
              swappedFor: { sku: "HPS-1004", name: "Vinyl Gloves, Clear, Medium", pack: "10 boxes x 100 gloves", listPriceCents: 4500 },
              quantity: 4,
              unitPriceCents: 6800,
              priceSource: "list",
              lineTotalCents: 27200,
              customerWords: null,
              available: 40,
              orderLineNo: null,
              before: null,
              after: null,
            },
          ],
          decision: null,
          shipToChoices: [{ shipToId: "S018", name: "Northside Community Center" }],
          linked: [],
        },
      ],
    };
    const waiting: InboxEmailWithBody = { ...maria, emailId: "E019", status: "needs_you" };

    const html = renderDesk({ query: { emailId: "E019" }, selected: waiting, work: swap });

    expect(html).toContain(
      '<p class="sub">Swapped in for <span class="id">HPS-1004</span> Vinyl Gloves, Clear, Medium, which is discontinued: was 10 boxes x 100 gloves at $45.00, now 10 boxes x 100 gloves at $68.00.</p>',
    );
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
      context: [],
      related: [],
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
      context: [],
      related: [],
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
  const nothingElse = { proposals: [], routed: [], noAction: null, flags: [], draftReply: null, notes: [], context: [], related: [] };

  it("shows a routed Request as Needs you, with its kind, summary and Draft reply, and no lines or gate", () => {
    const work: EmailWork = {
      ...nothingElse,
      run: { runId: "run-9", finished: true, outcome: "routed", errorClass: null, requestKinds: ["quote request"] },
      routed: [{ kind: "quote request", reason: "quote", summary: "Ben wants a quote: $1,980.00 at list." }],
      draftReply: { body: "Hi Ben, here is your quote.", readyBy: null, readyAt: null },
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

  it("shows the emails this one is linked with and what the agent noted for its reviewer", () => {
    const [proposal] = e001Released.proposals;
    if (!proposal) throw new Error("no proposal");
    const work: EmailWork = {
      ...e001Released,
      run: { ...e001Released.run, outcome: "proposal" },
      proposals: [{ ...proposal, status: "open", soNumber: null }],
      related: [{ emailId: "E023", why: "Possibly PO HV-3405, which E023 said was attached." }],
      context: ["Mentions a PO being cancelled but names none."],
    };
    const waiting: InboxEmailWithBody = { ...maria, status: "needs_you" };

    const html = renderDesk({ query: { emailId: "E001" }, selected: waiting, work });

    expect(html).toContain(
      'Related: <a href="/?filter=all&amp;email=E023">E023</a> Possibly PO HV-3405, which E023 said was attached.',
    );
    expect(html).toContain("What the agent noted");
    expect(html).toContain("Mentions a PO being cancelled but names none.");
  });
});

describe("InboxDesk, reviewing a Proposal", () => {
  const released = e001Released.proposals[0];
  if (released === undefined) throw new Error("no proposal");
  const base: ProposalView = released;
  const waiting: InboxEmailWithBody = { ...maria, status: "needs_you" };

  function withProposal(proposal: Partial<EmailWork["proposals"][number]>, work: Partial<EmailWork> = {}): string {
    const review: EmailWork = {
      ...e001Released,
      run: { ...e001Released.run, outcome: "proposal" },
      proposals: [{ ...base, status: "open", soNumber: null, ...proposal }],
      ...work,
    };
    return renderDesk({ query: { emailId: "E001" }, selected: waiting, work: review });
  }

  const failing = (names: string[]) =>
    allChecksPass.map((check) => (names.includes(check.check) ? { ...check, passes: false, detail: `${check.check} fails.` } : check));

  it("asks for a note on each soft check and offers Approve & release, Put on hold… and Reject…", () => {
    const html = withProposal({ checks: failing(["no-flags"]) });

    expect(html).toContain('placeholder="Add a quick note about why it’s OK…"');
    expect(html).toContain("Approve &amp; release");
    expect(html).toContain("Put on hold…");
    expect(html).toContain("Reject…");
    expect(html).toContain('<kbd class="desk-only">a</kbd>');
    expect(html).toContain("Approving keeps your note in the audit log.");
  });

  it("offers only Put on hold… and Reject… on a hard rule, with a lock instead of a note", () => {
    const html = withProposal({ checks: failing(["credit-hold", "credit-limit"]) });

    expect(html).not.toContain("Approve &amp; release");
    expect(html).toContain("Put on hold…");
    expect(html).toContain("Reject…");
    expect(html).toContain("Can’t be overridden. Accounts needs to clear this first.");
    expect(html).not.toContain("Add a quick note about why it’s OK…");
    expect(html).toContain("Bluefin Bistro Group can’t get this order yet ($672.00)");
  });

  it("lets quantities, products, lines and the ship-to change, but never the price", () => {
    const html = withProposal({
      checks: failing(["no-flags"]),
      shipToChoices: [
        { shipToId: "S001", name: "Bluefin Bistro - Pier Street" },
        { shipToId: "S002", name: "Bluefin Bistro - Harbor Ave" },
      ],
    });

    expect(html).toMatch(/<input[^>]*type="number"[^>]*aria-label="Quantity of HPS-1408"[^>]*value="4"/);
    expect(html).toContain("Change product");
    expect(html).toContain("+ Add a line");
    expect(html).toMatch(/<select id="ship-to-1"/);
    expect(html).not.toMatch(/aria-label="Price/);
  });

  it("shows who decided and why once a Proposal is on hold, and still offers the decision", () => {
    const html = withProposal({
      status: "held",
      checks: failing(["credit-hold"]),
      decision: { by: "ops.reviewer", at: new Date("2026-11-02T15:00:00Z"), reason: "Waiting for accounts." },
    });

    expect(html).toContain("On hold");
    expect(html).toContain("by ops.reviewer");
    expect(html).toContain("“Waiting for accounts.”");
    expect(html).not.toContain("Put on hold…");
    expect(html).toContain("Reject…");
  });

  it("locks a reply marked ready and says who marked it", () => {
    const html = withProposal(
      { status: "rejected", decision: { by: "ops.reviewer", at: new Date(), reason: "Customer cancelled." } },
      { draftReply: { body: "Sorry, Maria.", readyBy: "ops.reviewer", readyAt: new Date() } },
    );

    expect(html).toMatch(/<textarea id="draft-reply"[^>]*readOnly=""/);
    expect(html).toContain("Reply ready");
    expect(html).not.toContain("Mark reply ready");
    expect(html).toContain("The order from Bluefin Bistro Group was rejected");
    expect(html).not.toContain("Reject…");
  });

  // E004: SO-24051's tissue 20 → 25 cases at the order's $66.00 and 5 cases of foam soap added.
  const e004Lines = (base.lines[0] ? [base.lines[0]] : []).flatMap((line) => [
    {
      ...line,
      lineNo: 1,
      sku: "HPS-1103",
      productName: "Toilet Tissue, Standard Roll",
      quantity: 5,
      unitPriceCents: 6600,
      priceSource: null,
      lineTotalCents: 33000,
      customerWords: null,
      orderLineNo: 1,
      before: 20,
      after: 25,
    },
    {
      ...line,
      lineNo: 2,
      sku: "HPS-1304",
      productName: "Foam Hand Soap Refill",
      quantity: 5,
      unitPriceCents: 4900,
      lineTotalCents: 24500,
      customerWords: null,
      orderLineNo: null,
      before: 0,
      after: 5,
    },
  ]);

  it("shows an order change as before → after, with Approve change and no line editing", () => {
    const html = withProposal({
      kind: "order change",
      targetSoNumber: "SO-24051",
      customerName: "Harborview Hotel",
      totalCents: 57500,
      lines: e004Lines,
    });

    expect(html).toContain('<h2 class="headline">Change SO-24051 for Harborview Hotel, +$575.00, waiting for you</h2>');
    expect(html).toContain("20 → 25");
    expect(html).toContain("0 → 5");
    expect(html).toContain("+$330.00");
    expect(html).toContain("Change in order value");
    expect(html).toContain("Approve change");
    expect(html).not.toContain("+ Add a line");
    expect(html).not.toContain("Change product");
  });

  it("shows a cancellation's value going down, and a SHIPPED order's change as one that can't be made", () => {
    const cancellation = withProposal({ kind: "cancellation", targetSoNumber: "SO-24055", customerName: "Summit Office Park", totalCents: -150000 });
    expect(cancellation).toContain("Cancel SO-24055 for Summit Office Park, −$1,500.00, waiting for you");
    expect(cancellation).toContain("Approve cancellation");

    const shipped = withProposal({
      kind: "order change",
      targetSoNumber: "SO-24040",
      totalCents: 6600,
      checks: [{ check: "edit-rights", passes: false, detail: "SO-24040 has shipped and cannot be edited." }],
    });
    expect(shipped).toContain("SO-24040 can’t be changed (+$66.00)");
    expect(shipped).toContain("The order can still change");
    expect(shipped).not.toContain("Approve change");
  });

  it("shows a follow-up beside the pending Proposal it adds to (U2)", () => {
    const html = withProposal({
      linked: [{ relation: "follows", proposalId: 7, emailId: "E010", status: "open", totalCents: 31300 }],
    });

    expect(html).toContain(
      'Adds to the order still waiting from <a href="/?filter=all&amp;email=E010">E010</a>: $313.00, needs you',
    );
  });
});
