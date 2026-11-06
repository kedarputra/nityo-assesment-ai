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
});
