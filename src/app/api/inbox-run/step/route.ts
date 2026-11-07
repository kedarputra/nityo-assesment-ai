import { after } from "next/server";
import { z } from "zod";
import { getDatabase } from "@/db/client";
import { isAgentConfigured } from "@/model/agent-switch";
import { stepInBackground } from "@/server/inbox/background";
import { isInboxRunToken } from "@/server/inbox/inbox-run";

// The next email of a background Run all (ADR 0004). The previous step's function posts here with
// the run's secret; no session is needed, the secret is the check (security 7), and the gate still
// refuses a cross-site post. It answers at once and reads the email after answering.
export const maxDuration = 300;

const stepInput = z.strictObject({
  inboxRunId: z.number().int().positive(),
  token: z.string().regex(/^[0-9a-f]{64}$/),
});

export async function POST(request: Request): Promise<Response> {
  const parsed = stepInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "That request didn’t make sense." }, { status: 400 });
  if (!(await isInboxRunToken(getDatabase(), parsed.data))) {
    return Response.json({ error: "That Run all step isn’t allowed." }, { status: 403 });
  }
  if (!isAgentConfigured()) return Response.json({ error: "The agent is switched off." }, { status: 409 });

  after(() => stepInBackground(parsed.data));
  return Response.json({ accepted: true }, { status: 202 });
}
