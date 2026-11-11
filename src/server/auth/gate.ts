import { NextResponse, type NextRequest } from "next/server";
import type { SessionUser } from "./sessions";

export const SESSION_COOKIE = "hp_session";
export const SIGN_IN_PATH = "/sign-in";

// The schedule's tick (ADR 0005), posted by a GitHub Actions workflow rather than a browser.
export const AGENT_TICK_PATH = "/api/agent/tick";

// The only paths open without a session (security 7). The Run all step carries its run's own
// secret instead, checked by the route (ADR 0004); so does the schedule's tick, whose
// `Authorization: Bearer <CRON_SECRET>` the route checks (ADR 0005).
const PUBLIC_PATHS = new Set([SIGN_IN_PATH, "/api/health", "/api/inbox-run/step", AGENT_TICK_PATH]);
// Paths exempt from the same-origin check: the caller is a server, which sends no Origin, and
// proves itself with a bearer secret instead of a cookie. A cross-site page cannot forge one: it
// has no secret, its browser would attach no credential, and a custom Authorization header from
// another origin needs a CORS preflight the app never grants.
const BEARER_PATHS = new Set([AGENT_TICK_PATH]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type FindSessionUser = (token: string) => Promise<SessionUser | null>;

// Runs in the proxy in front of every request (security 3 and 7). A state-changing request
// from another origin is refused before anything else; then every path but the public ones
// needs a session that is valid in the database, not just a cookie that is present.
// `forwardedHeaders`, when given, replace the request's headers on the way to the page.
export async function gateRequest(
  request: NextRequest,
  findSessionUser: FindSessionUser,
  forwardedHeaders?: Headers,
): Promise<NextResponse> {
  const isStateChanging = !SAFE_METHODS.has(request.method);
  const { pathname, search } = request.nextUrl;
  if (isStateChanging && !BEARER_PATHS.has(pathname) && !isSameOrigin(request)) {
    return NextResponse.json({ error: "This request came from another site, so it was refused." }, { status: 403 });
  }

  const passThrough = () => NextResponse.next(forwardedHeaders ? { request: { headers: forwardedHeaders } } : undefined);
  if (PUBLIC_PATHS.has(pathname)) return passThrough();

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const user = token ? await findSessionUser(token) : null;
  if (user) return passThrough();

  let response: NextResponse;
  if (isStateChanging || pathname.startsWith("/api/")) {
    response = NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  } else {
    const signIn = new URL(SIGN_IN_PATH, request.nextUrl);
    // The inbox with an email in its URL is a deep link too: keep it, so sign-in returns there.
    if (pathname !== "/" || search) signIn.searchParams.set("next", `${pathname}${search}`);
    response = NextResponse.redirect(signIn);
  }
  if (token) response.cookies.delete(SESSION_COOKIE);
  return response;
}

// Server actions get this check from Next.js; POST routes get it here. The host is the one the
// browser addressed, which a proxy such as Vercel's passes as x-forwarded-host.
export function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;

  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? request.nextUrl.host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const RETURN_BASE = "http://desk.invalid";

// Where to go after signing in: only a path on this site, never another origin. Browsers strip
// tabs and newlines and read "\\" as "/", so "/\t/evil.example" would become "//evil.example":
// those characters are refused outright, and the URL parser has the last word on the origin.
export function safeReturnPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(next)) return "/";
  try {
    const url = new URL(next, RETURN_BASE);
    if (url.origin !== RETURN_BASE) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
