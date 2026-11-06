import type { NextRequest } from "next/server";
import { getDatabase } from "@/db/client";
import { gateRequest } from "@/server/auth/gate";
import { findSessionUser } from "@/server/auth/sessions";

// Proxy runs on the Node.js runtime in Next.js 16, so it can check the session in Postgres.
export function proxy(request: NextRequest) {
  return gateRequest(request, (token) => findSessionUser(getDatabase(), token, new Date()));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
