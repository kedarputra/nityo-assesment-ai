import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/agent/audit";
import { applyChange, changesToRecheck, checkChange, storeRecheckedChange, targetOrder, type ChangeKind } from "@/agent/change-gate";
import { isHardRule } from "@/agent/release-checks";
import { checkOrder, lockReleases, releaseOrder, sellableLines, withdrawOrder } from "@/agent/release-gate";
import type { Database } from "@/db/database";
import {
  agentRuns,
  customers,
  draftReplies,
  emails,
  products,
  proposalLines,
  proposals,
  shipToAddresses,
  type ProposalKind,
  type RecordedCheck,
} from "@/db/schema";
import { businessDateOf } from "@/lib/business-clock";

// A person's decisions on a Proposal (charting, approve, edit and override): every approve or
// edit re-runs the release checks; a soft check is overridden only with a note; a hard rule can
// only be rejected or held. Each decision and its audit events commit in one transaction. A change
// or a cancellation of an existing order is decided the same way, and approving it applies it.

// The decision cannot be made: the Proposal is already decided, the edit is not allowed, or the
// Undo window has passed. Nothing was changed.
export class ReviewRefused extends Error {
  override name = "ReviewRefused";
}

// How long after approving a person may take the release back (DESIGN.md, "Toast").
export const UNDO_WINDOW_MS = 10_000;

const NOTE_CHARS = 500;
export const decisionNote = z.string().trim().min(1).max(NOTE_CHARS);

interface Decision {
  proposalId: number;
  userId: number;
  at: Date;
}

type ProposalRow = typeof proposals.$inferSelect;

interface ProposalUnderReview {
  proposal: ProposalRow;
  senderEmail: string;
  orderDate: string;
}

// The Proposal with the email it came from, locked against every other release. Only an open or
// held Proposal can be decided or edited.
async function decidableProposal(tx: Database, proposalId: number): Promise<ProposalUnderReview> {
  await lockReleases(tx);
  const [row] = await tx
    .select({ proposal: proposals, senderEmail: emails.fromEmail, receivedAt: emails.receivedAt })
    .from(proposals)
    .innerJoin(emails, eq(emails.emailId, proposals.emailId))
    .where(eq(proposals.id, proposalId));
  if (!row) throw new ReviewRefused("That Proposal doesn’t exist.");
  if (row.proposal.status !== "open" && row.proposal.status !== "held") {
    throw new ReviewRefused(`This Proposal is already ${row.proposal.status}.`);
  }
  return { proposal: row.proposal, senderEmail: row.senderEmail, orderDate: businessDateOf(row.receivedAt) };
}

// Re-runs every check on the Proposal as it is stored now, keeps the system's prices and the
// checks on it, and records the gate's verdict.
async function recheck(tx: Database, { proposal, senderEmail, orderDate }: ProposalUnderReview, at: Date) {
  const stored = await tx
    .select()
    .from(proposalLines)
    .where(eq(proposalLines.proposalId, proposal.id))
    .orderBy(asc(proposalLines.lineNo));
  const checked = await checkOrder(tx, {
    runId: proposal.runId,
    emailId: proposal.emailId,
    senderEmail,
    orderDate,
    customerId: proposal.customerId,
    shipToId: proposal.shipToId,
    requestedDate: proposal.requestedDate,
    requestedDateWords: proposal.requestedDateWords,
    lines: stored.map((line) => ({
      sku: line.sku,
      quantity: line.quantity,
      statedUnitPriceCents: line.statedPriceCents,
      customerWords: line.customerWords,
      productSearchId: line.productSearchId,
      // How the customer wrote a unit is not kept on the line, so a re-run reads whole selling units.
      unitAsWritten: null,
      quantityAsWritten: null,
      replacesSku: line.replacesSku,
      fromSalesOrder: line.fromSalesOrder,
    })),
  });

  for (const [index, line] of checked.lines.entries()) {
    const storedLine = stored[index];
    if (!storedLine) continue;
    await tx
      .update(proposalLines)
      .set({ unitPriceCents: line.price?.unitPriceCents ?? null, priceSource: line.price?.source ?? null })
      .where(and(eq(proposalLines.proposalId, proposal.id), eq(proposalLines.lineNo, storedLine.lineNo)));
  }
  await tx
    .update(proposals)
    .set({ checks: checked.checks, totalCents: checked.totalCents })
    .where(eq(proposals.id, proposal.id));
  const failing = await recordRecheck(tx, proposal, checked, at);
  return { ...checked, failing };
}

