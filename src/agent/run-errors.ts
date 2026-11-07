// The error classes a run records when it stops at its own limits, apart from the run loop so the
// desk can name them without loading the agent.

// "Timed out, run it again": the function's deadline came near, or the run used its model calls.
const TIMED_OUT_ERROR_CLASSES: readonly string[] = ["deadline", "call-cap", "cut-off"];
// The model's spending limit is reached; never retried.
export const SPEND_LIMIT_ERROR_CLASS = "spend-limit";

export function isTimedOut(errorClass: string | null): boolean {
  return errorClass !== null && TIMED_OUT_ERROR_CLASSES.includes(errorClass);
}

// A run that has not finished this long after it started was cut off with its function: it no
// longer holds its email or blocks a Reset, and the desk shows it as not finished.
export const RUN_ABANDONED_AFTER_MS = 360_000;
export const CUT_OFF_ERROR_CLASS = "cut-off";

export function isCutOff(run: { startedAt: Date; endedAt: Date | null }, now: Date): boolean {
  return run.endedAt === null && now.getTime() - run.startedAt.getTime() >= RUN_ABANDONED_AFTER_MS;
}
