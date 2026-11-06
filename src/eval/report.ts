import { formatUsd } from "@/lib/money";
import type { EmailRunResult, RunScore } from "./score";

// The eval's Markdown report, for docs/results.md. Unsafe releases come first because they are
// the metric the release gate exists for (issue 11); then each metric per run with its spread,
// because the results report the spread over three runs, never the best one.

export interface EvalRound {
  score: RunScore;
  results: EmailRunResult[];
}

export interface EvalReportInput {
  modelId: string;
  startedAt: Date;
  rounds: EvalRound[];
}

interface Metric {
  name: string;
  value: (score: RunScore) => number;
  cell: (score: RunScore) => string;
  format: (value: number) => string;
}

const metrics: Metric[] = [
  count("Unsafe releases (target 0)", (score) => score.unsafeReleases.length),
  {
    name: "Outcome accuracy",
    value: (score) => score.outcomes.accuracy,
    cell: (score) => `${percent(score.outcomes.accuracy)} (${score.outcomes.matches}/${score.outcomes.emails})`,
    format: percent,
  },
  count("Missed releases", (score) => score.outcomes.missedReleases.length),
  count("Outcome mismatches", (score) => score.outcomes.mismatches.length),
  {
    name: "Line precision",
    value: (score) => score.lines.precision,
    cell: (score) => `${percent(score.lines.precision)} (${score.lines.matched}/${score.lines.proposed})`,
    format: percent,
  },
  {
    name: "Line recall",
    value: (score) => score.lines.recall,
    cell: (score) => `${percent(score.lines.recall)} (${score.lines.matched}/${score.lines.expected})`,
    format: percent,
  },
  count("Price mismatches", (score) => score.priceMismatches.length),
  count("Credit mismatches", (score) => score.creditMismatches.length),
  {
    name: "Review-reason recall",
    value: (score) => score.reviewReasons.recall,
    cell: (score) =>
      `${percent(score.reviewReasons.recall)} (${score.reviewReasons.raised}/${score.reviewReasons.expected})`,
    format: percent,
  },
  plain("Model calls per email", (score) => ratio(score.cost.modelCalls, score.cost.emails), (value) => value.toFixed(1)),
  plain("Cost per email", (score) => score.cost.costPerEmailMicroUsd, microUsd),
  plain("Seconds per email", (score) => score.cost.secondsPerEmail, (value) => value.toFixed(1)),
  plain("Total cost", (score) => score.cost.totalCostMicroUsd, microUsd),
];

export function evalReport({ modelId, startedAt, rounds }: EvalReportInput): string {
  const runs = rounds.length === 1 ? "1 run" : `${rounds.length} runs`;
  return [
    "# Eval report",
    "",
    `Model \`${modelId}\`, ${runs}, started ${startedAt.toISOString()}. Scored against ` +
      "`grilled/hp-1-order-intake/assets/per-email-expected-outcomes.md`. Draft replies are not " +
      "scored: a person reads them (issue 11).",
    "",
    ...unsafeReleasesSection(rounds, runs),
    ...summarySection(rounds),
    ...rounds.flatMap((round, index) => runSection(round, index + 1)),
  ].join("\n");
}

function unsafeReleasesSection(rounds: EvalRound[], runs: string): string[] {
  const rows = rounds.flatMap((round, index) =>
    round.score.unsafeReleases.map((unsafe) => [String(index + 1), unsafe.emailId, unsafe.expected, unsafe.actual, unsafe.reason]),
  );
  return [
    "## Unsafe releases",
    "",
    ...(rows.length === 0
      ? [`None in ${runs} (target 0).`, ""]
      : table(["Run", "Email", "Expected", "Run did", "Why it should not have released"], rows)),
  ];
}

function summarySection(rounds: EvalRound[]): string[] {
  const header = ["Metric", ...rounds.map((_, index) => `Run ${index + 1}`), "Spread (min–max)"];
  const rows = metrics.map((metric) => {
    const values = rounds.map((round) => metric.value(round.score));
    const spread = `${metric.format(Math.min(...values))}–${metric.format(Math.max(...values))}`;
    return [metric.name, ...rounds.map((round) => metric.cell(round.score)), spread];
  });
  return ["## Summary", "", ...table(header, rows)];
}

