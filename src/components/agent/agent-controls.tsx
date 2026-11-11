"use client";

import { Play, RotateCcw, Square } from "lucide-react";
import { useState } from "react";
import { useInboxRun } from "../inbox-run";

// An admin's controls on the Agent page: Run all or Stop, and Reset to 07:00 with a confirmation.
export function AgentControls({ runGoing, agentOn }: { runGoing: boolean; agentOn: boolean }) {
  const run = useInboxRun();
  const [confirming, setConfirming] = useState(false);
  if (!run) return null;

  return (
    <div className="agent-controls">
      {runGoing ? (
        <button type="button" className="btn" onClick={run.stop} disabled={run.stopping} aria-busy={run.stopping}>
          <Square size={14} aria-hidden="true" />
          {run.stopping ? "Stopping…" : "Stop the run"}
        </button>
      ) : (
        <button type="button" className="btn btn--primary" onClick={run.runAll} disabled={!agentOn || run.starting} aria-busy={run.starting}>
          <Play size={14} aria-hidden="true" />
          Run all
        </button>
      )}
      {confirming ? (
        <span className="confirm-inline" role="group" aria-label="Reset to 07:00">
          <span>Put everything back to 07:00 on Mon 2 Nov?</span>
          <button type="button" className="btn btn--danger btn--small" disabled={run.resetting} onClick={() => void run.reset().then(() => setConfirming(false))}>
            Reset
          </button>
          <button type="button" className="btn btn--ghost btn--small" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </span>
      ) : (
        <button type="button" className="btn btn--ghost" onClick={() => setConfirming(true)}>
          <RotateCcw size={14} aria-hidden="true" />
          Reset to 07:00…
        </button>
      )}
      {run.message ? <p className={run.message.problem ? "inline-error" : "meta"}>{run.message.text}</p> : null}
    </div>
  );
}
