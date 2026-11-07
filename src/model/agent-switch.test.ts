import { describe, expect, it } from "vitest";
import { DEFAULT_ANTHROPIC_MODEL_ID, DEFAULT_GEMINI_MODEL_ID, isAgentConfigured, modelChoiceFromEnv } from "./agent-switch";

describe("isAgentConfigured", () => {
  it("is on only when a model key has a value", () => {
    expect(isAgentConfigured({ ANTHROPIC_API_KEY: "sk-ant-test" })).toBe(true);
    expect(isAgentConfigured({ GEMINI_API_KEY: "gemini-test" })).toBe(true);
    expect(isAgentConfigured({})).toBe(false);
    expect(isAgentConfigured({ ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "" })).toBe(false);
    expect(isAgentConfigured({ ANTHROPIC_API_KEY: "   ", GEMINI_API_KEY: " " })).toBe(false);
  });
});

describe("modelChoiceFromEnv", () => {
  it("takes Anthropic when its key is set, even beside a Gemini key", () => {
    expect(modelChoiceFromEnv({ ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g" })).toEqual({
      provider: "anthropic",
      modelId: DEFAULT_ANTHROPIC_MODEL_ID,
    });
  });

  it("takes Gemini's free tier when only its key is set", () => {
    expect(modelChoiceFromEnv({ GEMINI_API_KEY: "g" })).toEqual({ provider: "gemini", modelId: DEFAULT_GEMINI_MODEL_ID });
    expect(modelChoiceFromEnv({ GEMINI_API_KEY: "g", GEMINI_MODEL: " gemini-3.5-flash-lite " })).toEqual({
      provider: "gemini",
      modelId: "gemini-3.5-flash-lite",
    });
  });

  it("is null with neither key", () => {
    expect(modelChoiceFromEnv({ ANTHROPIC_MODEL: "claude-x", GEMINI_MODEL: "gemini-x" })).toBeNull();
  });
});
