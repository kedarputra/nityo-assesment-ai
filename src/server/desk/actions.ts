"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { after } from "next/server";
import { z } from "zod";
import { getDatabase } from "@/db/client";
import type { Database } from "@/db/database";
import { labelColors, triageFlags, triageStatuses, type LabelColor, type TriageFlag, type TriageStatus } from "@/db/schema";
import { AGENT_OFF_MESSAGE, isAgentConfigured } from "@/model/agent-switch";
import { configuredEmbedder } from "@/model/embedder";
import { SCHEDULE_INTERVALS, ScheduleRefused, setSchedule } from "@/server/agent/schedule";
import { requireRole } from "@/server/auth/current-user";
import { stepInBackground } from "@/server/inbox/background";
import { listInboxEmails } from "@/server/inbox/inbox";
import { InboxRunRefused, isUnprocessed, startBackgroundInboxRun } from "@/server/inbox/inbox-run";
import { RateLimited, takeRateLimit } from "@/server/rate-limits";
import { originFromHeaders } from "@/server/request-origin";
import { globalSearch, SEARCH_QUERY_MAX, type GlobalResults, type SearchMode } from "@/server/search/search";
import { discardReply, ReplyRefused, saveReply, REPLY_BODY_MAX, REPLY_SUBJECT_MAX } from "./replies";
import { createLabel, deleteLabel, LABEL_NAME_MAX, setLabels, setTriage, TriageRefused, type Label } from "./triage";

// The desk's own actions (ADR 0005): labels, triage, the reply composer, runs on selected emails,
// the schedule and search. Each checks the role first (security 2), parses its input, and answers
// a refusal in words instead of throwing.

export type DeskResult = { ok: true } | { ok: false; message: string };

const INVALID = "That request didn’t make sense. Reload the page and try again.";

const emailId = z.string().regex(/^E\d{3}$/);
const emailIds = z.array(emailId).min(1).max(50);
const labelId = z.number().int().positive();

