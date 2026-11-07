"use client";

import { useState } from "react";
import { signOutAction } from "@/server/auth/actions";
import { Avatar } from "./inbox/avatar";
import { useInboxRun } from "./inbox-run";

// The header's account menu (issue 05, "Where the controls sit"): who is signed in and Sign out,
// and for an admin Run all, Stop and Reset to 07:00. Hiding a control is never the check: every
// one of them is refused on the server to anyone but an admin (security 2).
export function AccountMenu({
  username,
  roleName,
  isAdmin,
  runGoing,
  agentOn,
}: {
  username: string;
  roleName: string;
  isAdmin: boolean;
  runGoing: boolean;
  agentOn: boolean;
}) {
  return (
    <details className="account">
      <summary className="who" aria-label={`${username}, ${roleName}: account menu`}>
        {/* "ops.reviewer" reads as two words, so its initials are "OR". */}
        <Avatar name={username.replace(/[._-]+/g, " ")} />
        <span className="who-text hide-phone">
          <span className="who-name">{username}</span>
          <span className="who-role">{roleName}</span>
        </span>
        <span className="who-caret" aria-hidden="true">
          ▾
        </span>
      </summary>
      <div className="account-menu">
        {isAdmin ? <AdminControls runGoing={runGoing} agentOn={agentOn} /> : null}
        <form action={signOutAction}>
          <button type="submit" className="btn btn--ghost">
            Sign out
          </button>
        </form>
      </div>
    </details>
  );
}

function AdminControls({ runGoing, agentOn }: { runGoing: boolean; agentOn: boolean }) {
  const run = useInboxRun();
  const [confirming, setConfirming] = useState(false);
  if (!run) return null;
  // This browser's Run all, or one the server says is going (another tab's, or a closed one's).
  const going = run.reading !== null || runGoing;

  if (confirming) {
    return (
      <div className="account-confirm" role="group" aria-label="Reset to 07:00">
        <p>
          This puts every order, email and the audit log back to 07:00 on Mon 2 Nov. What the agent and the
          reviewers did is cleared; everyone stays signed in.
        </p>
        <div className="actions">
          <button
            type="button"
            className="btn btn--danger"
            disabled={run.resetting}
            aria-busy={run.resetting}
            onClick={() => void run.reset().then(() => setConfirming(false))}
          >
            {run.resetting ? <span className="spinner" aria-hidden="true" /> : null}
            Reset to 07:00
          </button>
          <button type="button" className="btn" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      {going ? (
        <button type="button" className="btn btn--ghost" onClick={run.stop} disabled={run.stopping} aria-busy={run.stopping}>
          {run.stopping ? "Stopping…" : "Stop the run"}
        </button>
      ) : agentOn ? (
        <button type="button" className="btn btn--ghost" onClick={run.runAll}>
          Run all
        </button>
      ) : (
        // The server refuses Run all too; this only says why the button is not here.
        <p className="meta account-note">Run all is off while the agent is switched off.</p>
      )}
      <button type="button" className="btn btn--ghost" onClick={() => setConfirming(true)}>
        Reset to 07:00…
      </button>
    </>
  );
}
