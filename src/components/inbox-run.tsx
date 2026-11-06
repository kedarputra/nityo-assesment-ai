"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import {
  finishInboxRunAction,
  resetToSnapshotAction,
  runInboxEmailAction,
  startInboxRunAction,
  stopInboxRunAction,
  type InboxRunStepResult,
} from "@/server/inbox/actions";
import type { InboxRunPlan } from "@/server/inbox/inbox-run";

// Run all, driven by this browser (ADR 0003): one request per email, in received_at order, each
// waiting for the last. The header's account menu starts, stops and resets; the greeting card
// shows the progress. A closed tab simply stops asking, and Run all carries on from there.

export interface InboxRunEnd {
  // Null when every email of the plan was asked for; otherwise why the run stopped early.
  stoppedBecause: string | null;
  // Emails that ran out of time or calls, left for the next Run all.
  timedOut: number;
}

export interface InboxRunDriver {
  runEmail: (emailId: string) => Promise<InboxRunStepResult>;
  // Before each email: which one is being read now.
  onReading: (email: { emailId: string; position: number }) => void;
  // After each email, so the desk shows its outcome straight away.
  onRead: () => void;
  // Whether the person pressed Stop.
  stopRequested: () => boolean;
}

export const STOPPED_BY_YOU = "Stopped. Press Run all to carry on from where it got to.";

export async function driveInboxRun(plan: InboxRunPlan, driver: InboxRunDriver): Promise<InboxRunEnd> {
  let timedOut = 0;
  for (const email of plan.emails) {
    if (driver.stopRequested()) return { stoppedBecause: STOPPED_BY_YOU, timedOut };
    driver.onReading(email);
    const result = await driver.runEmail(email.emailId);
    driver.onRead();
    if (!result.ok) return { stoppedBecause: result.message, timedOut };
    if (result.outcome === "timed-out") timedOut += 1;
  }
  return { stoppedBecause: null, timedOut };
}

export function endMessage(end: InboxRunEnd): InboxRunMessage {
  if (end.stoppedBecause !== null) return { text: end.stoppedBecause, problem: end.stoppedBecause !== STOPPED_BY_YOU };
  if (end.timedOut === 0) return { text: "Run all finished: the agent has read every email.", problem: false };
  const emails = end.timedOut === 1 ? "1 email" : `${end.timedOut} emails`;
  return { text: `Run all finished. ${emails} timed out; run it again to finish them.`, problem: false };
}

const NO_ANSWER: InboxRunMessage = { text: "The run stopped: the server didn’t answer. Press Run all to carry on.", problem: true };
const RESET_FAILED: InboxRunMessage = {
  text: "The reset didn’t go through. Nothing was changed; try again in a moment.",
  problem: true,
};

// How the last Run all or Reset ended. A problem is shown as one (DESIGN.md, "States": a calm
// sentence in a bad-soft card); anything else is plain news.
export interface InboxRunMessage {
  text: string;
  problem: boolean;
}

export interface InboxRunState {
  // The email being read now, with its place in the day: "Reading 12 of 40…".
  reading: { emailId: string; position: number; total: number } | null;
  stopping: boolean;
  message: InboxRunMessage | null;
  resetting: boolean;
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
  const [reading, setReading] = useState<InboxRunState["reading"]>(null);
  const [stopping, setStopping] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [message, setMessage] = useState<InboxRunMessage | null>(null);
  const stopRequested = useRef(false);
  const running = useRef(false);

  async function runAll() {
    if (running.current) return;
    running.current = true;
    stopRequested.current = false;
    setMessage(null);
    try {
      const started = await startInboxRunAction();
      if (!started.ok) {
        setMessage({ text: started.message, problem: true });
        return;
      }
      const { plan } = started;
      const end = await driveInboxRun(plan, {
        runEmail: (emailId) => runInboxEmailAction({ inboxRunId: plan.inboxRunId, emailId }),
        onReading: (email) => setReading({ ...email, total: plan.total }),
        onRead: () => router.refresh(),
        stopRequested: () => stopRequested.current,
      });
      if (end.stoppedBecause === null) await finishInboxRunAction(plan.inboxRunId);
      setMessage(endMessage(end));
    } catch {
      setMessage(NO_ANSWER);
    } finally {
      running.current = false;
      setReading(null);
      setStopping(false);
      router.refresh();
    }
  }

  // The email being read finishes; no other starts. Stopping on the server also ends a Run all
  // whose tab was closed.
  function stop() {
    stopRequested.current = true;
    setStopping(true);
    void stopInboxRunAction()
      .catch(() => setMessage(NO_ANSWER))
      .finally(() => {
        if (!running.current) setStopping(false);
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
    reading,
    stopping,
    message,
    resetting,
    runAll: () => void runAll(),
    stop,
    reset,
  };
  return <InboxRunContext.Provider value={state}>{children}</InboxRunContext.Provider>;
}

// In the greeting card: where Run all has got to, and how it ended.
export function InboxRunProgress() {
  const run = useInboxRun();
  if (!run) return null;
  if (run.reading) {
    return (
      <div className="inbox-run" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        <span>
          Reading {run.reading.position} of {run.reading.total}…
        </span>
        <button type="button" className="btn btn--ghost" onClick={run.stop} disabled={run.stopping} aria-busy={run.stopping}>
          {run.stopping ? "Stopping…" : "Stop"}
        </button>
      </div>
    );
  }
  return (
    <p
      className={run.message?.problem ? "inbox-run card card--bad" : "inbox-run meta"}
      role="status"
      aria-live="polite"
      hidden={run.message === null}
    >
      {run.message?.text}
    </p>
  );
}
