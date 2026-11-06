import { describe, expect, it } from "vitest";
import { isAgentConfigured } from "./agent-switch";

describe("isAgentConfigured", () => {
  it("is on only when ANTHROPIC_API_KEY has a value", () => {
    expect(isAgentConfigured({ ANTHROPIC_API_KEY: "sk-ant-test" })).toBe(true);
    expect(isAgentConfigured({})).toBe(false);
    expect(isAgentConfigured({ ANTHROPIC_API_KEY: "" })).toBe(false);
    expect(isAgentConfigured({ ANTHROPIC_API_KEY: "   " })).toBe(false);
  });
});
