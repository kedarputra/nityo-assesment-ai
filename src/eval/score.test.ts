import { describe, expect, it } from "vitest";
import { readExpectedOutcomes, type ExpectedOutcomes } from "./expected-outcomes";
import { scoreRun, type EmailRunResult, type RunProposal } from "./score";

const expected = readExpectedOutcomes();

// A canned run that does exactly what the walkthrough expects, for the tests to spoil one email
// at a time. No model is involved.
function perfectRun(outcomes: ExpectedOutcomes): EmailRunResult[] {
  return outcomes.emails.map((email) => {
    const failingChecks = [
      ...(email.reviewReasons.includes("HARD-credit-hold") ? ["credit-hold"] : []),
      ...(email.reviewReasons.includes("HARD-credit-limit") ? ["credit-limit"] : []),
    ];
    const lines = outcomes.lines.filter((line) => line.emailId === email.emailId && line.quantity > 0);
    const shipTos = [...new Set(lines.map((line) => line.shipToId))];
    const proposals: RunProposal[] = shipTos.map((shipToId) => ({
      status: email.outcome === "released" ? "released" : "open",
      shipToId,
      lines: lines
        .filter((line) => line.shipToId === shipToId)
        .map((line) => ({ sku: line.skus[0] ?? "", quantity: line.quantity, unitPriceCents: line.unitPriceCents })),
      failingChecks,
    }));
    return {
      emailId: email.emailId,
      outcome: email.outcome,
      errorClass: null,
      flags: email.reviewReasons,
      proposals,
      modelCalls: 6,
      inputTokens: 10_000,
      outputTokens: 1_000,
      costMicroUsd: 60_000,
      seconds: 12,
    };
  });
}

function withEmail(run: EmailRunResult[], emailId: string, change: Partial<EmailRunResult>): EmailRunResult[] {
  return run.map((result) => (result.emailId === emailId ? { ...result, ...change } : result));
}

function proposalsOf(run: EmailRunResult[], emailId: string): RunProposal[] {
  return run.find((result) => result.emailId === emailId)?.proposals ?? [];
}

function firstProposalOf(run: EmailRunResult[], emailId: string): RunProposal {
  const [proposal] = proposalsOf(run, emailId);
  if (!proposal) throw new Error(`The canned run has no Proposal for ${emailId}.`);
  return proposal;
}

