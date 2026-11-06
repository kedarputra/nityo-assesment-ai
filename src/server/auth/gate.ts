import { NextResponse, type NextRequest } from "next/server";
import type { SessionUser } from "./sessions";

export const SESSION_COOKIE = "hp_session";
export const SIGN_IN_PATH = "/sign-in";

// The only paths open without a session (security 7).
const PUBLIC_PATHS = new Set([SIGN_IN_PATH, "/api/health"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type FindSessionUser = (token: string) => Promise<SessionUser | null>;

// Runs in the proxy in front of every request (security 3 and 7). A state-changing request
// from another origin is refused before anything else; then every path but the public ones
// needs a session that is valid in the database, not just a cookie that is present.
export async function gateRequest(request: NextRequest, findSessionUser: FindSessionUser): Promise<NextResponse> {
  const isStateChanging = !SAFE_METHODS.has(request.method);
  if (isStateChanging && !isSameOrigin(request)) {
    return NextResponse.json({ error: "This request came from another site, so it was refused." }, { status: 403 });
  }

  const { pathname, search } = request.nextUrl;
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const user = token ? await findSessionUser(token) : null;
  if (user) return NextResponse.next();

  let response: NextResponse;
  if (isStateChanging || pathname.startsWith("/api/")) {
    response = NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  } else {
    const signIn = new URL(SIGN_IN_PATH, request.nextUrl);
    if (pathname !== "/") signIn.searchParams.set("next", `${pathname}${search}`);
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

// Where to go after signing in: only a path on this site, never another origin.
export function safeReturnPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}
