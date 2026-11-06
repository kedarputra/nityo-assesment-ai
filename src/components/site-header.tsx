import { formatBusinessDay } from "@/lib/business-clock";
import { businessDate } from "@/rules/business-rules";
import type { SessionUser } from "@/server/auth/sessions";
import { signOutAction } from "@/server/auth/actions";
import { Avatar } from "./inbox/avatar";
import { HeaderNav } from "./header-nav";

export const MAIN_CONTENT_ID = "main";

const ROLE_NAMES: Record<SessionUser["role"], string> = {
  reviewer: "Reviewer",
  admin: "Admin",
};

export function SkipLink() {
  return (
    <a className="skip" href={`#${MAIN_CONTENT_ID}`}>
      Skip to content
    </a>
  );
}

export function SiteHeader({ user }: { user: SessionUser | null }) {
  return (
    <header className="top">
      <span className="wordmark" translate="no">
        Harbor Point <span>Order desk</span>
      </span>
      {user ? <HeaderNav /> : null}
      {user ? (
        <span className="right">
          {/* The business clock is fixed on the day of the inbox (case policy 1). */}
          <span className="meta hide-tablet">{formatBusinessDay(new Date(`${businessDate}T12:00:00Z`))} 2026</span>
          <span className="who">
            {/* "ops.reviewer" reads as two words, so its initials are "OR". */}
            <Avatar name={user.username.replace(/[._-]+/g, " ")} />
            <span className="who-text hide-phone">
              <span className="who-name">{user.username}</span>
              <span className="who-role">{ROLE_NAMES[user.role]}</span>
            </span>
          </span>
          <form action={signOutAction}>
            <button type="submit" className="btn btn--ghost">
              Sign out
            </button>
          </form>
        </span>
      ) : null}
    </header>
  );
}
