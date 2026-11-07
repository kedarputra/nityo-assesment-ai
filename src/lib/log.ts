// The structured log (security 8; observability): one JSON line per tool call and per error, in
// Vercel's function logs. Each entry is a fixed set of ids, names, timings and error classes, so
// an email body, a prompt, a reply or a secret has no field to travel in. Never add free text.

export interface ToolCallEntry {
  runId: string;
  emailId: string;
  // A tool the agent has; the caller logs a name the model made up as "unknown".
  tool: string;
  durationMs: number;
  errorClass: string | null;
}

export interface ErrorEntry {
  event: "run_failed" | "health_check_failed" | "inbox_run_step_failed" | "background_run_failed";
  runId?: string;
  emailId?: string;
  // A class name from `errorClassOf`, or one of the run's own words such as "call-cap".
  errorClass: string;
}

export function logToolCall(entry: ToolCallEntry): void {
  console.log(
    JSON.stringify({
      event: "tool_call",
      runId: entry.runId,
      emailId: entry.emailId,
      tool: entry.tool,
      durationMs: Math.round(entry.durationMs),
      errorClass: entry.errorClass,
    }),
  );
}

export function logError(entry: ErrorEntry): void {
  console.error(
    JSON.stringify({ event: entry.event, runId: entry.runId, emailId: entry.emailId, errorClass: entry.errorClass }),
  );
}

// An error's message can quote the email, the prompt or a connection string, so only its class
// is ever logged. A class that sets its own `name` is logged by it, since a minified build can
// rename the class itself. A thrown value that is not an Error is named by its type alone.
export function errorClassOf(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  if (error.name !== "Error") return error.name;
  return error.constructor.name || "Error";
}
