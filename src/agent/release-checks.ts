// The release checks (ADR 0001), kept free of the database so the review UI can read them too.

// Every release check, in the order a person reads them.
export const releaseChecks = [
  "known-contact",
  "skus-sellable",
  "no-substitution",
  "confident-skus",
  "selling-units",
  "system-price",
  "full-stock",
  "requested-date",
  "from-history",
  "credit-hold",
  "credit-limit",
  "ship-to",
  "single-ship-to",
  "no-flags",
] as const;
export type ReleaseCheck = (typeof releaseChecks)[number];

// The checks on a change or a cancellation of an existing sales order. Only the changes are
// checked: an increase needs stock and credit, a line added needs a product that can be sold.
export const changeChecks = [
  "known-contact",
  "edit-rights",
  "skus-sellable",
  "confident-skus",
  "selling-units",
  "full-stock",
  "credit-hold",
  "credit-limit",
  "no-flags",
] as const;
export type ChangeCheck = (typeof changeChecks)[number];

export type ProposalCheck = ReleaseCheck | ChangeCheck;

// A person may override a soft check with a note; a hard rule cannot be overridden (charting,
// approve, edit and override): CREDIT_HOLD, the credit limit and a DISCONTINUED SKU. A SKU that is
// not in the catalog and a ship-to that is not the customer's own cannot be released either: there
// is no price or no address to release to, so a person fixes them by editing the line or the
// ship-to instead. The README's edit rules are hard too: a SHIPPED order cannot be changed, and a
// PARTIALLY_SHIPPED one only in its unshipped quantity.
const HARD_RULES: ReadonlySet<string> = new Set<ProposalCheck>([
  "edit-rights",
  "skus-sellable",
  "credit-hold",
  "credit-limit",
  "ship-to",
]);

export function isHardRule(check: string): boolean {
  return HARD_RULES.has(check);
}
