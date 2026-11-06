"use client";

import { createContext, useContext, useState, useTransition, type ReactNode } from "react";
import type { InboxStatus } from "@/server/inbox/inbox";
import { runAgentAction } from "@/server/inbox/actions";
import { StatusPill } from "./status-pill";

// Which emails this browser has asked the agent to read, so the row shows "Reading…" from the
// moment the button is pressed until the refreshed desk shows the outcome (DESIGN.md, "States").
interface AgentRuns {
  reading: ReadonlySet<string>;
  run: (emailId: string) => void;
  failures: ReadonlyMap<string, string>;
}

const AgentRunsContext = createContext<AgentRuns | null>(null);

const COULD_NOT_START = "The agent couldn’t start on this email. Try again in a moment.";

export function AgentRunsProvider({ children }: { children: ReactNode }) {
  const [reading, setReading] = useState<ReadonlySet<string>>(new Set());
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(new Map());
  const [, startTransition] = useTransition();

  function run(emailId: string) {
    setReading((current) => new Set(current).add(emailId));
    setFailures((current) => withoutKey(current, emailId));
    startTransition(async () => {
      const failure = await runFailure(emailId);
      startTransition(() => {
        setReading((current) => {
          const next = new Set(current);
          next.delete(emailId);
          return next;
        });
        if (failure !== null) setFailures((current) => new Map(current).set(emailId, failure));
      });
    });
  }

  return <AgentRunsContext.Provider value={{ reading, run, failures }}>{children}</AgentRunsContext.Provider>;
}

// Why the run could not start, or null when it ran; how the run went is on the refreshed desk.
async function runFailure(emailId: string): Promise<string | null> {
  try {
    const result = await runAgentAction(emailId);
    return result.ok ? null : result.message;
  } catch {
    return COULD_NOT_START;
  }
}

function withoutKey(map: ReadonlyMap<string, string>, key: string): ReadonlyMap<string, string> {
  const next = new Map(map);
  next.delete(key);
  return next;
}

export function RowStatus({ emailId, status }: { emailId: string; status: InboxStatus }) {
  const runs = useContext(AgentRunsContext);
  return <StatusPill status={runs?.reading.has(emailId) ? "reading" : status} />;
}

// A secondary button (DESIGN.md, "Buttons"): busy, it keeps its label and shows a spinner.
export function RunAgentButton({ emailId }: { emailId: string }) {
  const runs = useContext(AgentRunsContext);
  const busy = runs?.reading.has(emailId) ?? false;
  const failure = runs?.failures.get(emailId) ?? null;

  return (
    <div className="run-agent">
      <button type="button" className="btn" aria-busy={busy} disabled={busy} onClick={() => runs?.run(emailId)}>
        {busy ? <span className="spinner" aria-hidden="true" /> : null}
        Run the agent
      </button>
      <p className="inline-error" role="status" aria-live="polite" hidden={failure === null}>
        {failure}
      </p>
    </div>
  );
}
