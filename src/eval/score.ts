import type { AgentRunOutcome, ProposalStatus } from "@/db/schema";
import type { ExpectedEmail, ExpectedLine, ExpectedOutcomeKind, ExpectedOutcomes } from "./expected-outcomes";

// Scores one live run against the walkthrough, as issue 11 decided, in order of importance:
// unsafe releases, outcome accuracy (missed releases apart), lines, exact price and credit,
// review reasons, then cost and time. Draft replies are read by a person, so they are not scored.

// What one Agent run on one email left behind, read from its records.
export interface EmailRunResult {
  emailId: string;
  outcome: AgentRunOutcome | null;
  errorClass: string | null;
  flags: string[];
  proposals: RunProposal[];
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  seconds: number;
}

export interface RunProposal {
  status: ProposalStatus;
  shipToId: string;
  lines: { sku: string; quantity: number; unitPriceCents: number | null }[];
  // The release checks that failed (release-gate.ts names them).
  failingChecks: string[];
}

export interface UnsafeRelease {
  emailId: string;
  expected: ExpectedOutcomeKind;
  actual: string;
  reason: string;
}

export interface OutcomeDifference {
  emailId: string;
  expected: ExpectedOutcomeKind;
  actual: string;
}

export interface LineDifference {
  emailId: string;
  shipToId: string;
  sku: string;
  quantity: number;
}

export interface PriceMismatch {
  emailId: string;
  sku: string;
  expectedCents: number;
  actualCents: number | null;
}

export interface CreditMismatch {
  emailId: string;
  check: CreditCheck;
  expectedToFail: boolean;
  failed: boolean;
}

export interface ReasonDifference {
  emailId: string;
  missing: string[];
  extra: string[];
}

export interface RunScore {
  unsafeReleases: UnsafeRelease[];
  outcomes: {
    emails: number;
    matches: number;
    accuracy: number;
    missedReleases: OutcomeDifference[];
    mismatches: OutcomeDifference[];
  };
  lines: {
    expected: number;
    proposed: number;
    matched: number;
    precision: number;
    recall: number;
    missing: LineDifference[];
    extra: LineDifference[];
  };
  priceMismatches: PriceMismatch[];
  creditMismatches: CreditMismatch[];
  reviewReasons: {
    expected: number;
    raised: number;
    recall: number;
    perEmail: ReasonDifference[];
  };
  cost: {
    emails: number;
    modelCalls: number;
    totalCostMicroUsd: number;
    costPerEmailMicroUsd: number;
    totalSeconds: number;
    secondsPerEmail: number;
  };
}

type CreditCheck = "credit-hold" | "credit-limit";

// The walkthrough's flag code for each credit check the gate runs.
const creditFlagCodes: Record<CreditCheck, string> = {
  "credit-hold": "HARD-credit-hold",
  "credit-limit": "HARD-credit-limit",
};

// A failing gate check raises the walkthrough's flag as surely as a flag the model raised. The
// gate's `skus-sellable` is left out: it fails both for a discontinued SKU (P3-discontinued) and
// for one not in the catalog (LOW-CONF-sku), so its name alone cannot say which.
const flagCodeOfCheck: Record<string, string> = {
  ...creditFlagCodes,
  "full-stock": "P2-short-stock",
  "system-price": "P4-price-differs",
  "known-contact": "P5-unverified-contact",
  "single-ship-to": "P7-multi-ship-to",
};

export function scoreRun(expected: ExpectedOutcomes, run: EmailRunResult[]): RunScore {
  const results = new Map(run.map((result) => [result.emailId, result]));
  return {
    unsafeReleases: unsafeReleases(expected.emails, results),
    outcomes: outcomeAccuracy(expected.emails, results),
    ...lineAccuracy(expected.lines, run),
    creditMismatches: creditMismatches(expected.emails, results),
    reviewReasons: reviewReasonRecall(expected.emails, results),
    cost: costAndTime(run),
  };
}

function acceptedOutcomes(email: ExpectedEmail): ExpectedOutcomeKind[] {
  return [email.outcome, ...email.alsoAcceptable];
}

function describeActual(result: EmailRunResult | undefined): string {
  if (!result || result.outcome === null) return "not run";
  if (result.outcome === "failed") return `failed (${result.errorClass ?? "no error class"})`;
  return result.outcome;
}

function releasedAnything(result: EmailRunResult | undefined): boolean {
  return result?.proposals.some((proposal) => proposal.status === "released") ?? false;
}

// Any release on an email whose expected outcomes do not include one. A Proposal released among
// open ones counts, though the run's outcome then reads "proposal".
function unsafeReleases(emails: ExpectedEmail[], results: Map<string, EmailRunResult>): UnsafeRelease[] {
  return emails
    .filter((email) => !acceptedOutcomes(email).includes("released") && releasedAnything(results.get(email.emailId)))
    .map((email) => ({
      emailId: email.emailId,
      expected: email.outcome,
      actual: "released",
      reason: `expected ${email.outcome}: ${email.reviewReasons.join(", ") || "no reason given"}`,
    }));
}

function outcomeAccuracy(emails: ExpectedEmail[], results: Map<string, EmailRunResult>): RunScore["outcomes"] {
  let matches = 0;
  const missedReleases: OutcomeDifference[] = [];
  const mismatches: OutcomeDifference[] = [];
  for (const email of emails) {
    const result = results.get(email.emailId);
    const actual = describeActual(result);
    // Listed among the unsafe releases, and never a match.
    if (!acceptedOutcomes(email).includes("released") && releasedAnything(result)) continue;
    const outcome = result?.outcome;
    if (outcome && outcome !== "failed" && acceptedOutcomes(email).includes(outcome)) {
      matches += 1;
    } else if (email.outcome === "released" && (outcome === "proposal" || outcome === "routed")) {
      missedReleases.push({ emailId: email.emailId, expected: email.outcome, actual });
    } else {
      mismatches.push({ emailId: email.emailId, expected: email.outcome, actual });
    }
  }
  return { emails: emails.length, matches, accuracy: ratio(matches, emails.length), missedReleases, mismatches };
}

