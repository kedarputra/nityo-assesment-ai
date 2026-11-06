import { isHardRule, type ReleaseCheck } from "@/agent/release-checks";
import type { RecordedCheck } from "@/db/schema";

// The release checks as a person reads them, shared by the Proposal pane and the review controls.

// What each release check is called on the desk (DESIGN.md, "Voice and words").
const CHECK_NAMES: Record<ReleaseCheck, string> = {
  "known-contact": "A known contact sent it",
  "skus-sellable": "Every product can be sold",
  "no-substitution": "No product swap",
  "confident-skus": "Every product is clear",
  "selling-units": "Quantities in selling units",
  "system-price": "System prices",
  "full-stock": "Fully in stock",
  "requested-date": "A clear delivery date",
  "from-history": "Lines the customer wrote out",
  "credit-hold": "Not on credit hold",
  "credit-limit": "Within the credit limit",
  "ship-to": "One clear ship-to",
  "no-flags": "Nothing flagged",
};

export function checkName(check: string): string {
  return check in CHECK_NAMES ? CHECK_NAMES[check as ReleaseCheck] : check;
}

// Why a hard rule cannot be overridden, and what clears it (DESIGN.md: "Can't be overridden.").
export function lockedBecause(check: string): string {
  switch (check) {
    case "skus-sellable":
      return "Can’t be overridden. Swap in a product that can be sold, or reject it.";
    case "ship-to":
      return "Can’t be overridden. Choose one of the customer’s own ship-tos.";
    default:
      return "Can’t be overridden. Accounts needs to clear this first.";
  }
}

function checkIcon(check: RecordedCheck): string {
  if (check.passes) return "✓";
  return isHardRule(check.check) ? "🔒" : "!";
}

// `extra` adds what goes under a check: its note field, its lock, or the note a person gave.
export function CheckList({
  checks,
  extra,
}: {
  checks: RecordedCheck[];
  extra?: (check: RecordedCheck) => React.ReactNode;
}) {
  return (
    <ul className="checks">
      {checks.map((check) => (
        <li key={check.check}>
          <span aria-hidden="true">{checkIcon(check)}</span>
          <span className="check-body">
            <span>
              <b>{checkName(check.check)}.</b> {check.detail}
              {check.choices && check.choices.length > 0 ? ` Choices: ${check.choices.join("; ")}.` : null}
            </span>
            {extra?.(check)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function PassingChecks({ checks }: { checks: RecordedCheck[] }) {
  const passing = checks.filter((check) => check.passes);
  if (passing.length === 0) return null;
  return (
    <details className="checks-ok">
      <summary>
        {passing.length} {passing.length === 1 ? "check looks" : "checks look"} good
      </summary>
      <CheckList checks={passing} />
    </details>
  );
}
