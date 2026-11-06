import type { InboxStatus } from "@/server/inbox/inbox";

// Each status has an icon and words, never colour alone (DESIGN.md, "Colour").
const STATUS_PILLS: Record<InboxStatus, { icon: string; words: string }> = {
  not_run: { icon: "○", words: "Not run yet" },
  reading: { icon: "…", words: "Reading…" },
  released: { icon: "✓", words: "Done by the agent" },
  needs_you: { icon: "!", words: "Needs you" },
  no_action: { icon: "–", words: "No action needed" },
  failed: { icon: "!", words: "Didn’t finish" },
};

export function StatusPill({ status }: { status: InboxStatus }) {
  const pill = STATUS_PILLS[status];
  return (
    <span className={`pill pill--${status}`}>
      <span aria-hidden="true">{pill.icon}</span>
      {pill.words}
    </span>
  );
}
