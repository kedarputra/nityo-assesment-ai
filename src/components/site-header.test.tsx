import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SiteHeader, SkipLink } from "./site-header";

describe("SiteHeader", () => {
  it("shows the wordmark: Harbor Point, then Order desk", () => {
    const html = renderToStaticMarkup(<SiteHeader user={null} />);

    expect(html).toContain("<header");
    expect(html).toMatch(/Harbor Point\s*<span>Order desk<\/span>/);
  });

  it("offers no sign-out to someone who is not signed in", () => {
    const html = renderToStaticMarkup(<SiteHeader user={null} />);

    expect(html).not.toContain("Sign out");
  });

  it("names the signed-in person and offers a sign-out button", () => {
    const html = renderToStaticMarkup(<SiteHeader user={{ id: 1, username: "ops.reviewer", role: "reviewer" }} />);

    expect(html).toContain("ops.reviewer");
    expect(html).toMatch(/<form[^>]*>.*<button type="submit"[^>]*>Sign out<\/button><\/form>/);
  });
});

describe("SkipLink", () => {
  it("jumps to the main content", () => {
    const html = renderToStaticMarkup(<SkipLink />);

    expect(html).toBe('<a class="skip" href="#main">Skip to content</a>');
  });
});