// A change or a cancellation re-checked against its sales order as it stands now.
async function recheckChange(tx: Database, { proposal, senderEmail, orderDate }: ProposalUnderReview, kind: ChangeKind, at: Date) {
  if (proposal.targetSoNumber === null) throw new Error(`Proposal ${proposal.id} is a ${kind} with no sales order.`);
  const target = await targetOrder(tx, proposal.targetSoNumber);
  const checked = await checkChange(tx, {
    runId: proposal.runId,
    emailId: proposal.emailId,
    senderEmail,
    orderDate,
    kind,
    target,
    changes: await changesToRecheck(tx, { id: proposal.id, kind }, target),
  });
  await storeRecheckedChange(tx, proposal.id, checked);
  const failing = await recordRecheck(tx, proposal, checked, at);
  return { ...checked, target, failing };
}

async function recordRecheck(
  tx: Database,
  proposal: ProposalRow,
  checked: { totalCents: number; checks: RecordedCheck[] },
  at: Date,
): Promise<RecordedCheck[]> {
  const failing = checked.checks.filter((check) => !check.passes);
  await recordAudit(tx, {
    at,
    actor: "gate",
    action: "gate.verdict",
    emailId: proposal.emailId,
    runId: proposal.runId,
    detail: {
      proposalId: proposal.id,
      recheck: true,
      verdict: failing.length === 0 ? "released" : "review",
      totalCents: checked.totalCents,
      failing,
    },
  });
  return failing;
}

export type ApproveResult =
  | { released: true; kind: ProposalKind; emailId: string; soNumber: string; totalCents: number; customerName: string }
  | { released: false; hardRules: RecordedCheck[]; missingNotes: string[] };

