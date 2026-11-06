import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { Database } from "@/db/database";
import {
  agentRuns,
  customerContacts,
  draftReplies,
  emailNotes,
  emails,
  proposals,
  routedRequests,
  type NoActionReason,
  type RequestKind,
  type RouteReason,
} from "@/db/schema";
import { ToolError } from "./tool-error";

// Requests that go to a person instead of the ERP, and emails that need nothing (charting,
// "Requests that are not new orders"). Neither changes ERP data; the code checks what it can
// rather than taking the model's word for it.

export interface RequestContext {
  runId: string;
  emailId: string;
  senderEmail: string;
}

// A routed new order is one the agent cannot propose: a prospect (policy 5), no quantities (U3)
// or a missing attachment (U4).
const ROUTED_KINDS: Record<RouteReason, RequestKind> = {
  quote: "quote request",
  return: "return",
  billing: "billing dispute",
  inquiry: "order inquiry",
  prospect: "new order",
  "no-quantities": "new order",
  "missing-attachment": "new order",
};

// A run writes one Draft reply, which answers everything its email asks.
// A closed email gets none (U13).
export async function writeDraftReply(tx: Database, context: RequestContext, body: string): Promise<number> {
  await refuseIfClosed(tx, context.runId);
  if (await hasDraftReply(tx, context.runId)) {
    throw new ToolError("This email already has its Draft reply; there is one per email, covering everything it asks.");
  }
  const [reply] = await tx
    .insert(draftReplies)
    .values({ runId: context.runId, emailId: context.emailId, body })
    .returning({ id: draftReplies.id });
  if (!reply) throw new Error("The Draft reply was not stored.");
  return reply.id;
}

async function hasDraftReply(tx: Database, runId: string): Promise<boolean> {
  const [reply] = await tx.select({ id: draftReplies.id }).from(draftReplies).where(eq(draftReplies.runId, runId)).limit(1);
  return reply !== undefined;
}

export interface RouteRequest {
  reason: RouteReason;
  summary: string;
  // The email's Draft reply; left out only when the run has already written it.
  reply: string | null;
}

export async function routeToPerson(tx: Database, context: RequestContext, request: RouteRequest) {
  await refuseIfClosed(tx, context.runId);
  if (request.reason === "prospect") {
    const customerIds = await customersOfSender(tx, context.senderEmail);
    if (customerIds.length > 0) {
      throw new ToolError(
        `${context.senderEmail} is a known contact of ${customerIds.join(", ")}, so this is not a prospect (policy 5).`,
      );
    }
  }

  // Every routed Request reaches the person with a reply ready to edit.
  const replied = await hasDraftReply(tx, context.runId);
  if (request.reply === null && !replied) {
    throw new ToolError("A routed Request needs a Draft reply: pass `reply`.");
  }
  if (request.reply !== null && replied) {
    throw new ToolError("This email already has its Draft reply; call route_to_person again without `reply`.");
  }

  const kind = ROUTED_KINDS[request.reason];
  const [routed] = await tx
    .insert(routedRequests)
    .values({ runId: context.runId, emailId: context.emailId, kind, reason: request.reason, summary: request.summary })
    .returning({ id: routedRequests.id });
  if (!routed) throw new Error("The routed Request was not stored.");
  const draftReplyId = request.reply === null ? null : await writeDraftReply(tx, context, request.reply);
  return { routedRequestId: routed.id, kind, draftReplyId };
}

export interface NoActionClosure {
  reason: NoActionReason;
  note: string;
  duplicateOf: string | null;
}