interface ProposedLine {
  emailId: string;
  shipToId: string;
  sku: string;
  quantity: number;
  unitPriceCents: number | null;
}

// Each expected line is matched to at most one proposed line on the same email, by SKU (any the
// walkthrough leaves open), quantity and ship-to; the price is then compared exactly.
function lineAccuracy(expectedLines: ExpectedLine[], run: EmailRunResult[]): Pick<RunScore, "lines" | "priceMismatches"> {
  const unmatched: ProposedLine[] = run.flatMap((result) =>
    result.proposals.flatMap((proposal) =>
      proposal.lines.map((line) => ({ emailId: result.emailId, shipToId: proposal.shipToId, ...line })),
    ),
  );
  const proposed = unmatched.length;
  const missing: LineDifference[] = [];
  const priceMismatches: PriceMismatch[] = [];
  let matched = 0;

  for (const line of expectedLines) {
    const index = unmatched.findIndex(
      (candidate) =>
        candidate.emailId === line.emailId &&
        candidate.shipToId === line.shipToId &&
        candidate.quantity === line.quantity &&
        line.skus.includes(candidate.sku),
    );
    const found = unmatched[index];
    if (!found) {
      missing.push({ emailId: line.emailId, shipToId: line.shipToId, sku: line.skus.join("|"), quantity: line.quantity });
      continue;
    }
    unmatched.splice(index, 1);
    matched += 1;
    if (found.unitPriceCents !== line.unitPriceCents) {
      priceMismatches.push({ emailId: line.emailId, sku: found.sku, expectedCents: line.unitPriceCents, actualCents: found.unitPriceCents });
    }
  }

  return {
    lines: {
      expected: expectedLines.length,
      proposed,
      matched,
      precision: ratio(matched, proposed),
      recall: ratio(matched, expectedLines.length),
      missing,
      extra: unmatched.map(({ emailId, shipToId, sku, quantity }) => ({ emailId, shipToId, sku, quantity })),
    },
    priceMismatches,
  };
}

// Credit comes from code, so wherever the run proposed an order, the gate's credit checks must
// fail exactly where the walkthrough flags credit; any difference is a bug.
function creditMismatches(emails: ExpectedEmail[], results: Map<string, EmailRunResult>): CreditMismatch[] {
  const mismatches: CreditMismatch[] = [];
  for (const email of emails) {
    const proposals = results.get(email.emailId)?.proposals ?? [];
    if (proposals.length === 0) continue;
    for (const check of ["credit-hold", "credit-limit"] as const) {
      const expectedToFail = email.reviewReasons.includes(creditFlagCodes[check]);
      const failed = proposals.some((proposal) => proposal.failingChecks.includes(check));
      if (expectedToFail !== failed) mismatches.push({ emailId: email.emailId, check, expectedToFail, failed });
    }
  }
  return mismatches;
}

function raisedReasons(result: EmailRunResult | undefined): Set<string> {
  const raised = new Set((result?.flags ?? []).map((code) => code.toLowerCase()));
  for (const proposal of result?.proposals ?? []) {
    for (const check of proposal.failingChecks) {
      const code = flagCodeOfCheck[check];
      if (code) raised.add(code.toLowerCase());
    }
  }
  return raised;
}

// For each expected Proposal, the share of its expected flags the run raised, and any extra.
function reviewReasonRecall(emails: ExpectedEmail[], results: Map<string, EmailRunResult>): RunScore["reviewReasons"] {
  let expectedCount = 0;
  let raisedCount = 0;
  const perEmail: ReasonDifference[] = [];
  for (const email of emails.filter((candidate) => candidate.outcome === "proposal")) {
    const result = results.get(email.emailId);
    const raised = raisedReasons(result);
    const expectedCodes = new Set(email.reviewReasons.map((code) => code.toLowerCase()));
    const missing = email.reviewReasons.filter((code) => !raised.has(code.toLowerCase()));
    const extra = [...new Set(result?.flags ?? [])].filter((code) => !expectedCodes.has(code.toLowerCase()));
    expectedCount += email.reviewReasons.length;
    raisedCount += email.reviewReasons.length - missing.length;
    if (missing.length > 0 || extra.length > 0) perEmail.push({ emailId: email.emailId, missing, extra });
  }
  return { expected: expectedCount, raised: raisedCount, recall: ratio(raisedCount, expectedCount), perEmail };
}

function costAndTime(run: EmailRunResult[]): RunScore["cost"] {
  const total = (pick: (result: EmailRunResult) => number) => run.reduce((sum, result) => sum + pick(result), 0);
  const totalCostMicroUsd = total((result) => result.costMicroUsd);
  const totalSeconds = total((result) => result.seconds);
  return {
    emails: run.length,
    modelCalls: total((result) => result.modelCalls),
    totalCostMicroUsd,
    costPerEmailMicroUsd: run.length === 0 ? 0 : Math.round(totalCostMicroUsd / run.length),
    totalSeconds,
    secondsPerEmail: ratio(totalSeconds, run.length),
  };
}

// An empty denominator scores 1: nothing was expected, so nothing was missed.
function ratio(part: number, whole: number): number {
  return whole === 0 ? 1 : part / whole;
}
