import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import type { Database } from "@/db/database";
import {
  agentFlags,
  agentRuns,
  emailLinks,
  emailNotes,
  emails,
  proposalLines,
  proposals,
  routedRequests,
  salesOrderLines,
  salesOrders,
  type AgentRunOutcome,
} from "@/db/schema";
import { businessDateOf } from "@/lib/business-clock";
import { allContacts, customerOfSender, type Contact } from "./sender";
import { ToolError } from "./tool-error";

// Emails that belong together (ticket 08 of the map). A run reads the customer's other emails
// today and their open work, links what belongs together, and leaves remarks for the reviewer of
// another email. It never changes another email's Proposal.

export interface RelatedContext {
  runId: string;
  emailId: string;
}

// The customer's emails that arrived earlier today, with what their runs made, and the customer's
// sales orders that still have lines to ship. No email body is returned: it is the other email's
// untrusted text, and its run's summary already says what it asked.
export async function findRelatedWork(tx: Database, context: RelatedContext, customerId: string) {
  const current = await thisEmail(tx, context.emailId);
  const earlier = await earlierEmailsOfCustomer(tx, current, customerId, await allContacts(tx));
  const emailIds = earlier.map((email) => email.emailId);

  const runs =
    emailIds.length === 0
      ? []
      : await tx
          .select({ runId: agentRuns.runId, emailId: agentRuns.emailId, outcome: agentRuns.outcome })
          .from(agentRuns)
          .where(inArray(agentRuns.emailId, emailIds))
          .orderBy(desc(agentRuns.startedAt));
  const latestRuns = emailIds.flatMap((emailId) => {
    const run = runs.find((candidate) => candidate.emailId === emailId);
    return run ? [run] : [];
  });
  const runIds = latestRuns.map((run) => run.runId);
  const proposalRows =
    runIds.length === 0
      ? []
      : await tx
          .select({
            proposalId: proposals.id,
            runId: proposals.runId,
            status: proposals.status,
            shipToId: proposals.shipToId,
            customerPo: proposals.customerPo,
            soNumber: proposals.soNumber,
            totalCents: proposals.totalCents,
          })
          .from(proposals)
          .where(inArray(proposals.runId, runIds))
          .orderBy(asc(proposals.id));
  const lineRows =
    proposalRows.length === 0
      ? []
      : await tx
          .select({ proposalId: proposalLines.proposalId, sku: proposalLines.sku, quantity: proposalLines.quantity })
          .from(proposalLines)
          .where(
            inArray(
              proposalLines.proposalId,
              proposalRows.map((row) => row.proposalId),
            ),
          )
          .orderBy(asc(proposalLines.proposalId), asc(proposalLines.lineNo));
  const routedRows =
    runIds.length === 0
      ? []
      : await tx
          .select({ runId: routedRequests.runId, kind: routedRequests.kind, reason: routedRequests.reason, summary: routedRequests.summary })
          .from(routedRequests)
          .where(inArray(routedRequests.runId, runIds));

  return {
    emailsToday: earlier.map((email) => {
      const run = latestRuns.find((candidate) => candidate.emailId === email.emailId);
      return {
        emailId: email.emailId,
        receivedAt: email.receivedAt.toISOString(),
        fromEmail: email.fromEmail,
        subject: email.subject,
        outcome: runOutcome(run),
        proposals: proposalRows
          .filter((row) => row.runId === run?.runId)
          .map((proposal) => ({
            proposalId: proposal.proposalId,
            status: proposal.status,
            shipToId: proposal.shipToId,
            customerPo: proposal.customerPo,
            soNumber: proposal.soNumber,
            totalCents: proposal.totalCents,
            lines: lineRows
              .filter((line) => line.proposalId === proposal.proposalId)
              .map(({ sku, quantity }) => ({ sku, quantity })),
          })),
        routed: routedRows
          .filter((row) => row.runId === run?.runId)
          .map(({ kind, reason, summary }) => ({ kind, reason, summary })),
      };
    }),
    openOrders: await unshippedOrders(tx, customerId),
  };
}

export interface EmailLink {
  relatedEmailId: string;
  why: string;
  // Possibly the same order as the earlier email (U4: E031 and E023's missing PO): a flag, so it
  // waits for a person.
  possiblySameOrder: boolean;
  // Shown on the earlier email for its reviewer (U6: E034's "skip the towels" on E005).
  remark: string | null;
}

