import { asc, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "@/db/database";
import {
  agentFlags,
  agentRuns,
  customers,
  draftReplies,
  emailNotes,
  products,
  proposalLines,
  proposals,
  routedRequests,
  shipToAddresses,
  type AgentRunOutcome,
  type NoActionReason,
  type ProposalStatus,
  type RecordedCheck,
  type RequestKind,
  type RouteReason,
} from "@/db/schema";

// What the agent did with one email, for the Proposal pane: its latest run and the Request kinds
// it found, the Proposals that run made with their checks and lines, the Requests it routed to a
// person or why it closed the email, its flags, its Draft reply, and notes other emails left here.

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

export interface RoutedRequestView {
  kind: RequestKind;
  reason: RouteReason;
  summary: string;
}

export interface NoActionView {
  reason: NoActionReason;
  note: string;
  // The email a duplicate repeats.
  duplicateOf: string | null;
}

export interface EmailWork {
  run: {
    runId: string;
    finished: boolean;
    outcome: AgentRunOutcome | null;
    errorClass: string | null;
    requestKinds: RequestKind[];
  };
  proposals: ProposalView[];
  routed: RoutedRequestView[];
  noAction: NoActionView | null;
  flags: { code: string; note: string }[];
  draftReply: string | null;
  // Information another email carries for this one's Requests (U17), whichever run left it.
  notes: { sourceEmailId: string; note: string }[];
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

  const routed = await db
    .select({ kind: routedRequests.kind, reason: routedRequests.reason, summary: routedRequests.summary })
    .from(routedRequests)
    .where(eq(routedRequests.runId, run.runId))
    .orderBy(asc(routedRequests.id));
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
  const notes = await db
    .select({ sourceEmailId: emailNotes.sourceEmailId, note: emailNotes.note })
    .from(emailNotes)
    .where(eq(emailNotes.emailId, emailId))
    .orderBy(asc(emailNotes.id));

  return {
    run: {
      runId: run.runId,
      finished: run.endedAt !== null,
      outcome: run.outcome,
      errorClass: run.errorClass,
      requestKinds: run.requestKinds,
    },
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
    routed,
    noAction:
      run.noActionReason === null
        ? null
        : { reason: run.noActionReason, note: run.noActionNote ?? "", duplicateOf: run.duplicateOfEmailId },
    flags,
    draftReply: reply?.body ?? null,
    notes,
  };
}
