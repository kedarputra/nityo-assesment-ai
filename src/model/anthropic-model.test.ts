import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicModel, DEFAULT_MODEL_ID, modelIdFromEnv, type MessagesClient } from "./anthropic-model";
import type { ModelRequest } from "./model";

// A stand-in for the SDK client: it records the parameters and answers with a canned message,
// so no test reaches the network.
function stubClient(reply: Partial<Anthropic.Message>) {
  const sent: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: MessagesClient = {
    messages: {
      create: async (params) => {
        sent.push(params);
        return { content: [], stop_reason: "end_turn", ...reply } as Anthropic.Message;
      },
    },
  };
  return { client, sent };
}

const request: ModelRequest = {
  system: "You work the order inbox.",
  tools: [
    {
      name: "lookup_customer",
      description: "Find a customer by email address.",
      inputSchema: { type: "object", properties: { email: { type: "string" } }, required: ["email"] },
    },
  ],
  messages: [
    { role: "user", content: [{ type: "text", text: "Read E001." }] },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "", signature: "sig-1" },
        { type: "tool_call", id: "toolu_1", name: "lookup_customer", input: { email: "a@b.example" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", toolCallId: "toolu_1", content: '{"id":"C005"}', isError: false }],
    },
  ],
};

describe("modelIdFromEnv", () => {
  it("defaults to claude-opus-5-5", () => {
    expect(DEFAULT_MODEL_ID).toBe("claude-opus-5-5");
    expect(modelIdFromEnv({})).toBe("claude-opus-5-5");
    expect(modelIdFromEnv({ ANTHROPIC_MODEL: "  " })).toBe("claude-opus-5-5");
  });

  it("reads ANTHROPIC_MODEL", () => {
    expect(modelIdFromEnv({ ANTHROPIC_MODEL: "claude-sonnet-5" })).toBe("claude-sonnet-5");
  });
});

describe("AnthropicModel", () => {
  it("sends the system prompt, the tools and the conversation in the API's shape", async () => {
    const { client, sent } = stubClient({});
    const model = new AnthropicModel({ client, modelId: "claude-opus-5-5" });

    await model.send(request);

    expect(sent).toHaveLength(1);
    const params = sent[0];
    expect(params?.model).toBe("claude-opus-5-5");
    expect(params?.system).toBe("You work the order inbox.");
    expect(params?.tools).toEqual([
      {
        name: "lookup_customer",
        description: "Find a customer by email address.",
        input_schema: { type: "object", properties: { email: { type: "string" } }, required: ["email"] },
      },
    ]);
    expect(params?.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Read E001." }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: "sig-1" },
          { type: "tool_use", id: "toolu_1", name: "lookup_customer", input: { email: "a@b.example" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: '{"id":"C005"}', is_error: false }],
      },
    ]);
  });

  it("turns the API's reply into text, tool calls and reasoning", async () => {
    const { client } = stubClient({
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "", signature: "sig-2" },
        { type: "redacted_thinking", data: "opaque" },
        { type: "text", text: "Looking them up.", citations: null },
        { type: "tool_use", id: "toolu_2", name: "lookup_customer", input: { email: "x@y.example" } },
      ] as Anthropic.ContentBlock[],
    });
    const model = new AnthropicModel({ client, modelId: "claude-opus-5-5" });

    const response = await model.send(request);

    expect(response.stopReason).toBe("tool_use");
    expect(response.message).toEqual({
      role: "assistant",
      content: [
        { type: "reasoning", text: "", signature: "sig-2" },
        { type: "redacted_reasoning", data: "opaque" },
        { type: "text", text: "Looking them up." },
        { type: "tool_call", id: "toolu_2", name: "lookup_customer", input: { email: "x@y.example" } },
      ],
    });
  });

  it.each([
    ["end_turn", "end_turn"],
    ["max_tokens", "max_tokens"],
    ["refusal", "refusal"],
    ["pause_turn", "other"],
    [null, "other"],
  ] as const)("maps the stop reason %s to %s", async (apiReason, expected) => {
    const { client } = stubClient({ stop_reason: apiReason });
    const model = new AnthropicModel({ client, modelId: "claude-opus-5-5" });

    expect((await model.send(request)).stopReason).toBe(expected);
  });

  it("refuses a reply block it does not understand rather than dropping it", async () => {
    const { client } = stubClient({
      content: [{ type: "server_tool_use", id: "srv_1", name: "web_search", input: {}, caller: { type: "direct" } }],
    });
    const model = new AnthropicModel({ client, modelId: "claude-opus-5-5" });

    await expect(model.send(request)).rejects.toThrow(/server_tool_use/);
  });
});