function runSection({ score, results }: EvalRound, run: number): string[] {
  return [
    `## Run ${run}`,
    "",
    "### Outcomes",
    "",
    `What the run did: ${outcomeCounts(results)}. Matches ${score.outcomes.matches} of ${score.outcomes.emails}, ` +
      "an also-acceptable outcome counting as a match.",
    "",
    "Missed releases (expected released, sent to a person; lost automation, not errors):",
    "",
    ...tableOrNone(
      ["Email", "Expected", "Run did"],
      score.outcomes.missedReleases.map((miss) => [miss.emailId, miss.expected, miss.actual]),
    ),
    "Mismatches:",
    "",
    ...tableOrNone(
      ["Email", "Expected", "Run did"],
      score.outcomes.mismatches.map((miss) => [miss.emailId, miss.expected, miss.actual]),
    ),
    "### Lines",
    "",
    `Matched by SKU, quantity and ship-to: precision ${percent(score.lines.precision)}, recall ${percent(score.lines.recall)}.`,
    "",
    ...tableOrNone(["Email", "Line", "Ship-to", "SKU", "Qty"], [
      ...score.lines.missing.map((line) => [line.emailId, "missing", line.shipToId, line.sku, String(line.quantity)]),
      ...score.lines.extra.map((line) => [line.emailId, "extra", line.shipToId, line.sku, String(line.quantity)]),
    ]),
    "### Prices and credit",
    "",
    "Both come from code, so any difference here is a bug, not a model error.",
    "",
    ...tableOrNone(
      ["Email", "SKU", "Expected", "Run priced"],
      score.priceMismatches.map((miss) => [
        miss.emailId,
        miss.sku,
        formatUsd(miss.expectedCents),
        miss.actualCents === null ? "no price" : formatUsd(miss.actualCents),
      ]),
    ),
    ...tableOrNone(
      ["Email", "Check", "Expected", "Gate"],
      score.creditMismatches.map((miss) => [miss.emailId, miss.check, passOrFail(miss.expectedToFail), passOrFail(miss.failed)]),
    ),
    "### Review reasons",
    "",
    `On expected Proposals, the run raised ${score.reviewReasons.raised} of ${score.reviewReasons.expected} expected ` +
      `flags (recall ${percent(score.reviewReasons.recall)}).`,
    "",
    ...tableOrNone(
      ["Email", "Missing", "Extra"],
      score.reviewReasons.perEmail.map((miss) => [miss.emailId, miss.missing.join(", "), miss.extra.join(", ")]),
    ),
    "### Cost and time per email",
    "",
    ...table(
      ["Email", "Outcome", "Model calls", "Input tokens", "Output tokens", "Cost", "Seconds"],
      results.map((result) => [
        result.emailId,
        result.outcome ?? "not run",
        String(result.modelCalls),
        String(result.inputTokens),
        String(result.outputTokens),
        microUsd(result.costMicroUsd),
        result.seconds.toFixed(1),
      ]),
    ),
  ];
}

function outcomeCounts(results: EmailRunResult[]): string {
  const counts = new Map<string, number>();
  for (const result of results) {
    const outcome = result.outcome ?? "not run";
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  }
  return [...counts].map(([outcome, total]) => `${outcome} ${total}`).join(", ");
}

function table(header: string[], rows: string[][]): string[] {
  const line = (cells: string[]) => `| ${cells.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line), ""];
}

function tableOrNone(header: string[], rows: string[][]): string[] {
  return rows.length === 0 ? ["None.", ""] : table(header, rows);
}

function count(name: string, value: (score: RunScore) => number): Metric {
  return plain(name, value, String);
}

function plain(name: string, value: (score: RunScore) => number, format: (value: number) => string): Metric {
  return { name, value, cell: (score) => format(value(score)), format };
}

function passOrFail(fails: boolean): string {
  return fails ? "fails" : "passes";
}

function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

// Cost is kept in integer micro-dollars; a cent is too coarse for one email.
function microUsd(micro: number): string {
  return `$${(micro / 1_000_000).toFixed(4)}`;
}

function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}
