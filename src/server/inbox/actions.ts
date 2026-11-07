"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { after } from "next/server";
import { z } from "zod";
import { AgentRunRefused, beginAgentRun, continueAgentRun } from "@/agent/run-agent";
import { getDatabase, withOwnerDatabase } from "@/db/client";
import type { Database } from "@/db/database";
import { errorClassOf, logError } from "@/lib/log";
import { AGENT_OFF_MESSAGE, isAgentConfigured } from "@/model/agent-switch";
import { configuredModel } from "@/model/configured-model";
import { requireRole } from "@/server/auth/current-user";
import { RateLimited, takeRateLimit } from "@/server/rate-limits";
import { functionDeadline, stepInBackground } from "./background";
import { dismissTip } from "./inbox";
import { InboxRunRefused, startBackgroundInboxRun, stopInboxRun } from "./inbox-run";
import { resetInbox, ResetRefused } from "./reset";

// The tip card stays dismissed for this person on every device (DESIGN.md, "Tip card").
export async function dismissTipAction(): Promise<void> {
  const user = await requireRole("reviewer");
  await dismissTip(getDatabase(), user.id, new Date());
  revalidatePath("/");
}

export type RunAgentResult = { ok: true } | { ok: false; message: string };

const emailIdInput = z.string().regex(/^E\d{3}$/);

// "Run the agent" on one email that has not run, or whose run did not finish (security 2: a
// reviewer may). It answers as soon as the run is recorded; the agent reads on in the background
// (ADR 0004), so the person can move around the desk, or leave it. The run's outcome, and any
// failure, is on its Agent run record and shows in the Proposal pane.
export async function runAgentAction(emailId: string): Promise<RunAgentResult> {
  const user = await requireRole("reviewer");
  const parsed = emailIdInput.safeParse(emailId);
  if (!parsed.success) return { ok: false, message: "That email isn’t in today’s inbox." };
  // Refused before any write, so a deploy without a key records no failed Agent runs.
  const configured = configuredModel();
  if (configured === null) return { ok: false, message: AGENT_OFF_MESSAGE };

  const db = getDatabase();
  const options = {
    emailId: parsed.data,
    modelId: configured.choice.modelId,
    startedBy: user.id,
    deadline: functionDeadline(),
    admit: (tx: Database) => takeRateLimit(tx, { userId: user.id, action: "agent-run", at: new Date() }),
  };
  try {
    const begun = await beginAgentRun(db, options);
    after(async () => {
      try {
        await continueAgentRun(db, configured.model, begun, options);
      } catch (error) {
        logError({ event: "background_run_failed", runId: begun.context.runId, emailId: begun.context.emailId, errorClass: errorClassOf(error) });
      }
    });
  } catch (error) {
    if (!(error instanceof AgentRunRefused) && !(error instanceof RateLimited)) throw error;
    return { ok: false, message: error.message };
  } finally {
    revalidatePath("/");
  }
  return { ok: true };
}

// ---- The admin's controls (security 2: only an admin may run the whole inbox, stop it or reset) --

export type StartInboxRunResult = { ok: true } | { ok: false; message: string };

// The address the admin is using, so the background steps ask this same app for the next email.
async function requestOrigin(): Promise<string> {
  const incoming = await headers();
  const host = incoming.get("x-forwarded-host") ?? incoming.get("host");
  const protocol = incoming.get("x-forwarded-proto") ?? (host?.startsWith("localhost") || host?.startsWith("127.") ? "http" : "https");
  if (!host) throw new Error("The request has no host.");
  return `${protocol}://${host}`;
}

// Run all in the background (ADR 0004): the server reads the inbox one email per function, so the
// admin can close the tab. The desk shows the progress as it refreshes.
export async function startInboxRunAction(): Promise<StartInboxRunResult> {
  const user = await requireRole("admin");
  // Run all reads every email, so with the agent switched off it is refused before any write.
  if (!isAgentConfigured()) return { ok: false, message: AGENT_OFF_MESSAGE };
  try {
    const chain = await startBackgroundInboxRun(getDatabase(), { userId: user.id, at: new Date(), origin: await requestOrigin() });
    after(() => stepInBackground(chain));
  } catch (error) {
    if (!(error instanceof InboxRunRefused)) throw error;
    return { ok: false, message: error.message };
  } finally {
    revalidatePath("/", "layout");
  }
  return { ok: true };
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
