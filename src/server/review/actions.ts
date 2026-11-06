"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDatabase } from "@/db/client";
import type { ProposalKind } from "@/db/schema";
import { requireRole } from "@/server/auth/current-user";
import { listInboxEmails, needsYou, nextNeedingYou } from "@/server/inbox/inbox";
import {
  approveProposal,
  editProposal,
  markReplyReady,
  proposalEdit,
  ReviewRefused,
  searchProducts,
  setProposalAside,
  undoRelease,
  type ProductMatch,
} from "./review";

// The review actions (security 2: a reviewer may). Each checks the role on the server, parses its
// input, and records the signed-in person; a refusal comes back as words for the desk to show.

export type ReviewActionResult =
  | {
      ok: true;
      // What the toast says, and the Proposal its Undo takes back, if any.
      toast: string | null;
      undoProposalId: number | null;
      // Set when the email is decided: where the desk moves next (null: nothing else needs you).
      moveOn: { nextEmailId: string | null } | null;
    }
  | { ok: false; message: string; missingNotes: string[]; hardRules: string[] };

const proposalId = z.number().int().positive();
const emailId = z.string().regex(/^E\d{3}$/);

const approveInput = z.strictObject({
  proposalId,
  notes: z.record(z.string().max(40), z.string().max(2000)),
});
const setAsideInput = z.strictObject({
  proposalId,
  kind: z.enum(["reject", "hold"]),
  reason: z.string().max(2000),
});
const undoInput = z.strictObject({ proposalId });
const editInput = z.strictObject({ proposalId, edit: proposalEdit });
const replyInput = z.strictObject({ emailId, body: z.string().max(10_000) });

const NOT_UNDERSTOOD = "That request didn’t make sense to the server. Reload the page and try again.";

function refused(message: string, details: { missingNotes?: string[]; hardRules?: string[] } = {}): ReviewActionResult {
  return { ok: false, message, missingNotes: details.missingNotes ?? [], hardRules: details.hardRules ?? [] };
}

// Runs a decision, turning a ReviewRefused into words for the desk; anything else is a real failure.
async function deciding(decide: () => Promise<ReviewActionResult>): Promise<ReviewActionResult> {
  try {
    return await decide();
  } catch (error) {
    if (error instanceof ReviewRefused) return refused(error.message);
    throw error;
  } finally {
    revalidatePath("/");
  }
}

// Once an email has nothing open, the desk moves to the next one that needs you.
async function afterDecision(
  decidedEmailId: string,
): Promise<{ left: number; moveOn: { nextEmailId: string | null } | null }> {
  const inbox = await listInboxEmails(getDatabase());
  const left = inbox.filter((email) => needsYou(email.status)).length;
  const decided = inbox.find((email) => email.emailId === decidedEmailId);
  const moveOn = decided && needsYou(decided.status) ? null : { nextEmailId: nextNeedingYou(inbox, decidedEmailId) };
  return { left, moveOn };
}

const APPROVED_WORDS: Record<ProposalKind, string> = {
  "new order": "Released",
  "order change": "Changed",
  cancellation: "Cancelled",
};

function toGo(left: number): string {
  return left === 0 ? "That’s everything 🎉" : `${left} to go.`;
}

export async function approveProposalAction(input: unknown): Promise<ReviewActionResult> {
  const user = await requireRole("reviewer");
  const parsed = approveInput.safeParse(input);
  if (!parsed.success) return refused(NOT_UNDERSTOOD);
  const { proposalId: id, notes } = parsed.data;

  return deciding(async () => {
    const result = await approveProposal(getDatabase(), { proposalId: id, userId: user.id, notes, at: new Date() });
    if (!result.released) {
      const hardRules = result.hardRules.map((check) => check.check);
      if (hardRules.length > 0) {
        return refused(
          "This order can’t be released from here: a hard rule can’t be overridden. Put it on hold or reject it.",
          { hardRules },
        );
      }
      return refused("Add a quick note about why it’s OK.", { missingNotes: result.missingNotes });
    }
    const { left, moveOn } = await afterDecision(result.emailId);
    return {
      ok: true,
      toast: `${APPROVED_WORDS[result.kind]} ${result.soNumber} for ${result.customerName}. ${toGo(left)}`,
      // Undo takes back a release; a change or a cancellation applied to an order is final.
      undoProposalId: result.kind === "new order" ? id : null,
      moveOn,
    };
  });
}

export async function setProposalAsideAction(input: unknown): Promise<ReviewActionResult> {
  const user = await requireRole("reviewer");
  const parsed = setAsideInput.safeParse(input);
  if (!parsed.success) return refused(NOT_UNDERSTOOD);
  const { proposalId: id, kind, reason } = parsed.data;

  return deciding(async () => {
    const decided = await setProposalAside(getDatabase(), {
      proposalId: id,
      userId: user.id,
      kind,
      reason,
      at: new Date(),
    });
    const { left, moveOn } = await afterDecision(decided.emailId);
    const what = kind === "reject" ? "Rejected" : "Put on hold";
    return { ok: true, toast: `${what}: ${decided.emailId}. ${toGo(left)}`, undoProposalId: null, moveOn };
  });
}

export async function undoReleaseAction(input: unknown): Promise<ReviewActionResult> {
  const user = await requireRole("reviewer");
  const parsed = undoInput.safeParse(input);
  if (!parsed.success) return refused(NOT_UNDERSTOOD);

  return deciding(async () => {
    const undone = await undoRelease(getDatabase(), {
      proposalId: parsed.data.proposalId,
      userId: user.id,
      at: new Date(),
    });
    // Undo takes the person back to the email it reopened.
    return {
      ok: true,
      toast: `Took back ${undone.soNumber}. It’s waiting for you again.`,
      undoProposalId: null,
      moveOn: { nextEmailId: undone.emailId },
    };
  });
}

export async function editProposalAction(input: unknown): Promise<ReviewActionResult> {
  const user = await requireRole("reviewer");
  const parsed = editInput.safeParse(input);
  if (!parsed.success) return refused("That change can’t be made here. Quantities are whole numbers of 1 or more.");

  return deciding(async () => {
    await editProposal(getDatabase(), {
      proposalId: parsed.data.proposalId,
      userId: user.id,
      edit: parsed.data.edit,
      at: new Date(),
    });
    return { ok: true, toast: null, undoProposalId: null, moveOn: null };
  });
}

export async function markReplyReadyAction(input: unknown): Promise<ReviewActionResult> {
  const user = await requireRole("reviewer");
  const parsed = replyInput.safeParse(input);
  if (!parsed.success) return refused(NOT_UNDERSTOOD);

  return deciding(async () => {
    await markReplyReady(getDatabase(), {
      emailId: parsed.data.emailId,
      userId: user.id,
      body: parsed.data.body,
      at: new Date(),
    });
    return { ok: true, toast: null, undoProposalId: null, moveOn: null };
  });
}

export async function searchProductsAction(query: unknown): Promise<ProductMatch[]> {
  await requireRole("reviewer");
  const parsed = z.string().max(100).safeParse(query);
  if (!parsed.success) return [];
  return searchProducts(getDatabase(), parsed.data);
}
