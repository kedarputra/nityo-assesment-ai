import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InboxRunProvider } from "./inbox-run";
import { SiteHeader, SkipLink } from "./site-header";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/server/inbox/actions", () => ({}));

describe("SiteHeader", () => {
  it("shows the wordmark: Harbor Point, then Order desk", () => {
    const html = renderToStaticMarkup(<SiteHeader user={null} />);

    expect(html).toContain("<header");
    expect(html).toMatch(/Harbor Point\s*<span>Order desk<\/span>/);
  });

  it("offers no sign-out to someone who is not signed in", () => {
    const html = renderToStaticMarkup(<SiteHeader user={null} />);

    expect(html).not.toContain("Sign out");
    expect(html).not.toContain("Audit log");
  });

  it("links the signed-in person to the inbox and the audit log", () => {
    const html = renderToStaticMarkup(<SiteHeader user={{ id: 1, username: "ops.reviewer", role: "reviewer" }} />);

    expect(html).toContain('<a aria-current="page" href="/">Inbox</a><a href="/audit">Audit log</a>');
  });

  it("names the signed-in person and offers a sign-out button", () => {
    const html = renderToStaticMarkup(<SiteHeader user={{ id: 1, username: "ops.reviewer", role: "reviewer" }} />);

    expect(html).toContain("ops.reviewer");
    expect(html).toMatch(/<form[^>]*>.*<button type="submit"[^>]*>Sign out<\/button><\/form>/);
  });
});

describe("SiteHeader, the account menu", () => {
  function renderFor(role: "reviewer" | "admin", runGoing = false): string {
    return renderToStaticMarkup(
      <InboxRunProvider>
        <SiteHeader user={{ id: 1, username: `ops.${role}`, role }} runGoing={runGoing} />
      </InboxRunProvider>,
    );
  }

  it("offers an admin Run all and Reset to 07:00, in the menu under their name", () => {
    const html = renderFor("admin");

    expect(html).toMatch(/<details class="account"><summary[^>]*>ops.admin<\/summary>/);
    expect(html).toContain(">Run all</button>");
    expect(html).toContain(">Reset to 07:00…</button>");
  });

  it("offers an admin Stop while a run holds the lock", () => {
    const html = renderFor("admin", true);

    expect(html).toContain(">Stop the run</button>");
    expect(html).not.toContain(">Run all</button>");
  });

  it("offers a reviewer neither", () => {
    const html = renderFor("reviewer");

    expect(html).not.toContain("Run all");
    expect(html).not.toContain("Reset to 07:00");
    expect(html).toContain("Sign out");
  });
});

describe("SkipLink", () => {
  it("jumps to the main content", () => {
    const html = renderToStaticMarkup(<SkipLink />);

    expect(html).toBe('<a class="skip" href="#main">Skip to content</a>');
  });
});