export async function linkRelatedEmail(tx: Database, context: RelatedContext, link: EmailLink) {
  if (link.relatedEmailId === context.emailId) throw new ToolError("An email cannot be linked to itself.");
  const current = await thisEmail(tx, context.emailId);
  const contacts = await allContacts(tx);
  const customerId = customerOfSender(contacts, current.fromEmail);
  if (customerId === null) throw new ToolError("The sender is not one customer's, so there is no customer to link within.");
  const earlier = await earlierEmailsOfCustomer(tx, current, customerId, contacts);
  if (!earlier.some((email) => email.emailId === link.relatedEmailId)) {
    throw new ToolError(`${link.relatedEmailId} is not one of ${customerId}'s emails that came in earlier today.`);
  }
  const [already] = await tx
    .select({ id: emailLinks.id })
    .from(emailLinks)
    .where(and(eq(emailLinks.runId, context.runId), eq(emailLinks.relatedEmailId, link.relatedEmailId)));
  if (already) throw new ToolError(`This email is already linked to ${link.relatedEmailId}.`);

  await tx.insert(emailLinks).values({
    runId: context.runId,
    emailId: context.emailId,
    relatedEmailId: link.relatedEmailId,
    why: link.why,
    possiblySameOrder: link.possiblySameOrder,
  });
  const flag = link.possiblySameOrder ? `RELATED-${link.relatedEmailId}` : null;
  if (flag !== null) {
    await tx.insert(agentFlags).values({ runId: context.runId, emailId: context.emailId, code: flag, note: link.why });
  }
  if (link.remark !== null) {
    await tx
      .insert(emailNotes)
      .values({ emailId: link.relatedEmailId, sourceEmailId: context.emailId, runId: context.runId, note: link.remark });
  }
  return { linked: link.relatedEmailId, flagged: flag, remarkOn: link.remark === null ? null : link.relatedEmailId };
}

// Context for this email's reviewer that is not a review reason (U5: E033's mention of a
// cancellation; U8: an overlap with an open order's unshipped lines). It never stops a release.
export async function noteForReviewer(tx: Database, context: RelatedContext, note: string) {
  const [stored] = await tx
    .insert(emailNotes)
    .values({ emailId: context.emailId, sourceEmailId: context.emailId, runId: context.runId, note })
    .returning({ id: emailNotes.id });
  if (!stored) throw new Error("The note was not stored.");
  return { noted: true };
}

type EmailRow = typeof emails.$inferSelect;

function runOutcome(run: { outcome: AgentRunOutcome | null } | undefined): string {
  if (!run) return "not run yet";
  return run.outcome ?? "still running";
}

async function thisEmail(tx: Database, emailId: string): Promise<EmailRow> {
  const [email] = await tx.select().from(emails).where(eq(emails.emailId, emailId));
  if (!email) throw new Error(`There is no email ${emailId}.`);
  return email;
}

// Only emails that had arrived when this one did: a run never sees the future.
async function earlierEmailsOfCustomer(
  tx: Database,
  current: EmailRow,
  customerId: string,
  contacts: readonly Contact[],
): Promise<EmailRow[]> {
  const today = businessDateOf(current.receivedAt);
  const earlier = await tx.select().from(emails).where(lt(emails.receivedAt, current.receivedAt)).orderBy(asc(emails.receivedAt));
  return earlier.filter(
    (email) => businessDateOf(email.receivedAt) === today && customerOfSender(contacts, email.fromEmail) === customerId,
  );
}

async function unshippedOrders(tx: Database, customerId: string) {
  const orders = await tx
    .select()
    .from(salesOrders)
    .where(and(eq(salesOrders.customerId, customerId), inArray(salesOrders.status, ["OPEN", "PARTIALLY_SHIPPED"])))
    .orderBy(desc(salesOrders.orderDate), desc(salesOrders.soNumber));
  if (orders.length === 0) return [];
  const lines = await tx
    .select()
    .from(salesOrderLines)
    .where(
      inArray(
        salesOrderLines.soNumber,
        orders.map((order) => order.soNumber),
      ),
    )
    .orderBy(asc(salesOrderLines.soNumber), asc(salesOrderLines.lineNo));
  return orders.map((order) => ({
    soNumber: order.soNumber,
    shipToId: order.shipToId,
    customerPo: order.customerPo,
    orderDate: order.orderDate,
    requestedDate: order.requestedDate,
    status: order.status,
    unshippedLines: lines
      .filter((line) => line.soNumber === order.soNumber && line.qtyOrdered > line.qtyShipped)
      .map((line) => ({ sku: line.sku, unshipped: line.qtyOrdered - line.qtyShipped })),
  }));
}
