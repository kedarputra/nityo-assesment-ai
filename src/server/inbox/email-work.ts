import { asc, desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "@/db/database";
import {
  agentFlags,
  agentRuns,
  customers,
  draftReplies,
  emailNotes,
  inventory,
  products,
  proposalLines,
  proposals,
  routedRequests,
  shipToAddresses,
  users,
  type AgentRunOutcome,
  type NoActionReason,
  type ProposalStatus,
  type RecordedCheck,
  type RequestKind,
  type RouteReason,
} from "@/db/schema";

// What the agent did with one email, for the Proposal pane: its latest run and the Request kinds
// it found, the Proposals that run made with their checks, lines and a person's decision, the
// Requests it routed to a person or why it closed the email, its flags, its Draft reply, and notes
// other emails left here.

export interface ProposalLineView {
  lineNo: number;
  sku: string;
  productName: string | null;
  pack: string | null;
  // The DISCONTINUED product this line replaces, when it is a substitution (policy 3).
  swappedFor: { sku: string; name: string; pack: string; listPriceCents: number } | null;
  quantity: number;
  unitPriceCents: number | null;
  priceSource: "contract" | "list" | null;
  lineTotalCents: number | null;
  // How the customer wrote the line, when the agent kept it; and the stock on the shelf now.
  customerWords: string | null;
  available: number | null;
}

export interface ProposalDecisionView {
  // The person who decided, by username.
  by: string;
  at: Date;
  // The reason a reject or a hold requires; null on an approval.
  reason: string | null;
}

export interface DraftReplyView {
  body: string;
  // Who marked it ready, by username, and when; null while it can still be edited.
  readyBy: string | null;
  readyAt: Date | null;
}

export interface ProposalView {
  id: number;
  status: ProposalStatus;
  soNumber: string | null;
  customerName: string;
  shipToId: string;
  shipToName: string | null;
  requestedDate: string;
  requestedDateWords: string | null;
  requestedDateAlternative: string | null;
  totalCents: number;
  checks: RecordedCheck[];
  lines: ProposalLineView[];
  decision: ProposalDecisionView | null;
  // The customer's own ship-tos, the only ones a person may choose.
  shipToChoices: { shipToId: string; name: string }[];
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
  draftReply: DraftReplyView | null;
  // Information another email carries for this one's Requests (U17), whichever run left it.
  notes: { sourceEmailId: string; note: string }[];
}

const replacedProducts = alias(products, "replaced_products");
const decider = alias(users, "decider");
const replyMarker = alias(users, "reply_marker");

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
      requestedDateWords: proposals.requestedDateWords,
      requestedDateAlternative: proposals.requestedDateAlternative,
      totalCents: proposals.totalCents,
      checks: proposals.checks,
      customerId: proposals.customerId,
      decidedBy: decider.username,
      decidedAt: proposals.decidedAt,
      decisionReason: proposals.decisionReason,
    })
    .from(proposals)
    .innerJoin(customers, eq(customers.customerId, proposals.customerId))
    .leftJoin(shipToAddresses, eq(shipToAddresses.shipToId, proposals.shipToId))
    .leftJoin(decider, eq(decider.id, proposals.decidedBy))
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
            pack: products.pack,
            replacesSku: proposalLines.replacesSku,
            replacedName: replacedProducts.name,
            replacedPack: replacedProducts.pack,
            replacedListPriceCents: replacedProducts.listPriceCents,
            quantity: proposalLines.quantity,
            unitPriceCents: proposalLines.unitPriceCents,
            priceSource: proposalLines.priceSource,
            customerWords: proposalLines.customerWords,
            available: inventory.available,
          })
          .from(proposalLines)
          .leftJoin(products, eq(products.sku, proposalLines.sku))
          .leftJoin(replacedProducts, eq(replacedProducts.sku, proposalLines.replacesSku))
          .leftJoin(inventory, eq(inventory.sku, proposalLines.sku))
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
  const customerIds = [...new Set(proposalRows.map((proposal) => proposal.customerId))];
  const shipTos =
    customerIds.length === 0
      ? []
      : await db
          .select({ customerId: shipToAddresses.customerId, shipToId: shipToAddresses.shipToId, name: shipToAddresses.name })
          .from(shipToAddresses)
          .where(inArray(shipToAddresses.customerId, customerIds))
          .orderBy(asc(shipToAddresses.shipToId));
  const [reply] = await db
    .select({ body: draftReplies.body, readyBy: replyMarker.username, readyAt: draftReplies.readyAt })
    .from(draftReplies)
    .leftJoin(replyMarker, eq(replyMarker.id, draftReplies.readyBy))
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
    proposals: proposalRows.map(({ customerId, decidedBy, decidedAt, decisionReason, ...proposal }) => ({
      ...proposal,
      decision: decidedBy !== null && decidedAt !== null ? { by: decidedBy, at: decidedAt, reason: decisionReason } : null,
      shipToChoices: shipTos
        .filter((shipTo) => shipTo.customerId === customerId)
        .map((shipTo) => ({ shipToId: shipTo.shipToId, name: shipTo.name })),
      lines: lineRows
        .filter((line) => line.proposalId === proposal.id)
        .map((line) => ({
          lineNo: line.lineNo,
          sku: line.sku,
          productName: line.productName,
          pack: line.pack,
          swappedFor: swappedFor(line),
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
          priceSource: line.priceSource,
          lineTotalCents: line.unitPriceCents === null ? null : line.unitPriceCents * line.quantity,
          customerWords: line.customerWords,
          available: line.available,
        })),
    })),
    routed,
    noAction:
      run.noActionReason === null
        ? null
        : { reason: run.noActionReason, note: run.noActionNote ?? "", duplicateOf: run.duplicateOfEmailId },
    flags,
    draftReply: reply ? { body: reply.body, readyBy: reply.readyBy, readyAt: reply.readyAt } : null,
    notes,
  };
}

function swappedFor(line: {
  replacesSku: string | null;
  replacedName: string | null;
  replacedPack: string | null;
  replacedListPriceCents: number | null;
}): ProposalLineView["swappedFor"] {
  if (line.replacesSku === null || line.replacedName === null || line.replacedPack === null || line.replacedListPriceCents === null) {
    return null;
  }
  return { sku: line.replacesSku, name: line.replacedName, pack: line.replacedPack, listPriceCents: line.replacedListPriceCents };
}
