import { readFileSync } from "node:fs";
import path from "node:path";
import { parseCents } from "@/snapshot/data-pack";

// The eval set is the walkthrough itself (issue 11): the scorer reads its summary table and its
// "Eval lines" CSV, so a change to an expected outcome is made in one place, never in code.
export const expectedOutcomesFile = path.join(
  process.cwd(),
  "grilled",
  "hp-1-order-intake",
  "assets",
  "per-email-expected-outcomes.md",
);

export const expectedOutcomeKinds = ["released", "proposal", "routed", "no_action"] as const;
export type ExpectedOutcomeKind = (typeof expectedOutcomeKinds)[number];

export interface ExpectedEmail {
  emailId: string;
  // The email's primary outcome: its first Request's, as the walkthrough counts them.
  outcome: ExpectedOutcomeKind;
  alsoAcceptable: ExpectedOutcomeKind[];
  // Flag codes from the "Review reasons" column, across all of the email's Requests.
  reviewReasons: string[];
}

export interface ExpectedLine {
  emailId: string;
  request: string;
  shipToId: string;
  // More than one when the walkthrough leaves the choice open ("HPS-1001|HPS-1002").
  skus: string[];
  // Negative on a cancellation. A "?" in the CSV (a reading the reply must confirm) is dropped.
  quantity: number;
  unitPriceCents: number;
  outcome: ExpectedOutcomeKind;
}

export interface ExpectedOutcomes {
  emails: ExpectedEmail[];
  lines: ExpectedLine[];
}

export class ExpectedOutcomesError extends Error {
  override name = "ExpectedOutcomesError";
}

export function readExpectedOutcomes(file: string = expectedOutcomesFile): ExpectedOutcomes {
  return parseExpectedOutcomes(readFileSync(file, "utf8"));
}

export function parseExpectedOutcomes(markdown: string): ExpectedOutcomes {
  return { emails: parseSummaryTable(markdown), lines: parseEvalLines(markdown) };
}

function parseSummaryTable(markdown: string): ExpectedEmail[] {
  const rows = tableUnderHeading(markdown, "## Summary");
  if (rows.length === 0) throw new ExpectedOutcomesError("The walkthrough has no summary table under \"## Summary\".");
  const [header, ...body] = rows;
  const column = (name: string): number => {
    const index = header?.indexOf(name) ?? -1;
    if (index < 0) throw new ExpectedOutcomesError(`The summary table has no "${name}" column.`);
    return index;
  };
  const emailColumn = column("Email");
  const outcomeColumn = column("Expected outcome");
  const alsoColumn = column("Also acceptable");
  const reasonsColumn = column("Review reasons");

  return body.map((cells) => {
    const cell = (index: number): string => cells[index] ?? "";
    const emailId = cell(emailColumn);
    if (!/^E\d{3}$/.test(emailId)) throw new ExpectedOutcomesError(`${JSON.stringify(emailId)} is not an email id.`);
    const outcome = leadingOutcome(cell(outcomeColumn));
    if (!outcome) throw new ExpectedOutcomesError(`${emailId}: cannot read the outcome ${JSON.stringify(cell(outcomeColumn))}.`);
    const also = leadingOutcome(cell(alsoColumn));
    return {
      emailId,
      outcome,
      alsoAcceptable: also ? [also] : [],
      reviewReasons: [...cell(reasonsColumn).matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? ""),
    };
  });
}

// "proposal (×3)" → proposal; "proposal; routed" → proposal; "—" → none.
function leadingOutcome(text: string): ExpectedOutcomeKind | null {
  const word = /^(released|proposal|routed|no action)\b/i.exec(text.trim())?.[1]?.toLowerCase();
  switch (word) {
    case "released":
    case "proposal":
    case "routed":
      return word;
    case "no action":
      return "no_action";
    default:
      return null;
  }
}

// The first Markdown table after the heading, as rows of trimmed cells, without its rule row.
function tableUnderHeading(markdown: string, heading: string): string[][] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return [];
  const rows: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) break;
    if (!trimmed.startsWith("|")) {
      if (rows.length > 0) break;
      continue;
    }
    const cells = trimmed.slice(1, trimmed.endsWith("|") ? -1 : undefined).split("|").map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    rows.push(cells);
  }
  return rows;
}

const evalLinesColumns = ["email_id", "request", "ship_to_id", "sku", "qty", "unit_price", "line_total", "outcome"];

function parseEvalLines(markdown: string): ExpectedLine[] {
  const section = markdown.split("\n## Eval lines")[1];
  const csv = section && /```csv\n([\s\S]*?)```/.exec(section)?.[1];
  if (!csv) throw new ExpectedOutcomesError("The walkthrough has no ```csv block under \"## Eval lines\".");
  const [header, ...rows] = csv.split("\n").filter((line) => line.trim() !== "");
  if (header?.trim() !== evalLinesColumns.join(",")) {
    throw new ExpectedOutcomesError(`The Eval lines header is ${JSON.stringify(header)}, not ${evalLinesColumns.join(",")}.`);
  }
  return rows.map((row) => {
    // No field in the CSV is quoted or holds a comma, so a plain split is exact.
    const fields = row.split(",").map((field) => field.trim());
    if (fields.length !== evalLinesColumns.length) throw new ExpectedOutcomesError(`Eval line ${JSON.stringify(row)} has ${fields.length} fields.`);
    const [emailId = "", request = "", shipToId = "", skus = "", qty = "", unitPrice = "", , outcome = ""] = fields;
    const quantity = qty.replace(/\?$/, "");
    if (!/^-?\d+$/.test(quantity)) throw new ExpectedOutcomesError(`Eval line ${JSON.stringify(row)}: ${qty} is not a quantity.`);
    const lineOutcome = leadingOutcome(outcome);
    if (lineOutcome !== "released" && lineOutcome !== "proposal") {
      throw new ExpectedOutcomesError(`Eval line ${JSON.stringify(row)}: the outcome must be released or proposal.`);
    }
    return {
      emailId,
      request,
      shipToId,
      skus: skus.split("|"),
      quantity: Number(quantity),
      unitPriceCents: parseCents(unitPrice),
      outcome: lineOutcome,
    };
  });
}
