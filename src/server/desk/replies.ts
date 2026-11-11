import { desc, eq, inArray } from "drizzle-orm";
import { recordAudit } from "@/agent/audit";
import type { Database } from "@/db/database";
import { agentRuns, draftReplies, emails, replyCompositions, users } from "@/db/schema";

// The Outlook-style reply composer (ADR 0005): To, subject and body, prefilled from the agent's
// Draft reply. A person saves a draft or approves it for sending. Nothing is ever sent: an
// approved reply is logged as "would send". The inbox is a fixture of `.example` addresses.

export const REPLY_SUBJECT_MAX = 200;
export const REPLY_BODY_MAX = 10_000;

export class ReplyRefused extends Error {
  override name = "ReplyRefused";
}

export type ReplyViewState = "draft" | "ready" | "agent-draft" | "none";

export interface ReplyView {
  emailId: string;
  to: string;
  subject: string;
  body: string;
  state: ReplyViewState;
  updatedAt: Date | null;
  updatedByName: string | null;
}

// "RE: <subject>", never "RE: RE: …".
export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  return /^re\s*:/i.test(trimmed) ? trimmed : `RE: ${trimmed}`;
}

// The person's composition if there is one; else the agent's Draft reply from the email's latest
// run, ready to edit; else an empty reply.
export async function findReply(db: Database, emailId: string): Promise<ReplyView> {
  const [email] = await db
    .select({ subject: emails.subject, fromEmail: emails.fromEmail })
    .from(emails)
    .where(eq(emails.emailId, emailId));
  if (!email) throw new ReplyRefused("That email isn’t in today’s inbox.");
  const base = { emailId, to: email.fromEmail };

  const [composed] = await db
    .select({
      subject: replyCompositions.subject,
      body: replyCompositions.body,
      state: replyCompositions.state,
      updatedAt: replyCompositions.updatedAt,
      updatedByName: users.username,
    })
    .from(replyCompositions)
    .leftJoin(users, eq(users.id, replyCompositions.updatedBy))
    .where(eq(replyCompositions.emailId, emailId));
  if (composed) return { ...base, ...composed };

  const agentDraft = (await latestAgentDrafts(db, emailId)).get(emailId);
  if (agentDraft) {
    // A reply marked ready on the Proposal pane, before the composer, is still ready.
    const ready = agentDraft.readyAt !== null;
    return {
      ...base,
      subject: replySubject(email.subject),
      body: agentDraft.body,
      state: ready ? "ready" : "agent-draft",
      updatedAt: ready ? agentDraft.readyAt : agentDraft.createdAt,
      updatedByName: ready ? agentDraft.readyByName : null,
    };
  }
  return { ...base, subject: replySubject(email.subject), body: "", state: "none", updatedAt: null, updatedByName: null };
}

// Each email's reply state, for the Drafts folder and its count. Emails with no reply at all are
// left out.
export async function listReplies(db: Database): Promise<Map<string, ReplyViewState>> {
  const states = new Map<string, ReplyViewState>();
  for (const [emailId, draft] of await latestAgentDrafts(db)) states.set(emailId, draft.readyAt === null ? "agent-draft" : "ready");
  const composed = await db.select({ emailId: replyCompositions.emailId, state: replyCompositions.state }).from(replyCompositions);
  for (const row of composed) states.set(row.emailId, row.state);
  return states;
}

export async function saveReply(
  db: Database,
  save: { emailId: string; subject: string; body: string; state: "draft" | "ready"; userId: number; at: Date },
): Promise<void> {
  const subject = save.subject.trim();
  if (subject.length > REPLY_SUBJECT_MAX) throw new ReplyRefused(`The subject is at most ${REPLY_SUBJECT_MAX} characters.`);
  if (save.body.length > REPLY_BODY_MAX) throw new ReplyRefused(`The reply is at most ${REPLY_BODY_MAX.toLocaleString("en-US")} characters.`);
  if (save.state === "ready" && save.body.trim().length === 0) {
    throw new ReplyRefused("The reply is empty. Write what would go out first.");
  }

  await db.transaction(async (tx) => {
    const [email] = await tx.select({ fromEmail: emails.fromEmail }).from(emails).where(eq(emails.emailId, save.emailId));
    if (!email) throw new ReplyRefused("That email isn’t in today’s inbox.");
    const values = { subject, body: save.body, state: save.state, updatedBy: save.userId, updatedAt: save.at };
    await tx
      .insert(replyCompositions)
      .values({ emailId: save.emailId, ...values })
      .onConflictDoUpdate({ target: replyCompositions.emailId, set: values });
    await recordAudit(tx, {
      at: save.at,
      actor: "person",
      userId: save.userId,
      action: save.state === "ready" ? "reply.approved" : "reply.saved",
      emailId: save.emailId,
      runId: null,
      detail: {
        to: email.fromEmail,
        subject,
        characters: save.body.length,
        // Approved for sending is as far as a reply goes: nothing is ever sent.
        ...(save.state === "ready" ? { wouldSend: true } : {}),
      },
    });
  });
}

// Throws the person's composition away; the agent's Draft reply is still there to start again from.
export async function discardReply(db: Database, discard: { emailId: string; userId: number; at: Date }): Promise<void> {
  await db.transaction(async (tx) => {
    const removed = await tx
      .delete(replyCompositions)
      .where(eq(replyCompositions.emailId, discard.emailId))
      .returning({ state: replyCompositions.state });
    if (removed.length === 0) return;
    await recordAudit(tx, {
      at: discard.at,
      actor: "person",
      userId: discard.userId,
      action: "reply.discarded",
      emailId: discard.emailId,
      runId: null,
      detail: { state: removed[0]?.state ?? null },
    });
  });
}

interface AgentDraft {
  body: string;
  createdAt: Date;
  readyAt: Date | null;
  readyByName: string | null;
}

// The Draft reply of each email's latest Agent run, as the Proposal pane shows it.
async function latestAgentDrafts(db: Database, emailId?: string): Promise<Map<string, AgentDraft>> {
  const runs = await db
    .select({ runId: agentRuns.runId, emailId: agentRuns.emailId })
    .from(agentRuns)
    .where(emailId === undefined ? undefined : eq(agentRuns.emailId, emailId))
    .orderBy(desc(agentRuns.startedAt));
  const latestRun = new Map<string, string>();
  for (const run of runs) if (!latestRun.has(run.emailId)) latestRun.set(run.emailId, run.runId);
  if (latestRun.size === 0) return new Map();

  const drafts = await db
    .select({
      emailId: draftReplies.emailId,
      body: draftReplies.body,
      createdAt: draftReplies.createdAt,
      readyAt: draftReplies.readyAt,
      readyByName: users.username,
    })
    .from(draftReplies)
    .leftJoin(users, eq(users.id, draftReplies.readyBy))
    .where(inArray(draftReplies.runId, [...latestRun.values()]))
    .orderBy(desc(draftReplies.id));
  const byEmail = new Map<string, AgentDraft>();
  for (const { emailId: id, ...draft } of drafts) if (!byEmail.has(id)) byEmail.set(id, draft);
  return byEmail;
}
