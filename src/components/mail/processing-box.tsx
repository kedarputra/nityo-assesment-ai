"use client";

import { Bot, LoaderCircle, Square } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useInboxRun } from "../inbox-run";
import { mailHref } from "./folders";

export interface ProcessingBoxProps {
  reading: { emailId: string; fromName: string; subject: string; startedAt: Date }[];
  handled: number;
  total: number;
  runAll: { trigger: "person" | "schedule"; selected: number | null } | null;
  canStop: boolean;
}

// The emails the agent is reading right now, as one box that keeps itself current (ADR 0005):
// the count, the day's progress and each email with how long it has been read. The desk refreshes
// every few seconds while it shows; the timers tick every second in between.
export function ProcessingBox({ reading, handled, total, runAll, canStop }: ProcessingBoxProps) {
  const run = useInboxRun();
  const now = useNow(reading.length > 0);
  if (reading.length === 0 && !runAll) return null;
  const percent = total === 0 ? 0 : Math.round((handled / total) * 100);

  return (
    <section className="processing-box" aria-labelledby="processing-title" aria-live="polite">
      <header className="processing-head">
        <span className="processing-icon" aria-hidden="true">
          <Bot size={18} />
        </span>
        <div className="processing-count">
          <span className="processing-number">{reading.length}</span>
          <h2 id="processing-title" className="processing-title">
            {reading.length === 1 ? "email being read" : "emails being read"}
          </h2>
        </div>
        {runAll && canStop && run ? (
          <button type="button" className="btn btn--small" onClick={run.stop} disabled={run.stopping} aria-busy={run.stopping}>
            <Square size={12} aria-hidden="true" />
            {run.stopping ? "Stopping…" : "Stop"}
          </button>
        ) : null}
      </header>
      {runAll ? (
        <p className="processing-run">
          <span className="run-tag">{runAll.trigger === "schedule" ? "Scheduled run" : runAll.selected ? `Selected · ${runAll.selected}` : "Run all"}</span>
          goes on with this tab closed
        </p>
      ) : null}
      <div className="processing-progress" role="progressbar" aria-label="Emails handled today" aria-valuemin={0} aria-valuemax={total} aria-valuenow={handled}>
        <span style={{ width: `${percent}%` }} />
      </div>
      <p className="processing-meta">
        <b>{handled}</b> of {total} handled today
      </p>
      {reading.length > 0 ? (
        <ul className="processing-list">
          {reading.map((email) => (
            <li key={email.emailId}>
              <Link href={mailHref({ folder: "inbox", emailId: email.emailId, view: "detail" })}>
                <LoaderCircle size={14} aria-hidden="true" className="spin" />
                <span className="id">{email.emailId}</span>
                <span className="processing-from">{email.fromName}</span>
                <span className="processing-time num" suppressHydrationWarning>
                  {elapsed(now - email.startedAt.getTime())}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