// Approve & release: the checks re-run first. A failing hard rule refuses the approval, whatever
// notes came with it; a failing soft check needs its note. The re-run checks are kept either way.
// A new order is released; a change or a cancellation is applied to its sales order.
export async function approveProposal(
  db: Database,
  decision: Decision & { notes: Readonly<Record<string, string>> },
): Promise<ApproveResult> {
  return db.transaction(async (tx) => {
    const underReview = await decidableProposal(tx, decision.proposalId);
    const { proposal } = underReview;
    const { kind } = proposal;
    const checked =
      kind === "new order"
        ? { kind, ...(await recheck(tx, underReview, decision.at)) }
        : { kind, ...(await recheckChange(tx, underReview, kind, decision.at)) };
    const audit = { at: decision.at, emailId: proposal.emailId, runId: proposal.runId, userId: decision.userId };

    const hardRules = checked.failing.filter((check) => isHardRule(check.check));
    const overrides = checked.failing.filter((check) => !isHardRule(check.check));
    const missingNotes = overrides
      .filter((check) => !decisionNote.safeParse(decision.notes[check.check] ?? "").success)
      .map((check) => check.check);
    if (hardRules.length > 0 || missingNotes.length > 0) {
      await recordAudit(tx, {
        ...audit,
        actor: "person",
        action: "proposal.approval_refused",
        detail: { proposalId: proposal.id, hardRules: hardRules.map((check) => check.check), missingNotes },
      });
      return { released: false, hardRules, missingNotes };
    }

    for (const check of overrides) {
      await recordAudit(tx, {
        ...audit,
        actor: "person",
        action: "proposal.override",
        detail: {
          proposalId: proposal.id,
          check: check.check,
          failing: check.detail,
          note: decisionNote.parse(decision.notes[check.check]),
        },
      });
    }
    let soNumber: string;
    let allocated: { sku: string; quantity: number }[];
    if (checked.kind !== "new order") {
      soNumber = checked.target.order.soNumber;
      allocated = await applyChange(tx, checked.kind, checked.target, checked.lines);
    } else {
      soNumber = await releaseOrder(tx, {
        proposalId: proposal.id,
        customerId: proposal.customerId,
        shipToId: proposal.shipToId,
        customerPo: proposal.customerPo,
        requestedDate: proposal.requestedDate,
        orderDate: underReview.orderDate,
        lines: sellableLines(checked.lines),
      });
      allocated = checked.lines.map((line) => ({ sku: line.sku, quantity: line.quantity }));
    }
    await tx
      .update(proposals)
      .set({ status: "released", decidedBy: decision.userId, decidedAt: decision.at, decisionReason: null })
      .where(eq(proposals.id, proposal.id));
    await recordAudit(tx, {
      ...audit,
      actor: "person",
      action: "proposal.approved",
      detail: {
        proposalId: proposal.id,
        kind,
        soNumber,
        totalCents: checked.totalCents,
        overridden: overrides.map((check) => check.check),
        allocated,
      },
    });
    const [customer] = await tx
      .select({ name: customers.name })
      .from(customers)
      .where(eq(customers.customerId, proposal.customerId));
    return {
      released: true,
      kind,
      emailId: proposal.emailId,
      soNumber,
      totalCents: checked.totalCents,
      customerName: customer?.name ?? proposal.customerId,
    };
  });
}

export type SetAsideKind = "reject" | "hold";

// Reject… and Put on hold… each need a reason, which is kept on the Proposal and in the audit log.
// Either is open to a hard-rule Proposal; rejecting a held one is allowed, holding it again is not.
export async function setProposalAside(
  db: Database,
  decision: Decision & { kind: SetAsideKind; reason: string },
): Promise<{ emailId: string }> {
  const parsed = decisionNote.safeParse(decision.reason);
  if (!parsed.success) throw new ReviewRefused("Add a short note so the team knows why.");
  return db.transaction(async (tx) => {
    const { proposal } = await decidableProposal(tx, decision.proposalId);
    if (decision.kind === "hold" && proposal.status === "held") {
      throw new ReviewRefused("This Proposal is already on hold.");
    }
    const status = decision.kind === "reject" ? "rejected" : "held";
    await tx
      .update(proposals)
      .set({ status, decidedBy: decision.userId, decidedAt: decision.at, decisionReason: parsed.data })
      .where(eq(proposals.id, proposal.id));
    await recordAudit(tx, {
      at: decision.at,
      actor: "person",
      userId: decision.userId,
      action: decision.kind === "reject" ? "proposal.rejected" : "proposal.held",
      emailId: proposal.emailId,
      runId: proposal.runId,
      detail: { proposalId: proposal.id, reason: parsed.data },
    });
    return { emailId: proposal.emailId };
  });
}

// Undo, within 10 seconds of approving and only by the person who approved: the sales order is
// withdrawn, its stock returned, and the Proposal is open again. After that the release is final.
export async function undoRelease(db: Database, decision: Decision): Promise<{ soNumber: string; emailId: string }> {
  return db.transaction(async (tx) => {
    await lockReleases(tx);
    const [proposal] = await tx.select().from(proposals).where(eq(proposals.id, decision.proposalId));
    if (!proposal || proposal.status !== "released" || proposal.soNumber === null) {
      throw new ReviewRefused("There is no release to undo.");
    }
    if (proposal.decidedBy !== decision.userId || proposal.decidedAt === null) {
      throw new ReviewRefused("Only the person who approved this can undo it.");
    }
    if (decision.at.getTime() - proposal.decidedAt.getTime() > UNDO_WINDOW_MS) {
      throw new ReviewRefused(`${proposal.soNumber} is final: the 10 seconds to undo it have passed.`);
    }
    const soNumber = proposal.soNumber;
    const returned = await withdrawOrder(tx, soNumber);
    await tx
      .update(proposals)
      .set({ status: "open", decidedBy: null, decidedAt: null, decisionReason: null })
      .where(eq(proposals.id, proposal.id));
    await recordAudit(tx, {
      at: decision.at,
      actor: "person",
      userId: decision.userId,
      action: "release.undone",
      emailId: proposal.emailId,
      runId: proposal.runId,
      detail: { proposalId: proposal.id, soNumber, returned },
    });
    return { soNumber, emailId: proposal.emailId };
  });
}