function refused(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

// The person's refusals come back as words; anything else is a bug and is thrown.
function refusalOf(error: unknown): { ok: false; message: string } {
  if (error instanceof TriageRefused || error instanceof ReplyRefused || error instanceof ScheduleRefused) return refused(error.message);
  if (error instanceof InboxRunRefused || error instanceof RateLimited) return refused(error.message);
  throw error;
}

function changed(): void {
  revalidatePath("/", "layout");
}

// ---- Labels and triage ------------------------------------------------------------------------

const createLabelInput = z.strictObject({ name: z.string().max(200), color: z.enum(labelColors) });

export async function createLabelAction(input: { name: string; color: LabelColor }): Promise<{ ok: true; label: Label } | { ok: false; message: string }> {
  const user = await requireRole("reviewer");
  const parsed = createLabelInput.safeParse(input);
  if (!parsed.success) return refused(`Give the label a name of up to ${LABEL_NAME_MAX} characters and one of the colours.`);
  try {
    const label = await createLabel(getDatabase(), { ...parsed.data, userId: user.id, at: new Date() });
    changed();
    return { ok: true, label };
  } catch (error) {
    return refusalOf(error);
  }
}

const deleteLabelInput = z.strictObject({ labelId });

export async function deleteLabelAction(input: { labelId: number }): Promise<DeskResult> {
  const user = await requireRole("reviewer");
  const parsed = deleteLabelInput.safeParse(input);
  if (!parsed.success) return refused(INVALID);
  return act(() => deleteLabel(getDatabase(), { labelId: parsed.data.labelId, userId: user.id, at: new Date() }));
}

const setLabelsInput = z.strictObject({
  emailIds,
  add: z.array(labelId).max(50).default([]),
  remove: z.array(labelId).max(50).default([]),
});

export async function setLabelsAction(input: { emailIds: string[]; add?: number[]; remove?: number[] }): Promise<DeskResult> {
  const user = await requireRole("reviewer");
  const parsed = setLabelsInput.safeParse(input);
  if (!parsed.success) return refused(INVALID);
  return act(() => setLabels(getDatabase(), { ...parsed.data, userId: user.id, at: new Date() }));
}

const setTriageInput = z
  .strictObject({ emailIds, status: z.enum(triageStatuses).optional(), flag: z.enum(triageFlags).optional() })
  .refine((input) => input.status !== undefined || input.flag !== undefined);

export async function setTriageAction(input: { emailIds: string[]; status?: TriageStatus; flag?: TriageFlag }): Promise<DeskResult> {
  const user = await requireRole("reviewer");
  const parsed = setTriageInput.safeParse(input);
  if (!parsed.success) return refused(INVALID);
  return act(() => setTriage(getDatabase(), { ...parsed.data, userId: user.id, at: new Date() }));
}

// ---- The reply composer (never sent) -----------------------------------------------------------

const saveReplyInput = z.strictObject({
  emailId,
  subject: z.string().max(REPLY_SUBJECT_MAX * 2),
  body: z.string().max(REPLY_BODY_MAX * 2),
  state: z.enum(["draft", "ready"]),
});

export async function saveReplyAction(input: { emailId: string; subject: string; body: string; state: "draft" | "ready" }): Promise<DeskResult> {
  const user = await requireRole("reviewer");
  const parsed = saveReplyInput.safeParse(input);
  if (!parsed.success) return refused(INVALID);
  return act(() => saveReply(getDatabase(), { ...parsed.data, userId: user.id, at: new Date() }));
}

const discardReplyInput = z.strictObject({ emailId });

export async function discardReplyAction(input: { emailId: string }): Promise<DeskResult> {
  const user = await requireRole("reviewer");
  const parsed = discardReplyInput.safeParse(input);
  if (!parsed.success) return refused(INVALID);
  return act(() => discardReply(getDatabase(), { emailId: parsed.data.emailId, userId: user.id, at: new Date() }));
}

// ---- Runs on selected emails, and the schedule ------------------------------------------------

const MAX_SELECTED_RUN = 20;
const runSelectedInput = z.strictObject({ emailIds: z.array(emailId).min(1).max(MAX_SELECTED_RUN) });

// "Run the agent" on the emails a person selected (ADR 0005): a background run over those of them
// the agent has not read, or did not finish. Each one counts against the person's hourly
// agent-run limit, all up front, so a run that would pass the limit is refused before it starts.
export async function runSelectedAction(input: { emailIds: string[] }): Promise<{ ok: true; count: number } | { ok: false; message: string }> {
  const user = await requireRole("reviewer");
  const parsed = runSelectedInput.safeParse(input);
  if (!parsed.success) return refused(`Select between 1 and ${MAX_SELECTED_RUN} emails to run the agent on.`);
  // Refused before any write, so a deploy without a key records nothing.
  if (!isAgentConfigured()) return refused(AGENT_OFF_MESSAGE);

  const db = getDatabase();
  const selected = new Set(parsed.data.emailIds);
  const inbox = await listInboxEmails(db);
  if (inbox.filter((email) => selected.has(email.emailId)).length !== selected.size) {
    return refused("That email isn’t in today’s inbox.");
  }
  const toRead = inbox.filter((email) => selected.has(email.emailId) && isUnprocessed(email.status)).map((email) => email.emailId);
  if (toRead.length === 0) return refused("The agent has already read the selected emails.");

  const at = new Date();
  try {
    const chain = await startBackgroundInboxRun(db, {
      userId: user.id,
      at,
      origin: await requestOrigin(),
      emailIds: toRead,
      trigger: "person",
      admit: (tx: Database) => takeRateLimits(tx, user.id, toRead.length, at),
    });
    after(() => stepInBackground(chain));
  } catch (error) {
    return refusalOf(error);
  } finally {
    changed();
  }
  return { ok: true, count: toRead.length };
}

async function takeRateLimits(tx: Database, userId: number, count: number, at: Date): Promise<void> {
  for (let taken = 0; taken < count; taken += 1) await takeRateLimit(tx, { userId, action: "agent-run", at });
}

const setScheduleInput = z.strictObject({
  enabled: z.boolean(),
  intervalMinutes: z.number().refine((minutes) => (SCHEDULE_INTERVALS as readonly number[]).includes(minutes)),
});

// Security 2: the schedule runs the whole inbox, which is an admin's.
export async function setScheduleAction(input: { enabled: boolean; intervalMinutes: number }): Promise<DeskResult> {
  const user = await requireRole("admin");
  const parsed = setScheduleInput.safeParse(input);
  if (!parsed.success) return refused(`Choose an interval of ${SCHEDULE_INTERVALS.join(", ")} minutes.`);
  return act(() => setSchedule(getDatabase(), { ...parsed.data, userId: user.id, at: new Date() }));
}

// ---- Search ------------------------------------------------------------------------------------

const searchInput = z.strictObject({ query: z.string().max(SEARCH_QUERY_MAX), mode: z.enum(["keyword", "meaning"]) });

// Read-only, so nothing is revalidated; search by meaning only fills the embedding cache.
export async function searchAction(input: { query: string; mode: SearchMode }): Promise<{ ok: true; results: GlobalResults } | { ok: false; message: string }> {
  await requireRole("reviewer");
  const parsed = searchInput.safeParse(input);
  if (!parsed.success) return refused(`Search for up to ${SEARCH_QUERY_MAX} characters.`);
  const results = await globalSearch(getDatabase(), parsed.data.query, {
    mode: parsed.data.mode,
    embedder: parsed.data.mode === "meaning" ? configuredEmbedder() : null,
  });
  return { ok: true, results };
}

// ---- Helpers ----------------------------------------------------------------------------------

async function act(change: () => Promise<void>): Promise<DeskResult> {
  try {
    await change();
  } catch (error) {
    return refusalOf(error);
  }
  changed();
  return { ok: true };
}

async function requestOrigin(): Promise<string> {
  const origin = originFromHeaders(await headers());
  if (!origin) throw new Error("The request has no host.");
  return origin;
}
