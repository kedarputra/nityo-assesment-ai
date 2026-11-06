"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AgentRunRefused, runAgent } from "@/agent/run-agent";
import { getDatabase } from "@/db/client";
import { AGENT_OFF_MESSAGE, isAgentConfigured } from "@/model/agent-switch";
import { AnthropicModel, modelIdFromEnv } from "@/model/anthropic-model";
import { requireRole } from "@/server/auth/current-user";
import { dismissTip } from "./inbox";

// The tip card stays dismissed for this person on every device (DESIGN.md, "Tip card").
export async function dismissTipAction(): Promise<void> {
  const user = await requireRole("reviewer");
  await dismissTip(getDatabase(), user.id, new Date());
  revalidatePath("/");
}

export type RunAgentResult = { ok: true } | { ok: false; message: string };

const emailIdInput = z.string().regex(/^E\d{3}$/);

// "Run the agent" on one email that has not run (security 2: a reviewer may). A run's own
// failures are kept on its Agent run record and shown in the Proposal pane.
export async function runAgentAction(emailId: string): Promise<RunAgentResult> {
  const user = await requireRole("reviewer");
  const parsed = emailIdInput.safeParse(emailId);
  if (!parsed.success) return { ok: false, message: "That email isn’t in today’s inbox." };
  // Refused before any write, so a deploy without a key records no failed Agent runs.
  if (!isAgentConfigured()) return { ok: false, message: AGENT_OFF_MESSAGE };

  const modelId = modelIdFromEnv();
  try {
    await runAgent(getDatabase(), new AnthropicModel({ modelId }), { emailId: parsed.data, modelId, startedBy: user.id });
  } catch (error) {
    if (!(error instanceof AgentRunRefused)) throw error;
    return { ok: false, message: error.message };
  } finally {
    revalidatePath("/");
  }
  return { ok: true };
}
