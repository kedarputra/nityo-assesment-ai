import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/current-user";
import { safeReturnPath } from "@/server/auth/gate";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = {
  title: "Sign in · Harbor Point",
};

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const { next } = await searchParams;
  const returnPath = typeof next === "string" ? safeReturnPath(next) : undefined;

  if (await getCurrentUser()) redirect(returnPath ?? "/");

  return (
    <section className="card sign-in" aria-labelledby="sign-in-title">
      <h1 id="sign-in-title" className="title">
        Sign in to the order desk
      </h1>
      <p className="meta">Use the login you were given. Signing in keeps you in for 12 hours.</p>
      <SignInForm next={returnPath} />
    </section>
  );
}
