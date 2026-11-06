import { describe, expect, it } from "vitest";
import { evalReport } from "./report";
import type { EmailRunResult, RunScore } from "./score";

function score(change: Partial<RunScore> = {}): RunScore {
  return {
    unsafeReleases: [],
    outcomes: { emails: 40, matches: 36, accuracy: 0.9, missedReleases: [], mismatches: [] },
    lines: { expected: 77, proposed: 70, matched: 63, precision: 0.9, recall: 63 / 77, missing: [], extra: [] },
    priceMismatches: [],
    creditMismatches: [],
    reviewReasons: { expected: 40, raised: 30, recall: 0.75, perEmail: [] },
    cost: {
      emails: 40,
      modelCalls: 240,
      totalCostMicroUsd: 2_400_000,
      costPerEmailMicroUsd: 60_000,
      totalSeconds: 480,
      secondsPerEmail: 12,
    },
    ...change,
  };
}

const e001: EmailRunResult = {
  emailId: "E001",
  outcome: "released",
  errorClass: null,
  flags: [],
  proposals: [],
  modelCalls: 9,
  inputTokens: 9_000,
  outputTokens: 1_800,
  costMicroUsd: 72_000,
  seconds: 14.25,
};

const header = { modelId: "claude-opus-5-5", startedAt: new Date("2026-11-06T09:00:00Z") };

describe("the eval report", () => {
  it("puts the unsafe releases first, with each email and reason, before any other section", () => {
    const report = evalReport({
      ...header,
      rounds: [
        { score: score(), results: [e001] },
        {
          score: score({
            unsafeReleases: [{ emailId: "E006", expected: "proposal", actual: "released", reason: "expected proposal: HARD-credit-limit" }],
          }),
          results: [e001],
        },
      ],
    });

    const unsafe = report.indexOf("## Unsafe releases");
    expect(unsafe).toBeGreaterThan(0);
    for (const later of ["## Summary", "## Run 1", "## Run 2"]) expect(report.indexOf(later)).toBeGreaterThan(unsafe);
    expect(report).toContain("| 2 | E006 | proposal | released | expected proposal: HARD-credit-limit |");
  });

  it("says there were none when no run released unsafely", () => {
    const report = evalReport({ ...header, rounds: [{ score: score(), results: [e001] }] });
    expect(report).toContain("None in 1 run (target 0).");
  });

  it("reports each metric per run with its spread across runs", () => {
    const report = evalReport({
      ...header,
      rounds: [
        { score: score(), results: [e001] },
        { score: score({ outcomes: { emails: 40, matches: 30, accuracy: 0.75, missedReleases: [], mismatches: [] } }), results: [e001] },
        { score: score(), results: [e001] },
      ],
    });
    expect(report).toContain("| Metric | Run 1 | Run 2 | Run 3 | Spread (min–max) |");
    expect(report).toContain("| Outcome accuracy | 90.0% (36/40) | 75.0% (30/40) | 90.0% (36/40) | 75.0%–90.0% |");
    expect(report).toContain("| Cost per email | $0.0600 | $0.0600 | $0.0600 | $0.0600–$0.0600 |");
  });

  it("lists every mismatch with its email, and cost and time per email", () => {
    const report = evalReport({
      ...header,
      rounds: [
        {
          score: score({
            outcomes: {
              emails: 40,
              matches: 38,
              accuracy: 0.95,
              missedReleases: [{ emailId: "E040", expected: "released", actual: "proposal" }],
              mismatches: [{ emailId: "E009", expected: "routed", actual: "failed (call-cap)" }],
            },
            lines: {
              ...score().lines,
              missing: [{ emailId: "E001", shipToId: "S001", sku: "HPS-1402", quantity: 6 }],
              extra: [{ emailId: "E001", shipToId: "S001", sku: "HPS-1402", quantity: 5 }],
            },
            priceMismatches: [{ emailId: "E001", sku: "HPS-1408", expectedCents: 4500, actualCents: 4400 }],
            creditMismatches: [{ emailId: "E007", check: "credit-limit", expectedToFail: true, failed: false }],
            reviewReasons: { ...score().reviewReasons, perEmail: [{ emailId: "E008", missing: ["DATE-unmeetable"], extra: ["P12-past-date"] }] },
          }),
          results: [e001],
        },
      ],
    });
    expect(report).toContain("| E040 | released | proposal |");
    expect(report).toContain("| E009 | routed | failed (call-cap) |");
    expect(report).toContain("| E001 | missing | S001 | HPS-1402 | 6 |");
    expect(report).toContain("| E001 | extra | S001 | HPS-1402 | 5 |");
    expect(report).toContain("| E001 | HPS-1408 | $45.00 | $44.00 |");
    expect(report).toContain("| E007 | credit-limit | fails | passes |");
    expect(report).toContain("| E008 | DATE-unmeetable | P12-past-date |");
    expect(report).toContain("| E001 | released | 9 | 9000 | 1800 | $0.0720 | 14.3 |");
  });
});
