import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  AnthropicModel,
  DEFAULT_MODEL_ID,
  modelIdFromEnv,
  withoutSpendLimitRetries,
  type MessagesClient,
} from "./anthropic-model";
import { SpendLimitReached, type ModelRequest } from "./model";

// A stand-in for the SDK client: it records the parameters and answers with a canned message,
// so no test reaches the network.
function stubClient(reply: Partial<Anthropic.Message>) {
  const sent: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: MessagesClient = {
    messages: {
      create: async (params) => {
        sent.push(params);
        return {
          content: [],
          stop_reason: "end_turn",
          usage: { input_tokens: 0, output_tokens: 0 },
          ...reply,
        } as Anthropic.Message;
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

  it("reports the tokens the call used, for the Agent run record", async () => {
    const { client } = stubClient({ usage: { input_tokens: 1200, output_tokens: 340 } as Anthropic.Usage });
    const model = new AnthropicModel({ client, modelId: "claude-opus-5-5" });

    const response = await model.send(request);

    expect(response.usage).toEqual({ inputTokens: 1200, outputTokens: 340 });
  });

  it("refuses a reply block it does not understand rather than dropping it", async () => {
    const { client } = stubClient({
      content: [{ type: "server_tool_use", id: "srv_1", name: "web_search", input: {}, caller: { type: "direct" } }],
    });
    const model = new AnthropicModel({ client, modelId: "claude-opus-5-5" });

    await expect(model.send(request)).rejects.toThrow(/server_tool_use/);
  });
});

describe("a spend limit", () => {
  function failingClient(error: Error): MessagesClient {
    return { messages: { create: async () => Promise.reject(error) } };
  }

  const spendLimit429 = { type: "error", error: { type: "rate_limit_error", message: "enforced_spend_limit_reached" } };
  const usageLimits400 = {
    type: "error",
    error: { type: "invalid_request_error", message: "You have reached your specified workspace API usage limits." },
  };

  it.each([
    ["429 enforced_spend_limit_reached", 429, spendLimit429],
    ["400 usage limits", 400, usageLimits400],
  ] as const)("turns a %s into SpendLimitReached", async (_name, status, body) => {
    const error = Anthropic.APIError.generate(status, body, undefined, new Headers());
    const model = new AnthropicModel({ client: failingClient(error), modelId: "claude-opus-5-5" });

    await expect(model.send(request)).rejects.toBeInstanceOf(SpendLimitReached);
  });

  it("leaves any other error as it is", async () => {
    const body = { type: "error", error: { type: "invalid_request_error", message: "messages: too long" } };
    const error = Anthropic.APIError.generate(400, body, undefined, new Headers());
    const model = new AnthropicModel({ client: failingClient(error), modelId: "claude-opus-5-5" });

    await expect(model.send(request)).rejects.toBe(error);
  });

  it("marks a spend-limit 429 not to be retried, and leaves other 429s retryable", async () => {
    const answer = (body: unknown) => async () =>
      new Response(JSON.stringify(body), { status: 429, headers: { "content-type": "application/json" } });
    const busy = { type: "error", error: { type: "rate_limit_error", message: "Too many requests" } };

    const capped = await withoutSpendLimitRetries(answer(spendLimit429))("https://api.anthropic.com/v1/messages");
    const throttled = await withoutSpendLimitRetries(answer(busy))("https://api.anthropic.com/v1/messages");

    expect(capped.headers.get("x-should-retry")).toBe("false");
    expect(await capped.json()).toEqual(spendLimit429);
    expect(throttled.headers.get("x-should-retry")).toBeNull();
  });
});