describe("scoring a run against the expected outcomes", () => {
  it("scores a run that does what the walkthrough expects as all matches", () => {
    const score = scoreRun(expected, perfectRun(expected));
    expect(score.unsafeReleases).toEqual([]);
    expect(score.outcomes).toMatchObject({ matches: 40, accuracy: 1, missedReleases: [], mismatches: [] });
    expect(score.lines.recall).toBeLessThan(1); // the change and cancellation lines have no tool yet
    expect(score.lines.precision).toBe(1);
    expect(score.priceMismatches).toEqual([]);
    expect(score.creditMismatches).toEqual([]);
    expect(score.reviewReasons.recall).toBe(1);
  });

  it("lists an unsafe release first, with the email and why it should not have released", () => {
    const run = perfectRun(expected);
    const released = proposalsOf(run, "E006").map((proposal) => ({ ...proposal, status: "released" as const }));
    const score = scoreRun(expected, withEmail(run, "E006", { outcome: "released", proposals: released }));

    expect(score.unsafeReleases).toEqual([
      { emailId: "E006", expected: "proposal", actual: "released", reason: "expected proposal: HARD-credit-limit" },
    ]);
    expect(score.outcomes.matches).toBe(39);
    expect(score.outcomes.mismatches).toEqual([]);
  });

  it("counts a release as unsafe even when the run's outcome hides it among open Proposals", () => {
    const run = perfectRun(expected);
    const [, ...rest] = proposalsOf(run, "E031");
    const mixed = [{ ...firstProposalOf(run, "E031"), status: "released" as const }, ...rest];
    const score = scoreRun(expected, withEmail(run, "E031", { proposals: mixed }));
    expect(score.unsafeReleases.map((unsafe) => unsafe.emailId)).toEqual(["E031"]);
  });

  it("accepts an also-acceptable outcome as a match", () => {
    const run = withEmail(perfectRun(expected), "E002", {
      outcome: "proposal",
      flags: ["LOW-CONF-sku"],
      proposals: proposalsOf(perfectRun(expected), "E002").map((proposal) => ({ ...proposal, status: "open" })),
    });
    const score = scoreRun(expected, run);
    expect(score.outcomes).toMatchObject({ matches: 40, missedReleases: [], mismatches: [] });
    expect(score.unsafeReleases).toEqual([]);
  });

  it("counts a missed release apart from the errors", () => {
    const run = withEmail(perfectRun(expected), "E040", {
      outcome: "proposal",
      proposals: proposalsOf(perfectRun(expected), "E040").map((proposal) => ({ ...proposal, status: "open" })),
    });
    const score = scoreRun(expected, run);
    expect(score.outcomes.matches).toBe(39);
    expect(score.outcomes.missedReleases).toEqual([{ emailId: "E040", expected: "released", actual: "proposal" }]);
    expect(score.outcomes.mismatches).toEqual([]);
  });

  it("counts a failed run and a wrong outcome as mismatches", () => {
    let run = withEmail(perfectRun(expected), "E029", { outcome: "routed", flags: ["ROUTE-inquiry"] });
    run = withEmail(run, "E009", { outcome: "failed", errorClass: "call-cap" });
    const score = scoreRun(expected, run);
    expect(score.outcomes.mismatches).toEqual([
      { emailId: "E009", expected: "routed", actual: "failed (call-cap)" },
      { emailId: "E029", expected: "no_action", actual: "routed" },
    ]);
    expect(score.outcomes.accuracy).toBeCloseTo(38 / 40);
  });

  it("scores lines by SKU, quantity and ship-to, and checks each matched line's price exactly", () => {
    const run = perfectRun(expected);
    const spoiled: RunProposal = {
      ...firstProposalOf(run, "E001"),
      lines: [
        { sku: "HPS-1408", quantity: 4, unitPriceCents: 4400 },
        { sku: "HPS-1402", quantity: 5, unitPriceCents: 7100 },
        { sku: "HPS-1502", quantity: 2, unitPriceCents: 3300 },
      ],
    };
    const score = scoreRun(expected, withEmail(run, "E001", { proposals: [spoiled] }));

    expect(score.lines.missing).toContainEqual({ emailId: "E001", shipToId: "S001", sku: "HPS-1402", quantity: 6 });
    expect(score.lines.extra).toEqual([{ emailId: "E001", shipToId: "S001", sku: "HPS-1402", quantity: 5 }]);
    expect(score.lines.precision).toBeLessThan(1);
    expect(score.priceMismatches).toEqual([{ emailId: "E001", sku: "HPS-1408", expectedCents: 4500, actualCents: 4400 }]);
  });

  it("matches a line to any SKU the walkthrough leaves open", () => {
    const run = perfectRun(expected);
    const chosen = { ...firstProposalOf(run, "E035"), lines: [{ sku: "HPS-1002", quantity: 2, unitPriceCents: 6800 }] };
    const score = scoreRun(expected, withEmail(run, "E035", { proposals: [chosen] }));
    expect(score.lines.missing.filter((line) => line.emailId === "E035")).toEqual([]);
  });

  it("compares the gate's credit checks with the walkthrough's credit flags", () => {
    const run = perfectRun(expected);
    const e007 = proposalsOf(run, "E007").map((proposal) => ({ ...proposal, failingChecks: ["credit-hold"] }));
    const e001 = proposalsOf(run, "E001").map((proposal) => ({ ...proposal, failingChecks: ["credit-limit"] }));
    let spoiled = withEmail(run, "E007", { proposals: e007, flags: [] });
    spoiled = withEmail(spoiled, "E001", { proposals: e001 });
    const score = scoreRun(expected, spoiled);
    expect(score.creditMismatches).toEqual([
      { emailId: "E001", check: "credit-limit", expectedToFail: false, failed: true },
      { emailId: "E007", check: "credit-limit", expectedToFail: true, failed: false },
    ]);
  });

  it("measures review-reason recall on expected Proposals, counting the gate's failing checks", () => {
    const run = perfectRun(expected);
    let spoiled = withEmail(run, "E007", { flags: [] });
    spoiled = withEmail(spoiled, "E008", { flags: ["P2-short-stock", "P12-past-date"] });
    const score = scoreRun(expected, spoiled);
    expect(score.reviewReasons.perEmail).toEqual([{ emailId: "E008", missing: ["DATE-unmeetable"], extra: ["P12-past-date"] }]);
    expect(score.reviewReasons.expected).toBeGreaterThan(score.reviewReasons.raised);
    expect(score.reviewReasons.raised).toBe(score.reviewReasons.expected - 1);
  });

  it("totals cost and time per email from the run records", () => {
    const score = scoreRun(expected, perfectRun(expected));
    expect(score.cost).toEqual({
      emails: 40,
      modelCalls: 240,
      totalCostMicroUsd: 2_400_000,
      costPerEmailMicroUsd: 60_000,
      totalSeconds: 480,
      secondsPerEmail: 12,
    });
  });

  it("treats an email the run never reached as a mismatch", () => {
    const run = perfectRun(expected).filter((result) => result.emailId !== "E040");
    const score = scoreRun(expected, run);
    expect(score.outcomes.mismatches).toEqual([{ emailId: "E040", expected: "released", actual: "not run" }]);
  });
});
