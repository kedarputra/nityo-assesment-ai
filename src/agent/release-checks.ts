// The release checks (ADR 0001), kept free of the database so the review UI can read them too.

// Every release check, in the order a person reads them.
export const releaseChecks = [
  "known-contact",
  "skus-sellable",
  "system-price",
  "full-stock",
  "credit-hold",
  "credit-limit",
  "ship-to",
  "no-flags",
] as const;
export type ReleaseCheck = (typeof releaseChecks)[number];

// A person may override a soft check with a note; a hard rule cannot be overridden (charting,
// approve, edit and override): CREDIT_HOLD, the credit limit and a DISCONTINUED SKU. A SKU that is
// not in the catalog and a ship-to that is not the customer's own cannot be released either: there
// is no price or no address to release to, so a person fixes them by editing the line or the
// ship-to instead.
const HARD_RULES: ReadonlySet<string> = new Set<ReleaseCheck>([
  "skus-sellable",
  "credit-hold",
  "credit-limit",
  "ship-to",
]);

export function isHardRule(check: string): boolean {
  return HARD_RULES.has(check);
}
