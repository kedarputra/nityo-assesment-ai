"use server";

import { getDeadline } from "@vercel/functions";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AgentRunRefused, runAgent, type AgentRunSummary } from "@/agent/run-agent";
import { isTimedOut, SPEND_LIMIT_ERROR_CLASS } from "@/agent/run-errors";
import { getDatabase, withOwnerDatabase } from "@/db/client";
import { AnthropicModel, modelIdFromEnv } from "@/model/anthropic-model";
import { requireRole } from "@/server/auth/current-user";
import { RateLimited, takeRateLimit } from "@/server/rate-limits";
import { dismissTip } from "./inbox";
import {
  finishInboxRun,
  InboxRunRefused,
  runInboxRunStep,
  SPEND_LIMIT_MESSAGE,
  startInboxRun,
  stopInboxRun,
  type InboxRunPlan,
} from "./inbox-run";
import { resetInbox, ResetRefused } from "./reset";

// The tip card stays dismissed for this person on every device (DESIGN.md, "Tip card").
export async function dismissTipAction(): Promise<void> {
  const user = await requireRole("reviewer");
  await dismissTip(getDatabase(), user.id, new Date());
  revalidatePath("/");
}

// The page's `maxDuration`, for when the platform does not say when the function will be stopped.
const FUNCTION_SECONDS = 300;

function functionDeadline(): Date {
  return getDeadline() ?? new Date(Date.now() + FUNCTION_SECONDS * 1000);
}

export type RunAgentResult = { ok: true } | { ok: false; message: string };

const emailIdInput = z.string().regex(/^E\d{3}$/);

// "Run the agent" on one email that has not run, or whose run did not finish (security 2: a
// reviewer may). A run's own failures are kept on its Agent run record and shown in the Proposal
// pane; a spend limit is said here as well, since it stops every run.
export async function runAgentAction(emailId: string): Promise<RunAgentResult> {
  const user = await requireRole("reviewer");
  const parsed = emailIdInput.safeParse(emailId);
  if (!parsed.success) return { ok: false, message: "That email isn’t in today’s inbox." };

  const modelId = modelIdFromEnv();
  try {
    const summary = await runAgent(getDatabase(), new AnthropicModel({ modelId }), {
      emailId: parsed.data,
      modelId,
      startedBy: user.id,
      deadline: functionDeadline(),
      admit: (tx) => takeRateLimit(tx, { userId: user.id, action: "agent-run", at: new Date() }),
    });
    if (summary.errorClass === SPEND_LIMIT_ERROR_CLASS) return { ok: false, message: SPEND_LIMIT_MESSAGE };
  } catch (error) {
    if (!(error instanceof AgentRunRefused) && !(error instanceof RateLimited)) throw error;
    return { ok: false, message: error.message };
  } finally {
    revalidatePath("/");
  }
  return { ok: true };
}

// ---- The admin's controls (security 2: only an admin may run the whole inbox, stop it or reset) --

export type StartInboxRunResult = { ok: true; plan: InboxRunPlan } | { ok: false; message: string };

export async function startInboxRunAction(): Promise<StartInboxRunResult> {
  const user = await requireRole("admin");
  try {
    return { ok: true, plan: await startInboxRun(getDatabase(), { userId: user.id, at: new Date() }) };
  } catch (error) {
    if (!(error instanceof InboxRunRefused)) throw error;
    return { ok: false, message: error.message };
  }
}

// How one email of an Inbox run went. `stop` ends the Run all in the browser with its message; a
// timed-out or failed email is left for the next Run all, and the run carries on.
export type InboxRunStepResult =
  | { ok: true; outcome: "done" | "timed-out" | "failed" | "skipped" }
  | { ok: false; stop: true; message: string };

const stepInput = z.strictObject({ inboxRunId: z.number().int().positive(), emailId: emailIdInput });

export async function runInboxEmailAction(input: unknown): Promise<InboxRunStepResult> {
  const user = await requireRole("admin");
  const parsed = stepInput.safeParse(input);
  if (!parsed.success) return { ok: false, stop: true, message: "That request didn’t make sense to the server. Reload the page and try again." };

  const modelId = modelIdFromEnv();
  try {
    const summary = await runInboxRunStep(getDatabase(), new AnthropicModel({ modelId }), {
      ...parsed.data,
      userId: user.id,
      modelId,
      deadline: functionDeadline(),
    });
    return stepResult(summary);
  } catch (error) {
    if (error instanceof InboxRunRefused || error instanceof RateLimited) return { ok: false, stop: true, message: error.message };
    // The email is being read, or was read, outside this run: nothing to do here.
    if (error instanceof AgentRunRefused) return { ok: true, outcome: "skipped" };
    throw error;
  } finally {
    revalidatePath("/");
  }
}

function stepResult(summary: AgentRunSummary): InboxRunStepResult {
  if (summary.errorClass === SPEND_LIMIT_ERROR_CLASS) return { ok: false, stop: true, message: SPEND_LIMIT_MESSAGE };
  if (isTimedOut(summary.errorClass)) return { ok: true, outcome: "timed-out" };
  if (summary.outcome === "failed") return { ok: true, outcome: "failed" };
  return { ok: true, outcome: "done" };
}

export async function finishInboxRunAction(inboxRunId: unknown): Promise<void> {
  const user = await requireRole("admin");
  const parsed = z.number().int().positive().safeParse(inboxRunId);
  if (!parsed.success) return;
  await finishInboxRun(getDatabase(), { inboxRunId: parsed.data, userId: user.id, at: new Date() });
}

export async function stopInboxRunAction(): Promise<void> {
  const user = await requireRole("admin");
  await stopInboxRun(getDatabase(), { userId: user.id, at: new Date() });
  revalidatePath("/");
}

export type ResetResult = { ok: true } | { ok: false; message: string };

// The person confirmed it in the menu; the server asks for that confirmation too.
const resetInput = z.strictObject({ confirmed: z.literal(true) });

export async function resetToSnapshotAction(input: unknown): Promise<ResetResult> {
  const user = await requireRole("admin");
  if (!resetInput.safeParse(input).success) return { ok: false, message: "Confirm the reset first." };
  try {
    await withOwnerDatabase((ownerDb) => resetInbox(ownerDb, { userId: user.id, username: user.username, at: new Date() }));
  } catch (error) {
    if (!(error instanceof ResetRefused) && !(error instanceof RateLimited)) throw error;
    return { ok: false, message: error.message };
  } finally {
    revalidatePath("/", "layout");
  }
  return { ok: true };
}
