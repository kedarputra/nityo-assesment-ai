import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SiteHeader, SkipLink } from "./site-header";

describe("SiteHeader", () => {
  it("shows the wordmark: Harbor Point, then Order desk", () => {
    const html = renderToStaticMarkup(<SiteHeader />);

    expect(html).toContain("<header");
    expect(html).toMatch(/Harbor Point\s*<span>Order desk<\/span>/);
  });
});

describe("SkipLink", () => {
  it("jumps to the main content", () => {
    const html = renderToStaticMarkup(<SkipLink />);

    expect(html).toBe('<a class="skip" href="#main">Skip to content</a>');
  });
});
