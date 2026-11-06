import type { SessionUser } from "@/server/auth/sessions";
import { AccountMenu } from "./account-menu";
import { HeaderNav } from "./header-nav";

export const MAIN_CONTENT_ID = "main";

export function SkipLink() {
  return (
    <a className="skip" href={`#${MAIN_CONTENT_ID}`}>
      Skip to content
    </a>
  );
}

// `runGoing`: whether an Inbox run or an Agent run holds the lock, so an admin's menu offers Stop.
export function SiteHeader({ user, runGoing = false }: { user: SessionUser | null; runGoing?: boolean }) {
  return (
    <header className="top">
      <span className="wordmark" translate="no">
        Harbor Point <span>Order desk</span>
      </span>
      {user ? <HeaderNav /> : null}
      {user ? (
        <span className="right">
          <AccountMenu username={user.username} isAdmin={user.role === "admin"} runGoing={runGoing} />
        </span>
      ) : null}
    </header>
  );
}
