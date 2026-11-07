import { formatBusinessDay } from "@/lib/business-clock";
import { isAgentConfigured } from "@/model/agent-switch";
import { businessDate } from "@/rules/business-rules";
import type { SessionUser } from "@/server/auth/sessions";
import { AccountMenu } from "./account-menu";
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

// `runGoing`: whether an Inbox run or an Agent run holds the lock, so an admin's menu offers Stop.
export function SiteHeader({ user, runGoing = false }: { user: SessionUser | null; runGoing?: boolean }) {
  const agentOn = isAgentConfigured();
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
          <AccountMenu
            username={user.username}
            roleName={ROLE_NAMES[user.role]}
            isAdmin={user.role === "admin"}
            runGoing={runGoing}
            agentOn={agentOn}
          />
        </span>
      ) : null}
    </header>
  );
}
