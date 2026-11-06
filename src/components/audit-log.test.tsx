import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AuditEntry } from "@/server/audit/audit-log";
import { AuditLog } from "./audit-log";

const at = new Date("2026-11-02T07:03:00-05:00");

describe("AuditLog", () => {
  it("has the screen's one h1 and an empty state while nothing has happened", () => {
    const html = renderToStaticMarkup(<AuditLog events={[]} />);

    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html).toContain('<h1 class="title">Audit log</h1>');
    expect(html).toContain("Nothing has happened yet");
  });

  it("lists each event: when, who, what, which email and the detail, as text", () => {
    const events: AuditEntry[] = [
      {
        id: 3,
        at,
        actor: "gate",
        username: null,
        action: "order.released",
        emailId: "E001",
        detail: { soNumber: "SO-24059", totalCents: 67200 },
      },
      {
        id: 2,
        at,
        actor: "agent",
        username: null,
        action: "tool.called",
        emailId: "E001",
        detail: { tool: "find_customer", input: { email: "<b>maria@bluefinbistro.example</b>" } },
      },
      { id: 1, at, actor: "agent", username: "ops.reviewer", action: "run.started", emailId: "E001", detail: {} },
    ];

    const html = renderToStaticMarkup(<AuditLog events={events} />);

    expect(html).not.toContain("Nothing has happened yet");
    expect(html).toMatch(/<time[^>]*>Mon 2 Nov 07:03<\/time>/);
    expect(html).toContain("<td>Release gate</td><td>Released SO-24059</td>");
    expect(html).toContain("Order total $672.00");
    expect(html).toContain("<td>Called find_customer</td>");
    expect(html).toContain("&lt;b&gt;maria@bluefinbistro.example&lt;/b&gt;");
    expect(html).toContain("<td>Agent, started by ops.reviewer</td><td>Started reading</td>");
    expect(html.indexOf("SO-24059")).toBeLessThan(html.indexOf("find_customer"));
  });

  it("names a person's decisions: overrides with their note, approvals, rejections with their reason, and undo", () => {
    const person = { at, actor: "person" as const, username: "ops.reviewer", emailId: "E019" };
    const events: AuditEntry[] = [
      { ...person, id: 5, action: "release.undone", detail: { soNumber: "SO-24060" } },
      { ...person, id: 4, action: "proposal.approved", detail: { soNumber: "SO-24060", totalCents: 27200 } },
      { ...person, id: 3, action: "proposal.override", detail: { check: "no-flags", note: "James confirmed nitrile." } },
      { ...person, id: 2, action: "proposal.rejected", detail: { reason: "<i>Cancelled</i> by phone." } },
      { ...person, id: 1, action: "proposal.edited", detail: { edit: { kind: "quantity", lineNo: 1, quantity: 6 } } },
    ];

    const html = renderToStaticMarkup(<AuditLog events={events} />);

    expect(html).toContain("<td>ops.reviewer</td><td>Undid the release of SO-24060</td>");
    expect(html).toContain("<td>Approved and released SO-24060</td>");
    expect(html).toContain("Order total $272.00");
    expect(html).toContain("<td>Overrode “Nothing flagged”</td>");
    expect(html).toContain("James confirmed nitrile.");
    expect(html).toContain("&lt;i&gt;Cancelled&lt;/i&gt; by phone.");
    expect(html).toContain("<td>Edited the Proposal</td>");
  });
});
