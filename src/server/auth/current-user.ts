import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getDatabase } from "@/db/client";
import type { UserRole } from "@/db/schema";
import { SESSION_COOKIE, SIGN_IN_PATH } from "./gate";
import { findSessionUser, type SessionUser } from "./sessions";

export class ForbiddenError extends Error {
  constructor(role: UserRole) {
    super(`This needs the ${role} role.`);
    this.name = "ForbiddenError";
  }
}

// An admin may do everything a reviewer may (security 2).
export function hasRole(user: SessionUser, role: UserRole): boolean {
  return role === "reviewer" || user.role === "admin";
}

// The signed-in user for this request, or null. Looked up once per request, from the database
// rather than the cookie alone, so a signed-out or expired session is never trusted.
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return findSessionUser(getDatabase(), token, new Date());
});

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect(SIGN_IN_PATH);
  return user;
}

// Every state-changing server action and POST route calls this first, and records the user it
// returns. Hiding a control in the UI is never the check (security 2).
export async function requireRole(role: UserRole): Promise<SessionUser> {
  const user = await requireUser();
  if (!hasRole(user, role)) throw new ForbiddenError(role);
  return user;
}

export function sessionCookieOptions(expiresAt: Date) {
  return { httpOnly: true, secure: true, sameSite: "lax", path: "/", expires: expiresAt } as const;
}
