import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import { proxy } from "./proxy";

function request(path: string, init: { method?: string; origin?: string } = {}): NextRequest {
  const headers = new Headers({ host: "desk.example" });
  if (init.origin) headers.set("origin", init.origin);
  return new NextRequest(`https://desk.example${path}`, { method: init.method ?? "GET", headers });
}

function expectSecurityHeaders(response: Response): void {
  const policy = response.headers.get("content-security-policy") ?? "";
  expect(policy).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/]+={0,2}' 'strict-dynamic'(;|$)/);
  expect(policy).not.toContain("'unsafe-eval'");
  expect(policy).toContain("frame-ancestors 'none'");
  expect(policy).toContain("object-src 'none'");
  expect(policy).toContain("default-src 'self'");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  expect(response.headers.get("strict-transport-security")).toMatch(/^max-age=\d{8,}; includeSubDomains/);
  expect(response.headers.get("x-frame-options")).toBe("DENY");
}

// The proxy fronts every route but the static assets; none of these requests reaches the
// database, so they need no DATABASE_URL.
describe("the security headers (security 4)", () => {
  it("are on a public page the proxy lets through", async () => {
    const response = await proxy(request("/sign-in"));

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expectSecurityHeaders(response);
  });

  it("are on the redirect to sign in", async () => {
    const response = await proxy(request("/audit"));

    expect(response.status).toBe(307);
    expectSecurityHeaders(response);
  });

  it("are on a refusal: a 401 to an API call and a 403 to another site's POST", async () => {
    expectSecurityHeaders(await proxy(request("/api/emails")));
    const forged = await proxy(request("/", { method: "POST", origin: "https://evil.example" }));
    expect(forged.status).toBe(403);
    expectSecurityHeaders(forged);
  });

  it("hand the page's render the same CSP, so Next.js puts the nonce on its scripts", async () => {
    const response = await proxy(request("/sign-in"));

    expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(
      response.headers.get("content-security-policy"),
    );
  });

  it("use a fresh nonce on every request", async () => {
    const first = (await proxy(request("/sign-in"))).headers.get("content-security-policy");
    const second = (await proxy(request("/sign-in"))).headers.get("content-security-policy");

    expect(first).not.toBe(second);
  });

  it("are set by next.config on every path, so the static assets the proxy skips carry them too", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];

    const everyPath = rules.find((rule) => rule.source === "/:path*");
    const headers = new Headers(everyPath?.headers.map(({ key, value }) => [key, value]));
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("strict-transport-security")).toMatch(/^max-age=\d{8,}/);
    expect(headers.get("x-frame-options")).toBe("DENY");
  });
});
