import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AuditLog } from "./audit-log";

describe("AuditLog", () => {
  it("has the screen's one h1 and an empty state while nothing has happened", () => {
    const html = renderToStaticMarkup(<AuditLog />);

    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html).toContain('<h1 class="title">Audit log</h1>');
    expect(html).toContain("Nothing has happened yet");
  });
});
