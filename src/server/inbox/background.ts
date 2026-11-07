import { getDeadline } from "@vercel/functions";
import { getDatabase } from "@/db/client";
import { errorClassOf, logError } from "@/lib/log";
import { configuredModel } from "@/model/configured-model";
import { runChainStep, type InboxRunChain } from "./inbox-run";

// Work that goes on after the person's request has been answered (Next.js `after`), inside the
// same function and its 300 s. Nothing here throws: a failure is logged by class, and the run's
// own record says what happened.

export const INBOX_RUN_STEP_PATH = "/api/inbox-run/step";
const FUNCTION_SECONDS = 300;

export function functionDeadline(): Date {
  return getDeadline() ?? new Date(Date.now() + FUNCTION_SECONDS * 1000);
}

// Asks the app, at the address the admin used, to read the next email in a function of its own.
// The step route answers at once, so this waits for that answer and no longer.
export async function triggerNextStep(chain: InboxRunChain, origin: string): Promise<void> {
  const response = await fetch(new URL(INBOX_RUN_STEP_PATH, origin), {
    method: "POST",
    // Same origin as the app, so the gate's cross-site check lets it through.
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(chain),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`The next Run all step was refused with ${response.status}.`);
}

// One step of a background Run all; the step after it is asked for by the step itself.
export async function stepInBackground(chain: InboxRunChain): Promise<void> {
  const configured = configuredModel();
  if (configured === null) return;
  try {
    await runChainStep(getDatabase(), chain, {
      model: configured.model,
      modelId: configured.choice.modelId,
      deadline: functionDeadline(),
      triggerNext: triggerNextStep,
    });
  } catch (error) {
    logError({ event: "inbox_run_step_failed", errorClass: errorClassOf(error) });
  }
}
