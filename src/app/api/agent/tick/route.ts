import { after } from "next/server";
import { getDatabase } from "@/db/client";
import { errorClassOf, logError } from "@/lib/log";
import { isCronBearer, scheduleTick } from "@/server/agent/schedule";
import { stepInBackground } from "@/server/inbox/background";
import { originFromHeaders } from "@/server/request-origin";

// The schedule's clock (ADR 0005). A GitHub Actions workflow posts here every 5 minutes with
// `Authorization: Bearer <CRON_SECRET>`; no session or cookie is involved, the secret is the check.
// When a run is due it is recorded before the answer, and its first email is read after it.
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return Response.json({ error: "The schedule isn’t set up on this deploy." }, { status: 503 });
  if (!isCronBearer(request.headers.get("authorization"), secret)) {
    return Response.json({ error: "That tick isn’t allowed." }, { status: 401 });
  }

  const origin = originFromHeaders(request.headers) ?? new URL(request.url).origin;
  try {
    const result = await scheduleTick(getDatabase(), {
      at: new Date(),
      origin,
      start: (chain) => after(() => stepInBackground(chain)),
    });
    return Response.json({ result });
  } catch (error) {
    logError({ event: "schedule_tick_failed", errorClass: errorClassOf(error) });
    return Response.json({ error: "The tick failed." }, { status: 500 });
  }
}
