import { sql } from "drizzle-orm";
import type { Database } from "@/db/database";
import { errorClassOf, logError } from "@/lib/log";

// The health check is public (security 7), so it says only whether the app can reach its
// database: never the error, the database's address or a version.
export async function checkHealth(connect: () => Database): Promise<Response> {
  try {
    await connect().execute(sql`select 1`);
    return healthResponse(200, "ok");
  } catch (error) {
    // The error's message can carry the connection string, so only its class is logged.
    logError({ event: "health_check_failed", errorClass: errorClassOf(error) });
    return healthResponse(503, "unavailable");
  }
}

function healthResponse(status: 200 | 503, state: "ok" | "unavailable"): Response {
  return Response.json({ status: state }, { status, headers: { "cache-control": "no-store" } });
}
