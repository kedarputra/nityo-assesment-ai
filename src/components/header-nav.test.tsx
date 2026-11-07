import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HeaderNav } from "./header-nav";

let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

describe("HeaderNav", () => {
  it("links the inbox and the audit log, marking the page you are on", () => {
    pathname = "/audit";

    const html = renderToStaticMarkup(<HeaderNav />);

    expect(html).toBe(
      '<nav class="tabs" aria-label="Sections"><a href="/">Inbox</a><a aria-current="page" href="/audit">Audit log</a></nav>',
    );
  });
});
