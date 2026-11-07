import { describe, expect, it, vi } from "vitest";
import { DEFAULT_GEMINI_REASONING_EFFORT, configuredModel } from "./configured-model";
import { OpenAiCompatibleModel } from "./openai-compatible-model";

describe("configuredModel", () => {
  it("is null while the agent is switched off", () => {
    expect(configuredModel({})).toBeNull();
  });

  it("gives Gemini a low reasoning effort unless told otherwise, so a call takes seconds", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    });
    try {
      const request = { system: "s", tools: [], messages: [] };
      const low = configuredModel({ GEMINI_API_KEY: "g" });
      const medium = configuredModel({ GEMINI_API_KEY: "g", GEMINI_REASONING_EFFORT: "medium" });
      expect(low?.model).toBeInstanceOf(OpenAiCompatibleModel);
      await low?.model.send(request);
      await medium?.model.send(request);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(bodies[0]?.reasoning_effort).toBe(DEFAULT_GEMINI_REASONING_EFFORT);
    expect(bodies[1]?.reasoning_effort).toBe("medium");
  });
});
