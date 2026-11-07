import { describe, expect, it } from "vitest";
import { SpendLimitReached, type ModelRequest } from "./model";
import { OpenAiCompatibleModel, isDailyQuota, toApiMessages } from "./openai-compatible-model";

// A stand-in for the endpoint: it records each request and answers from a list, so no test
// reaches the network.
function stubEndpoint(answers: Response[]) {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetchStub = (async (url: URL | RequestInfo, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    return next;
  }) as typeof fetch;
  const slept: number[] = [];
  const model = new OpenAiCompatibleModel({
    baseUrl: "https://models.example/v1beta/openai",
    apiKey: "test-key",
    modelId: "gemini-test",
    fetch: fetchStub,
    sleep: async (milliseconds) => {
      slept.push(milliseconds);
    },
  });
  return { model, sent, slept };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const request: ModelRequest = {
  system: "You are the agent.",
  tools: [{ name: "find_customer", description: "Find a customer.", inputSchema: { type: "object", properties: { q: { type: "string" } } } }],
  messages: [
    { role: "user", content: [{ type: "text", text: "Email E001" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Looking them up." },
        { type: "tool_call", id: "call-1", name: "find_customer", input: { q: "Maria" }, providerData: { google: { thought_signature: "sig-1" } } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", toolCallId: "call-1", content: "C001", isError: false }] },
  ],
};

describe("OpenAiCompatibleModel", () => {
  it("sends the system prompt, the tools and the history in the Chat Completions shape", async () => {
    const { model, sent } = stubEndpoint([json({ choices: [{ message: { content: "Done." }, finish_reason: "stop" }] })]);

    await model.send(request);

    expect(sent[0]?.url).toBe("https://models.example/v1beta/openai/chat/completions");
    expect(new Headers(sent[0]?.init.headers).get("authorization")).toBe("Bearer test-key");
    const body = JSON.parse(String(sent[0]?.init.body));
    expect(body.model).toBe("gemini-test");
    expect(body.tools[0]).toEqual({
      type: "function",
      function: { name: "find_customer", description: "Find a customer.", parameters: request.tools[0]?.inputSchema },
    });
    expect(body.messages).toEqual([
      { role: "system", content: "You are the agent." },
      { role: "user", content: "Email E001" },
      {
        role: "assistant",
        content: "Looking them up.",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "find_customer", arguments: '{"q":"Maria"}' },
            extra_content: { google: { thought_signature: "sig-1" } },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "C001" },
    ]);
  });

  it("reads tool calls, keeps their provider data, and counts them as tool use whatever the finish reason", async () => {
    const { model } = stubEndpoint([
      json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-2",
                  type: "function",
                  function: { name: "find_customer", arguments: '{"q":"Bayside"}' },
                  extra_content: { google: { thought_signature: "sig-2" } },
                },
              ],
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 30 },
      }),
    ]);

    const response = await model.send(request);

    expect(response.stopReason).toBe("tool_use");
    expect(response.usage).toEqual({ inputTokens: 120, outputTokens: 30 });
    expect(response.message.content).toEqual([
      { type: "tool_call", id: "call-2", name: "find_customer", input: { q: "Bayside" }, providerData: { google: { thought_signature: "sig-2" } } },
    ]);
  });

  it("hands arguments that are not JSON to the tool layer as they are, for its schema check to refuse", async () => {
    const { model } = stubEndpoint([
      json({ choices: [{ message: { tool_calls: [{ id: "c", type: "function", function: { name: "find_customer", arguments: "{oops" } }] } }] }),
    ]);

    const response = await model.send(request);

    expect(response.message.content[0]).toMatchObject({ type: "tool_call", input: "{oops" });
  });

  it("waits and retries when a minute's quota is used up", async () => {
    const { model, sent, slept } = stubEndpoint([
      json({ error: { details: [{ retryDelay: "7s" }] } }, 429),
      json({ choices: [{ message: { content: "Done." }, finish_reason: "stop" }] }),
    ]);

    const response = await model.send(request);

    expect(sent).toHaveLength(2);
    expect(slept).toEqual([7000]);
    expect(response.stopReason).toBe("end_turn");
  });

  it("stops with a spend limit, without retrying, when the day's free quota is used up", async () => {
    const { model, sent } = stubEndpoint([
      json({ error: { details: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] } }, 429),
    ]);

    await expect(model.send(request)).rejects.toBeInstanceOf(SpendLimitReached);
    expect(sent).toHaveLength(1);
  });

  it("gives up after a few retries, and never on a request the endpoint refuses", async () => {
    const busy = stubEndpoint([json({}, 503), json({}, 503), json({}, 503), json({}, 503)]);
    await expect(busy.model.send(request)).rejects.toThrow(/answered 503/);
    await expect(stubEndpoint([json({}, 503), json({}, 503), json({}, 503), json({}, 503)]).model.send(request)).rejects.toMatchObject({
      name: "model-busy",
    });
    expect(busy.sent).toHaveLength(4);

    const refused = stubEndpoint([json({ error: { message: "bad tool schema" } }, 400)]);
    await expect(refused.model.send(request)).rejects.toThrow(/answered 400: .*bad tool schema/);
    await expect(stubEndpoint([json({}, 400)]).model.send(request)).rejects.toMatchObject({ name: "model-refused-request" });
    expect(refused.sent).toHaveLength(1);
  });
});

describe("OpenAiCompatibleModel, speed", () => {
  it("asks for the reasoning effort it was given, and leaves it out otherwise", async () => {
    const answer = () => json({ choices: [{ message: { content: "Done." }, finish_reason: "stop" }] });
    const sentBodies: unknown[] = [];
    const fetchStub = (async (_url: URL | RequestInfo, init?: RequestInit) => {
      sentBodies.push(JSON.parse(String(init?.body)));
      return answer();
    }) as typeof fetch;

    await new OpenAiCompatibleModel({ baseUrl: "https://m.example", apiKey: "k", modelId: "g", reasoningEffort: "low", fetch: fetchStub }).send(request);
    await new OpenAiCompatibleModel({ baseUrl: "https://m.example", apiKey: "k", modelId: "g", fetch: fetchStub }).send(request);

    expect(sentBodies[0]).toMatchObject({ reasoning_effort: "low" });
    expect(sentBodies[1]).not.toHaveProperty("reasoning_effort");
  });

  it("fails a call that doesn't answer in time with a clear error, instead of hanging", async () => {
    const neverAnswers = ((_url: URL | RequestInfo, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    const model = new OpenAiCompatibleModel({ baseUrl: "https://m.example", apiKey: "k", modelId: "g", timeoutMs: 20, fetch: neverAnswers });

    await expect(model.send(request)).rejects.toThrow("The model didn’t answer within 0 s.");
    await expect(model.send(request)).rejects.toMatchObject({ name: "model-timeout" });
  });
});

describe("toApiMessages", () => {
  it("sends a failed tool's result marked as an error", () => {
    const messages = toApiMessages({
      system: "s",
      tools: [],
      messages: [{ role: "user", content: [{ type: "tool_result", toolCallId: "c", content: "No such SKU.", isError: true }] }],
    });

    expect(messages[1]).toEqual({ role: "tool", tool_call_id: "c", content: "Error: No such SKU." });
  });
});

describe("isDailyQuota", () => {
  it("tells a day's quota from a minute's", () => {
    expect(isDailyQuota('"quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier"')).toBe(true);
    expect(isDailyQuota('"quotaId": "GenerateRequestsPerMinutePerProjectPerModel-FreeTier"')).toBe(false);
  });
});
