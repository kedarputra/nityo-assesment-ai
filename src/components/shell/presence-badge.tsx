import Link from "next/link";
import type { PresenceState } from "@/server/desk/presence";

// The agent's presence as Teams shows a person's: a coloured dot with a word, and a ring on the
// dot so it never relies on colour alone (DESIGN.md, "Agent presence").
export const PRESENCE_WORDS: Record<PresenceState, string> = {
  active: "Active",
  idle: "Idle",
  paused: "Paused",
  off: "Off",
};

const PRESENCE_HINT: Record<PresenceState, string> = {
  active: "The agent is reading emails now.",
  idle: "Switched on; nothing is being read.",
  paused: "The model’s limit stopped a run in the last hour.",
  off: "No model key on this desk, so the agent doesn’t run.",
};

export function PresenceDot({ state }: { state: PresenceState }) {
  return <span className={`presence-dot presence-dot--${state}`} aria-hidden="true" />;
}

export function PresenceBadge({ state, reading }: { state: PresenceState; reading: number }) {
  const words = state === "active" && reading > 0 ? `Active · ${reading} reading` : PRESENCE_WORDS[state];
  return (
    <Link href="/agent" className={`presence presence--${state}`} title={PRESENCE_HINT[state]}>
      <PresenceDot state={state} />
      <span className="presence-label">
        <span className="presence-name">Agent</span>
        <span className="presence-state">{words}</span>
      </span>
    </Link>
  );
}
