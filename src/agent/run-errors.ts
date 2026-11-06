// The error classes a run records when it stops at its own limits, apart from the run loop so the
// desk can name them without loading the agent.

// "Timed out, run it again": the function's deadline came near, or the run used its model calls.
export const TIMED_OUT_ERROR_CLASSES: readonly string[] = ["deadline", "call-cap"];
// The model's spending limit is reached; never retried.
export const SPEND_LIMIT_ERROR_CLASS = "spend-limit";