export async function closeNoAction(tx: Database, context: RequestContext, closure: NoActionClosure) {
  await refuseIfClosed(tx, context.runId);
  const [proposed] = await tx.select({ id: proposals.id }).from(proposals).where(eq(proposals.runId, context.runId)).limit(1);
  const [routed] = await tx
    .select({ id: routedRequests.id })
    .from(routedRequests)
    .where(eq(routedRequests.runId, context.runId))
    .limit(1);
  if (proposed || routed) {
    throw new ToolError("This email already has a Proposal or a routed Request, so it is not one that needs no action.");
  }
  if (await hasDraftReply(tx, context.runId)) {
    throw new ToolError("This email already has a Draft reply; an email that needs no action gets none.");
  }

  if (closure.reason === "duplicate") {
    if (closure.duplicateOf === null) throw new ToolError("A duplicate names the email it repeats: pass `duplicate_of`.");
    await checkDuplicate(tx, context, closure.duplicateOf);
  } else if (closure.duplicateOf !== null) {
    throw new ToolError("Only a duplicate names another email; leave out `duplicate_of`.");
  }

  await tx
    .update(agentRuns)
    .set({ noActionReason: closure.reason, noActionNote: closure.note, duplicateOfEmailId: closure.duplicateOf })
    .where(eq(agentRuns.runId, context.runId));
  const notedOn = closure.reason === "auto-reply" ? await attachToOpenRequests(tx, context, closure.note) : [];
  return { closed: closure.reason, duplicateOf: closure.duplicateOf, notedOn };
}

async function refuseIfClosed(tx: Database, runId: string): Promise<void> {
  const [run] = await tx.select({ noActionReason: agentRuns.noActionReason }).from(agentRuns).where(eq(agentRuns.runId, runId));
  if (run?.noActionReason) throw new ToolError(`This email is already closed as ${run.noActionReason}.`);
}

async function customersOfSender(tx: Database, senderEmail: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ customerId: customerContacts.customerId })
    .from(customerContacts)
    .where(sql`lower(${customerContacts.email}) = ${senderEmail.trim().toLowerCase()}`);
  return rows.map((row) => row.customerId);
}

// Closing a duplicate must never lose an order (policy 6, U8): the original is an earlier email
// whose order for the same customer is already in the system, released or waiting for review.
async function checkDuplicate(tx: Database, context: RequestContext, originalId: string): Promise<void> {
  if (originalId === context.emailId) throw new ToolError("An email cannot duplicate itself.");
  const found = await tx
    .select({ emailId: emails.emailId, receivedAt: emails.receivedAt })
    .from(emails)
    .where(inArray(emails.emailId, [context.emailId, originalId]));
  const original = found.find((email) => email.emailId === originalId);
  const current = found.find((email) => email.emailId === context.emailId);
  if (!original || !current) throw new ToolError(`There is no email ${originalId}.`);
  if (original.receivedAt >= current.receivedAt) {
    throw new ToolError(`${originalId} came in after this email, so this email is not its duplicate.`);
  }

  const customerIds = await customersOfSender(tx, context.senderEmail);
  if (customerIds.length === 0) {
    throw new ToolError("The sender is not a known contact, so the duplicate cannot be checked; route it instead.");
  }
  const [order] = await tx
    .select({ id: proposals.id })
    .from(proposals)
    .where(and(eq(proposals.emailId, originalId), inArray(proposals.customerId, customerIds)))
    .limit(1);
  if (!order) {
    throw new ToolError(`${originalId} has no order for this customer in the system yet, so closing this email would lose it.`);
  }
}

// U17: what an auto-reply says (who is away, whom to call) goes onto the same sender's open
// Requests (an open Proposal or a routed Request) as a note. It never changes them.
async function attachToOpenRequests(tx: Database, context: RequestContext, note: string): Promise<string[]> {
  const sender = context.senderEmail.trim().toLowerCase();
  const withOpenProposal = tx.select({ emailId: proposals.emailId }).from(proposals).where(eq(proposals.status, "open"));
  const withRoutedRequest = tx.select({ emailId: routedRequests.emailId }).from(routedRequests);
  const open = await tx
    .select({ emailId: emails.emailId })
    .from(emails)
    .where(
      and(
        sql`lower(${emails.fromEmail}) = ${sender}`,
        ne(emails.emailId, context.emailId),
        or(inArray(emails.emailId, withOpenProposal), inArray(emails.emailId, withRoutedRequest)),
      ),
    )
    .orderBy(asc(emails.receivedAt));
  const emailIds = open.map((row) => row.emailId);
  if (emailIds.length > 0) {
    await tx
      .insert(emailNotes)
      .values(emailIds.map((emailId) => ({ emailId, sourceEmailId: context.emailId, runId: context.runId, note })));
  }
  return emailIds;
}
