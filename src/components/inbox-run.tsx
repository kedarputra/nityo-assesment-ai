"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { resetToSnapshotAction, startInboxRunAction, stopInboxRunAction } from "@/server/inbox/actions";

// Run all goes on on the server (ADR 0004): this browser only starts it, stops it and resets,
// says how that went, and refreshes the desk while anything is being read. Closing the tab, or
// moving to another page, never stops a run.

// How the last Start, Stop or Reset went. A problem is shown as one (DESIGN.md, "States": a calm
// sentence in a bad-soft card); anything else is plain news.
export interface InboxRunMessage {
  text: string;
  problem: boolean;
}

export const STOPPED_BY_YOU = "Stopped. The email being read finishes; press Run all to carry on from there.";
const NO_ANSWER: InboxRunMessage = { text: "The server didn’t answer. Try again in a moment.", problem: true };
const RESET_FAILED: InboxRunMessage = {
  text: "The reset didn’t go through. Nothing was changed; try again in a moment.",
  problem: true,
};

export interface InboxRunState {
  starting: boolean;
  stopping: boolean;
  resetting: boolean;
  message: InboxRunMessage | null;
  runAll: () => void;
  stop: () => void;
  reset: () => Promise<void>;
}

const InboxRunContext = createContext<InboxRunState | null>(null);

export function useInboxRun(): InboxRunState | null {
  return useContext(InboxRunContext);
}

export function InboxRunProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [message, setMessage] = useState<InboxRunMessage | null>(null);

  async function runAll() {
    if (starting) return;
    setStarting(true);
    setMessage(null);
    try {
      const started = await startInboxRunAction();
      if (!started.ok) setMessage({ text: started.message, problem: true });
    } catch {
      setMessage(NO_ANSWER);
    } finally {
      setStarting(false);
      router.refresh();
    }
  }

  function stop() {
    setStopping(true);
    void stopInboxRunAction()
      .then(() => setMessage({ text: STOPPED_BY_YOU, problem: false }))
      .catch(() => setMessage(NO_ANSWER))
      .finally(() => {
        setStopping(false);
        router.refresh();
      });
  }

  async function reset() {
    setResetting(true);
    setMessage(null);
    try {
      const result = await resetToSnapshotAction({ confirmed: true });
      setMessage(
        result.ok
          ? { text: "Reset to 07:00. Every email is waiting for the agent again.", problem: false }
          : { text: result.message, problem: true },
      );
    } catch {
      setMessage(RESET_FAILED);
    } finally {
      setResetting(false);
      router.refresh();
    }
  }

  const state: InboxRunState = {
    starting,
    stopping,
    resetting,
    message,
    runAll: () => void runAll(),
    stop,
    reset,
  };
  return <InboxRunContext.Provider value={state}>{children}</InboxRunContext.Provider>;
}

// In the greeting card: that Run all is going on the server, with Stop for an admin, or how the
// last Start, Stop or Reset went.
export function InboxRunProgress({ going, canStop }: { going: boolean; canStop: boolean }) {
  const run = useInboxRun();
  if (going) {
    return (
      <div className="inbox-run" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        <span>Run all is going: the agent reads one email after another, even with this tab closed.</span>
        {canStop && run ? (
          <button type="button" className="btn btn--ghost" onClick={run.stop} disabled={run.stopping} aria-busy={run.stopping}>
            {run.stopping ? "Stopping…" : "Stop"}
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <p
      className={run?.message?.problem ? "inbox-run card card--bad" : "inbox-run meta"}
      role="status"
      aria-live="polite"
      hidden={!run?.message}
    >
      {run?.message?.text}
    </p>
  );
}

// While the agent is reading anything, the desk asks the server again every few seconds, so a
// finished email shows up without a reload. It pauses while the tab is hidden.
const REFRESH_EVERY_MS = 4_000;

export function RefreshWhileReading({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, REFRESH_EVERY_MS);
    return () => clearInterval(timer);
  }, [active, router]);
  return null;
}
