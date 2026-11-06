"use client";

import { useState } from "react";
import { signOutAction } from "@/server/auth/actions";
import { useInboxRun } from "./inbox-run";

// The header's account menu (issue 05, "Where the controls sit"): the person's name and Sign out,
// and for an admin Run all, Stop and Reset to 07:00. Hiding a control is never the check: every
// one of them is refused on the server to anyone but an admin (security 2).
export function AccountMenu({ username, isAdmin, runGoing }: { username: string; isAdmin: boolean; runGoing: boolean }) {
  return (
    <details className="account">
      <summary className="btn btn--ghost">{username}</summary>
      <div className="account-menu">
        {isAdmin ? <AdminControls runGoing={runGoing} /> : null}
        <form action={signOutAction}>
          <button type="submit" className="btn btn--ghost">
            Sign out
          </button>
        </form>
      </div>
    </details>
  );
}

function AdminControls({ runGoing }: { runGoing: boolean }) {
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
      ) : (
        <button type="button" className="btn btn--ghost" onClick={run.runAll}>
          Run all
        </button>
      )}
      <button type="button" className="btn btn--ghost" onClick={() => setConfirming(true)}>
        Reset to 07:00…
      </button>
    </>
  );
}
