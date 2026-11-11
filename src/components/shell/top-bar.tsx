import { Search } from "lucide-react";
import Link from "next/link";
import type { SessionUser } from "@/server/auth/sessions";
import type { AgentPresence } from "@/server/desk/presence";
import { AccountMenu } from "../account-menu";
import { PresenceBadge } from "./presence-badge";
import { DrawerButton } from "./shell-buttons";

const ROLE_NAMES: Record<SessionUser["role"], string> = { reviewer: "Reviewer", admin: "Admin" };

// The bar across the top, as in Teams: the app's name, one search for everything, the agent's
// presence and the account.
export function TopBar({ user, presence, query }: { user: SessionUser; presence: AgentPresence; query?: string }) {
  return (
    <header className="topbar">
      <div className="topbar-start">
        <DrawerButton />
        <Link className="brand" href="/" translate="no">
          <span className="brand-mark" aria-hidden="true">
            HP
          </span>
          <span className="brand-name">
            Harbor Point <span>Order desk</span>
          </span>
        </Link>
      </div>
      <form className="global-search" action="/search" role="search">
        <Search aria-hidden="true" size={16} />
        <label htmlFor="global-search" className="visually-hidden">
          Search everything
        </label>
        <input
          id="global-search"
          name="q"
          type="search"
          defaultValue={query}
          placeholder="Search emails, customers, products, orders"
          autoComplete="off"
          maxLength={200}
        />
        <select name="mode" aria-label="How to search" defaultValue="keyword" className="global-search-mode">
          <option value="keyword">Keyword</option>
          <option value="meaning">By meaning</option>
        </select>
      </form>
      <div className="topbar-end">
        <PresenceBadge state={presence.state} reading={presence.reading.length} />
        <AccountMenu
          username={user.username}
          roleName={ROLE_NAMES[user.role]}
          isAdmin={user.role === "admin"}
          runGoing={presence.runAll !== null}
          agentOn={presence.state !== "off"}
        />
      </div>
    </header>
  );
}
