const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

// Money is integer cents everywhere; this is the one place it becomes dollars, for people to read.
export function formatUsd(cents: number): string {
  return usd.format(cents / 100);
}
