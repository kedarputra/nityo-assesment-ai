import { asc, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "@/db/database";
import {
  agentFlags,
  agentRuns,
  customers,
  draftReplies,
  products,
  proposalLines,
  proposals,
  shipToAddresses,
  type AgentRunOutcome,
  type ProposalStatus,
  type RecordedCheck,
} from "@/db/schema";

// What the agent did with one email, for the Proposal pane: its latest run, the Proposals that
// run made with their checks and lines, its flags and its Draft reply.

export interface ProposalLineView {
  lineNo: number;
  sku: string;
  productName: string | null;
  quantity: number;
  unitPriceCents: number | null;
  priceSource: "contract" | "list" | null;
  lineTotalCents: number | null;
}

export interface ProposalView {
  id: number;
  status: ProposalStatus;
  soNumber: string | null;
  customerName: string;
  shipToId: string;
  shipToName: string | null;
  requestedDate: string;
  totalCents: number;
  checks: RecordedCheck[];
  lines: ProposalLineView[];
}

export interface EmailWork {
  run: { runId: string; finished: boolean; outcome: AgentRunOutcome | null; errorClass: string | null };
  proposals: ProposalView[];
  flags: { code: string; note: string }[];
  draftReply: string | null;
}

export async function findEmailWork(db: Database, emailId: string): Promise<EmailWork | null> {
  const [run] = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.emailId, emailId))
    .orderBy(desc(agentRuns.startedAt))
    .limit(1);
  if (!run) return null;

  const proposalRows = await db
    .select({
      id: proposals.id,
      status: proposals.status,
      soNumber: proposals.soNumber,
      customerName: customers.name,
      shipToId: proposals.shipToId,
      shipToName: shipToAddresses.name,
      requestedDate: proposals.requestedDate,
      totalCents: proposals.totalCents,
      checks: proposals.checks,
    })
    .from(proposals)
    .innerJoin(customers, eq(customers.customerId, proposals.customerId))
    .leftJoin(shipToAddresses, eq(shipToAddresses.shipToId, proposals.shipToId))
    .where(eq(proposals.runId, run.runId))
    .orderBy(asc(proposals.id));
  const lineRows =
    proposalRows.length === 0
      ? []
      : await db
          .select({
            proposalId: proposalLines.proposalId,
            lineNo: proposalLines.lineNo,
            sku: proposalLines.sku,
            productName: products.name,
            quantity: proposalLines.quantity,
            unitPriceCents: proposalLines.unitPriceCents,
            priceSource: proposalLines.priceSource,
          })
          .from(proposalLines)
          .leftJoin(products, eq(products.sku, proposalLines.sku))
          .where(
            inArray(
              proposalLines.proposalId,
              proposalRows.map((proposal) => proposal.id),
            ),
          )
          .orderBy(asc(proposalLines.proposalId), asc(proposalLines.lineNo));

  const flags = await db
    .select({ code: agentFlags.code, note: agentFlags.note })
    .from(agentFlags)
    .where(eq(agentFlags.runId, run.runId))
    .orderBy(asc(agentFlags.id));
  const [reply] = await db
    .select({ body: draftReplies.body })
    .from(draftReplies)
    .where(eq(draftReplies.runId, run.runId))
    .orderBy(desc(draftReplies.id))
    .limit(1);

  return {
    run: { runId: run.runId, finished: run.endedAt !== null, outcome: run.outcome, errorClass: run.errorClass },
    proposals: proposalRows.map((proposal) => ({
      ...proposal,
      lines: lineRows
        .filter((line) => line.proposalId === proposal.id)
        .map((line) => ({
          lineNo: line.lineNo,
          sku: line.sku,
          productName: line.productName,
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
          priceSource: line.priceSource,
          lineTotalCents: line.unitPriceCents === null ? null : line.unitPriceCents * line.quantity,
        })),
    })),
    flags,
    draftReply: reply?.body ?? null,
  };
}
