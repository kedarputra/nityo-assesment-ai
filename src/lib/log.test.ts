import { afterEach, describe, expect, it, vi } from "vitest";
import { errorClassOf, logError, logToolCall } from "./log";

describe("the structured log", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes a tool call as one JSON line with its run, email, tool, duration and error class", () => {
    const written = vi.spyOn(console, "log").mockImplementation(() => {});

    logToolCall({ runId: "run-1", emailId: "E001", tool: "check_stock", durationMs: 12.4, errorClass: null });

    expect(written).toHaveBeenCalledTimes(1);
    const [line] = written.mock.calls[0] ?? [];
    expect(typeof line).toBe("string");
    expect(String(line)).not.toContain("\n");
    expect(JSON.parse(String(line))).toEqual({
      event: "tool_call",
      runId: "run-1",
      emailId: "E001",
      tool: "check_stock",
      durationMs: 12,
      errorClass: null,
    });
  });

  it("writes an error as one JSON line to the error stream", () => {
    const written = vi.spyOn(console, "error").mockImplementation(() => {});

    logError({ event: "run_failed", runId: "run-1", emailId: "E001", errorClass: "call-cap" });

    expect(written).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(written.mock.calls[0]?.[0]))).toEqual({
      event: "run_failed",
      runId: "run-1",
      emailId: "E001",
      errorClass: "call-cap",
    });
  });

  it("names a thrown error by its class, never its message, which can carry a secret or an email", () => {
    class SpendLimitReached extends Error {}

    expect(errorClassOf(new TypeError("postgres://user:secret@db"))).toBe("TypeError");
    expect(errorClassOf(new SpendLimitReached("Hi Maria, …"))).toBe("SpendLimitReached");
    expect(errorClassOf("Hi Maria, the body of an email")).toBe("string");
    expect(errorClassOf({ message: "a prompt" })).toBe("object");
  });
});