const lineNo = z.number().int().positive();
const sku = z.string().trim().min(1).max(20);
const quantity = z.number().int().positive().max(100_000);

// What a person may change on a Proposal (What the ops review UI looks like): a line's quantity,
// its SKU, adding or removing a line, and the ship-to. Never the price or the customer, so the
// schema has no field for either.
export const proposalEdit = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("quantity"), lineNo, quantity }),
  z.strictObject({ kind: z.literal("sku"), lineNo, sku }),
  z.strictObject({ kind: z.literal("add-line"), sku, quantity }),
  z.strictObject({ kind: z.literal("remove-line"), lineNo }),
  z.strictObject({ kind: z.literal("ship-to"), shipToId: z.string().trim().min(1).max(20) }),
]);
export type ProposalEdit = z.infer<typeof proposalEdit>;

// Applies one edit, records it, and re-runs the checks at once. It never releases: only Approve does.
export async function editProposal(
  db: Database,
  decision: Decision & { edit: ProposalEdit },
): Promise<RecordedCheck[]> {
  const edit = proposalEdit.parse(decision.edit);
  return db.transaction(async (tx) => {
    const underReview = await decidableProposal(tx, decision.proposalId);
    const { proposal } = underReview;
    if (proposal.kind !== "new order") {
      throw new ReviewRefused(`A ${proposal.kind} can’t be edited here. Reject it, and say in the reply what we can do.`);
    }
    const before = await applyEdit(tx, proposal, edit);
    await recordAudit(tx, {
      at: decision.at,
      actor: "person",
      userId: decision.userId,
      action: "proposal.edited",
      emailId: proposal.emailId,
      runId: proposal.runId,
      detail: { proposalId: proposal.id, edit, before },
    });
    const { checks } = await recheck(tx, underReview, decision.at);
    return checks;
  });
}

