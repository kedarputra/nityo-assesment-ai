import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { formatBusinessDay } from "@/lib/business-clock";
import { businessDate } from "@/rules/business-rules";
import { getCurrentUser } from "@/server/auth/current-user";
import { safeReturnPath } from "@/server/auth/gate";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = {
  title: "Sign in · Harbor Point",
};

// What the desk does, in the reviewer's words (DESIGN.md, "Voice"): one line each.
const POINTS = [
  { title: "It reads the order inbox.", body: "Each customer email becomes order lines, matched to the right products." },
  { title: "It checks the rules.", body: "Stock, contract prices, credit and the customer’s own delivery addresses." },
  { title: "You decide anything risky.", body: "Unusual orders wait here with the reason, for you to approve, change or reject." },
];

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const { next } = await searchParams;
  const returnPath = typeof next === "string" ? safeReturnPath(next) : undefined;

  if (await getCurrentUser()) redirect(returnPath ?? "/");

  // Noon UTC falls on the business day in US Eastern, so the label is the business date.
  const day = formatBusinessDay(new Date(`${businessDate}T12:00:00Z`));

  return (
    <div className="sign-in-layout">
      <section className="sign-in-intro" aria-labelledby="sign-in-intro-title">
        <p className="sign-in-kicker">Harbor Point Supply Co. · order desk</p>
        <h2 id="sign-in-intro-title" className="sign-in-display">
          Every order email, read and checked before you start.
        </h2>
        <ol className="sign-in-points">
          {POINTS.map((point, index) => (
            <li key={point.title}>
              <span className="sign-in-step" aria-hidden="true">
                {index + 1}
              </span>
              <span>
                <strong>{point.title}</strong> {point.body}
              </span>
            </li>
          ))}
        </ol>
        <p className="sign-in-day">Today’s inbox: {day} 2026</p>
      </section>

      <section className="card sign-in" aria-labelledby="sign-in-title">
        <h1 id="sign-in-title" className="title">
          Sign in to the order desk
        </h1>
        <p className="meta">Use the login you were given. Signing in keeps you in for 12 hours.</p>
        <SignInForm next={returnPath} />
      </section>
    </div>
  );
}
