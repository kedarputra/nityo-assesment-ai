import type { SessionUser } from "@/server/auth/sessions";
import { signOutAction } from "@/server/auth/actions";

export const MAIN_CONTENT_ID = "main";

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
      {user ? (
        <span className="right">
          <span className="meta hide-phone">{user.username}</span>
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