// Returns what the edit replaced, for the audit log.
async function applyEdit(tx: Database, proposal: ProposalRow, edit: ProposalEdit): Promise<unknown> {
  const lines = await tx
    .select()
    .from(proposalLines)
    .where(eq(proposalLines.proposalId, proposal.id))
    .orderBy(asc(proposalLines.lineNo));
  const thisLine = (wanted: number) => and(eq(proposalLines.proposalId, proposal.id), eq(proposalLines.lineNo, wanted));
  const findLine = (wanted: number) => {
    const line = lines.find((candidate) => candidate.lineNo === wanted);
    if (!line) throw new ReviewRefused(`This Proposal has no line ${wanted}.`);
    return line;
  };

  switch (edit.kind) {
    case "quantity": {
      const line = findLine(edit.lineNo);
      await tx.update(proposalLines).set({ quantity: edit.quantity }).where(thisLine(edit.lineNo));
      return { sku: line.sku, quantity: line.quantity };
    }
    case "sku": {
      const line = findLine(edit.lineNo);
      await requireProduct(tx, edit.sku);
      // A price the customer stated was for the old product, so it no longer applies.
      await tx.update(proposalLines).set({ sku: edit.sku, statedPriceCents: null }).where(thisLine(edit.lineNo));
      return { sku: line.sku, quantity: line.quantity };
    }
    case "add-line": {
      await requireProduct(tx, edit.sku);
      const next = lines.reduce((max, line) => Math.max(max, line.lineNo), 0) + 1;
      await tx.insert(proposalLines).values({
        proposalId: proposal.id,
        lineNo: next,
        sku: edit.sku,
        quantity: edit.quantity,
        unitPriceCents: null,
        priceSource: null,
        statedPriceCents: null,
        customerWords: null,
      });
      return null;
    }
    case "remove-line": {
      const line = findLine(edit.lineNo);
      if (lines.length === 1) throw new ReviewRefused("An order needs at least one line. Reject it instead.");
      await tx.delete(proposalLines).where(thisLine(edit.lineNo));
      return { sku: line.sku, quantity: line.quantity };
    }
    case "ship-to": {
      const [shipTo] = await tx
        .select({ shipToId: shipToAddresses.shipToId })
        .from(shipToAddresses)
        .where(and(eq(shipToAddresses.shipToId, edit.shipToId), eq(shipToAddresses.customerId, proposal.customerId)));
      if (!shipTo) throw new ReviewRefused("Choose one of this customer’s own ship-tos.");
      await tx.update(proposals).set({ shipToId: shipTo.shipToId }).where(eq(proposals.id, proposal.id));
      return { shipToId: proposal.shipToId };
    }
  }
}

async function requireProduct(tx: Database, wanted: string): Promise<void> {
  const [product] = await tx.select({ sku: products.sku }).from(products).where(eq(products.sku, wanted));
  if (!product) throw new ReviewRefused(`There is no product ${wanted} in the catalog.`);
}

// "Mark reply ready": the person's final text is kept and locked, with who and when. It is never sent.
export async function markReplyReady(
  db: Database,
  decision: { emailId: string; userId: number; body: string; at: Date },
): Promise<void> {
  const body = z.string().trim().min(1).max(5000).safeParse(decision.body);
  if (!body.success) throw new ReviewRefused("The reply is empty. Write what would go out first.");
  await db.transaction(async (tx) => {
    const [reply] = await tx
      .select({
        id: draftReplies.id,
        runId: draftReplies.runId,
        body: draftReplies.body,
        readyAt: draftReplies.readyAt,
      })
      .from(draftReplies)
      .innerJoin(agentRuns, eq(agentRuns.runId, draftReplies.runId))
      .where(eq(draftReplies.emailId, decision.emailId))
      .orderBy(desc(agentRuns.startedAt), desc(draftReplies.id))
      .limit(1);
    if (!reply) throw new ReviewRefused("There is no Draft reply for this email.");
    if (reply.readyAt !== null) throw new ReviewRefused("This reply is already marked ready.");
    await tx
      .update(draftReplies)
      .set({ body: body.data, readyBy: decision.userId, readyAt: decision.at })
      .where(eq(draftReplies.id, reply.id));
    await recordAudit(tx, {
      at: decision.at,
      actor: "person",
      userId: decision.userId,
      action: "reply.ready",
      emailId: decision.emailId,
      runId: reply.runId,
      detail: { draftReplyId: reply.id, edited: body.data !== reply.body },
    });
  });
}

export interface ProductMatch {
  sku: string;
  name: string;
  status: "ACTIVE" | "DISCONTINUED";
  listPriceCents: number;
}

// The product search behind a SKU change or an added line: by SKU or name, active products first.
export async function searchProducts(db: Database, query: string): Promise<ProductMatch[]> {
  const words = query.trim();
  if (words.length === 0) return [];
  const pattern = `%${words.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
  return db
    .select({
      sku: products.sku,
      name: products.name,
      status: products.status,
      listPriceCents: products.listPriceCents,
    })
    .from(products)
    .where(or(ilike(products.sku, pattern), ilike(products.name, pattern)))
    .orderBy(sql`${products.status} = 'DISCONTINUED'`, asc(products.sku))
    .limit(8);
}
