"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDatabase } from "@/db/client";
import { sessionCookieOptions } from "./current-user";
import { SESSION_COOKIE, SIGN_IN_PATH, safeReturnPath } from "./gate";
import { signIn, signOut } from "./sessions";

export interface SignInFormState {
  message: string | null;
  username: string;
}

const signInForm = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(1024),
  next: z.string().max(2048).optional(),
});

const MISSING_FIELDS_MESSAGE = "Enter your username and password to sign in.";

export async function signInAction(_previous: SignInFormState, formData: FormData): Promise<SignInFormState> {
  const typedUsername = formData.get("username");
  const username = typeof typedUsername === "string" ? typedUsername : "";
  const form = signInForm.safeParse({
    username,
    password: formData.get("password"),
    next: formData.get("next") ?? undefined,
  });
  if (!form.success) return { message: MISSING_FIELDS_MESSAGE, username };

  const cookieStore = await cookies();
  const result = await signIn(
    getDatabase(),
    {
      username: form.data.username,
      password: form.data.password,
      previousToken: cookieStore.get(SESSION_COOKIE)?.value,
    },
    new Date(),
  );
  if (!result.ok) return { message: result.message, username };

  cookieStore.set(SESSION_COOKIE, result.token, sessionCookieOptions(result.expiresAt));
  redirect(safeReturnPath(form.data.next));
}

export async function signOutAction(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (token) await signOut(getDatabase(), token);
  cookieStore.delete(SESSION_COOKIE);
  redirect(SIGN_IN_PATH);
}
