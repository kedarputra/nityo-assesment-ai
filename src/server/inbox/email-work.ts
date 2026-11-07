import { and, asc, desc, eq, inArray, ne, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { CUT_OFF_ERROR_CLASS, isCutOff } from "@/agent/run-errors";
import type { Database } from "@/db/database";
import {
  agentFlags,
  agentRuns,
  customers,
  draftReplies,
  emailLinks,
  emailNotes,
  inventory,
  products,
  proposalLines,
  proposals,
  routedRequests,
  salesOrderLines,
  shipToAddresses,
  users,
  type AgentRunOutcome,
  type NoActionReason,
  type ProposalKind,
  type ProposalStatus,
  type RecordedCheck,
  type RequestKind,
  type RouteReason,
} from "@/db/schema";

// What the agent did with one email, for the Proposal pane: its latest run and the Request kinds
// it found, the Proposals that run made with their checks, lines and a person's decision, the
// Requests it routed to a person or why it closed the email, its flags, its Draft reply, its notes
// for the reviewer, notes other emails left here, and the emails it is linked with.

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
  // On a change or a cancellation, where `quantity` is the signed change: the target order's
  // line (null for a line added) and its quantity before and after the change.
  orderLineNo: number | null;
  before: number | null;
  after: number | null;
}

// A Proposal this one is linked to (U2): the pending order it follows up, or a follow-up to it.
export interface LinkedProposalView {
  relation: "follows" | "followed-by";
  proposalId: number;
  emailId: string;
  status: ProposalStatus;
  totalCents: number;
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
  kind: ProposalKind;
  status: ProposalStatus;
  soNumber: string | null;
  // The sales order a change or a cancellation applies to.
  targetSoNumber: string | null;
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
  linked: LinkedProposalView[];
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
  // Information another email carries for this one's Requests (U17, U6), whichever run left it.
  notes: { sourceEmailId: string; note: string }[];
  // What the run noted for this email's reviewer that is not a review reason (U5, U8).
  context: string[];
  // The emails this one is linked with, either way round (ticket 08 of the map), each once.
  related: { emailId: string; why: string }[];
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
      kind: proposals.kind,
      status: proposals.status,
      soNumber: proposals.soNumber,
      targetSoNumber: proposals.targetSoNumber,
      followsProposalId: proposals.followsProposalId,
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
            orderLineNo: proposalLines.orderLineNo,
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

  const targetLines = await linesOfTargets(db, proposalRows);
  const linkedRows = await linkedProposals(db, proposalRows);

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
    .where(and(eq(emailNotes.emailId, emailId), ne(emailNotes.sourceEmailId, emailId)))
    .orderBy(asc(emailNotes.id));
  const context = await db
    .select({ note: emailNotes.note })
    .from(emailNotes)
    .where(and(eq(emailNotes.runId, run.runId), eq(emailNotes.emailId, emailId), eq(emailNotes.sourceEmailId, emailId)))
    .orderBy(asc(emailNotes.id));
  const links = await db
    .select({ emailId: emailLinks.emailId, relatedEmailId: emailLinks.relatedEmailId, why: emailLinks.why })
    .from(emailLinks)
    .where(or(eq(emailLinks.runId, run.runId), eq(emailLinks.relatedEmailId, emailId)))
    .orderBy(asc(emailLinks.id));

  return {
    run: isCutOff(run, new Date())
      ? // Cut off with its function: shown as a run that didn't finish, so it can run again.
        { runId: run.runId, finished: true, outcome: "failed", errorClass: CUT_OFF_ERROR_CLASS, requestKinds: run.requestKinds }
      : {
      runId: run.runId,
      finished: run.endedAt !== null,
      outcome: run.outcome,
      errorClass: run.errorClass,
      requestKinds: run.requestKinds,
    },
    proposals: proposalRows.map(({ customerId, decidedBy, decidedAt, decisionReason, followsProposalId, ...proposal }) => ({
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
          orderLineNo: line.orderLineNo,
          ...beforeAndAfter(proposal, line, targetLines),
        })),
      linked: linkedRows.flatMap((other): LinkedProposalView[] => {
        const view = { proposalId: other.id, emailId: other.emailId, status: other.status, totalCents: other.totalCents };
        if (other.id === followsProposalId) return [{ relation: "follows", ...view }];
        if (other.followsProposalId === proposal.id) return [{ relation: "followed-by", ...view }];
        return [];
      }),
    })),
    routed,
    noAction:
      run.noActionReason === null
        ? null
        : { reason: run.noActionReason, note: run.noActionNote ?? "", duplicateOf: run.duplicateOfEmailId },
    flags,
    draftReply: reply ? { body: reply.body, readyBy: reply.readyBy, readyAt: reply.readyAt } : null,
    notes,
    context: context.map((row) => row.note),
    related: relatedEmails(emailId, links),
  };
}

type TargetLine = { soNumber: string; lineNo: number; qtyOrdered: number };

async function linesOfTargets(db: Database, rows: { targetSoNumber: string | null }[]): Promise<TargetLine[]> {
  const targets = [...new Set(rows.flatMap((row) => (row.targetSoNumber === null ? [] : [row.targetSoNumber])))];
  if (targets.length === 0) return [];
  return db
    .select({ soNumber: salesOrderLines.soNumber, lineNo: salesOrderLines.lineNo, qtyOrdered: salesOrderLines.qtyOrdered })
    .from(salesOrderLines)
    .where(inArray(salesOrderLines.soNumber, targets));
}

// The Proposals these follow up, and the ones that follow them up, from any email.
async function linkedProposals(db: Database, rows: { id: number; followsProposalId: number | null }[]) {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const follows = rows.flatMap((row) => (row.followsProposalId === null ? [] : [row.followsProposalId]));
  const linkedTo = follows.length === 0 ? inArray(proposals.followsProposalId, ids) : or(inArray(proposals.followsProposalId, ids), inArray(proposals.id, follows));
  return db
    .select({
      id: proposals.id,
      emailId: proposals.emailId,
      status: proposals.status,
      totalCents: proposals.totalCents,
      followsProposalId: proposals.followsProposalId,
    })
    .from(proposals)
    .where(linkedTo)
    .orderBy(asc(proposals.id));
}

// A change's line before and after. Once it is applied the order shows the "after", so the
// "before" is worked back from it.
function beforeAndAfter(
  proposal: { kind: ProposalKind; status: ProposalStatus; targetSoNumber: string | null },
  line: { orderLineNo: number | null; quantity: number },
  targetLines: TargetLine[],
): { before: number | null; after: number | null } {
  if (proposal.kind === "new order") return { before: null, after: null };
  if (line.orderLineNo === null) return { before: 0, after: line.quantity };
  const current = targetLines.find(
    (candidate) => candidate.soNumber === proposal.targetSoNumber && candidate.lineNo === line.orderLineNo,
  );
  if (!current) return { before: null, after: null };
  const before = proposal.status === "released" ? current.qtyOrdered - line.quantity : current.qtyOrdered;
  return { before, after: before + line.quantity };
}

function relatedEmails(
  emailId: string,
  links: { emailId: string; relatedEmailId: string; why: string }[],
): EmailWork["related"] {
  const related: EmailWork["related"] = [];
  for (const link of links) {
    const other = link.emailId === emailId ? link.relatedEmailId : link.emailId;
    if (!related.some((entry) => entry.emailId === other)) related.push({ emailId: other, why: link.why });
  }
  return related;
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
