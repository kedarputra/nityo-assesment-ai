import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, gateRequest, safeReturnPath, type FindSessionUser } from "./gate";
import type { SessionUser } from "./sessions";

const reviewer: SessionUser = { id: 1, username: "ops.reviewer", role: "reviewer" };
const VALID_TOKEN = "valid-token";

const findSessionUser: FindSessionUser = async (token) => (token === VALID_TOKEN ? reviewer : null);

function request(
  path: string,
  { method = "GET", token, origin }: { method?: string; token?: string; origin?: string } = {},
): NextRequest {
  const headers = new Headers({ host: "desk.example" });
  if (token) headers.set("cookie", `${SESSION_COOKIE}=${token}`);
  if (origin) headers.set("origin", origin);
  return new NextRequest(`https://desk.example${path}`, { method, headers });
}

function passesThrough(response: Response): boolean {
  return response.headers.get("x-middleware-next") === "1";
}

describe("gateRequest", () => {
  it("lets a signed-in person reach a page", async () => {
    const response = await gateRequest(request("/", { token: VALID_TOKEN }), findSessionUser);

    expect(passesThrough(response)).toBe(true);
  });

  it("redirects a page request without a session to the sign-in page, keeping where it was going", async () => {
    const response = await gateRequest(request("/emails/E005?view=detail"), findSessionUser);

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/sign-in");
    expect(location.searchParams.get("next")).toBe("/emails/E005?view=detail");
  });

  it("keeps a deep link into the inbox, which lives on / with the email in its query", async () => {
    const response = await gateRequest(request("/?filter=all&email=E020&view=detail"), findSessionUser);

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("next")).toBe("/?filter=all&email=E020&view=detail");
  });

  it("sends a bare / to sign-in without a next", async () => {
    const response = await gateRequest(request("/"), findSessionUser);

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.has("next")).toBe(false);
  });

  it("redirects an unknown or expired session and clears its cookie", async () => {
    const response = await gateRequest(request("/", { token: "expired-token" }), findSessionUser);

    expect(response.status).toBe(307);
    expect(response.headers.get("set-cookie")).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
  });

  it("answers 401 to an API request without a session", async () => {
    const response = await gateRequest(request("/api/emails"), findSessionUser);

    expect(response.status).toBe(401);
  });

  it("answers 401 to a same-origin POST without a session, such as a server action", async () => {
    const response = await gateRequest(
      request("/", { method: "POST", origin: "https://desk.example" }),
      findSessionUser,
    );

    expect(response.status).toBe(401);
  });

  it("leaves the sign-in page and the health check open", async () => {
    const lookup = vi.fn(findSessionUser);

    expect(passesThrough(await gateRequest(request("/sign-in"), lookup))).toBe(true);
    expect(passesThrough(await gateRequest(request("/api/health"), lookup))).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("does not open paths that merely start like a public one", async () => {
    const response = await gateRequest(request("/api/health/details"), findSessionUser);

    expect(response.status).toBe(401);
  });

  it("refuses a cross-origin POST even with a valid session", async () => {
    const response = await gateRequest(
      request("/api/runs", { method: "POST", token: VALID_TOKEN, origin: "https://evil.example" }),
      findSessionUser,
    );

    expect(response.status).toBe(403);
  });

  it("refuses a POST that carries no Origin header", async () => {
    const response = await gateRequest(request("/api/runs", { method: "POST", token: VALID_TOKEN }), findSessionUser);

    expect(response.status).toBe(403);
  });

  it("refuses a cross-origin POST to the sign-in page", async () => {
    const response = await gateRequest(
      request("/sign-in", { method: "POST", origin: "https://evil.example" }),
      findSessionUser,
    );

    expect(response.status).toBe(403);
  });

  it("lets a same-origin POST with a session through", async () => {
    const response = await gateRequest(
      request("/api/runs", { method: "POST", token: VALID_TOKEN, origin: "https://desk.example" }),
      findSessionUser,
    );

    expect(passesThrough(response)).toBe(true);
  });

  it("compares the origin with the forwarded host when a proxy sets one", async () => {
    const forwarded = request("/api/runs", { method: "POST", token: VALID_TOKEN, origin: "https://desk.example" });
    forwarded.headers.set("host", "internal.vercel");
    forwarded.headers.set("x-forwarded-host", "desk.example");

    expect(passesThrough(await gateRequest(forwarded, findSessionUser))).toBe(true);
  });
});

describe("safeReturnPath", () => {
  it.each([
    ["/emails/E005", "/emails/E005"],
    [null, "/"],
    ["https://evil.example", "/"],
    ["//evil.example", "/"],
    ["/\\evil.example", "/"],
    ["/?filter=all&email=E020&view=detail", "/?filter=all&email=E020&view=detail"],
    // Browsers strip tab and newline, so these would become "//evil.example" (found in QA).
    ["/\t/evil.example", "/"],
    ["/\n/evil.example", "/"],
    ["/\r/evil.example", "/"],
    ["/x\\..\\..\\evil.example", "/"],
    ["/%2F/evil.example", "/%2F/evil.example"],
  ])("sends %s to %s", (next, expected) => {
    expect(safeReturnPath(next)).toBe(expected);
  });
});
