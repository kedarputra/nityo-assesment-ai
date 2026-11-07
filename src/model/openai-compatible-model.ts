import {
  SpendLimitReached,
  type AssistantMessage,
  type Model,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type StopReason,
  type ToolDefinition,
} from "./model";

// A model behind an OpenAI-compatible Chat Completions endpoint. The app uses it for Gemini's free
// tier (docs/deployment.md, "The model"), so a deploy can run the agent without paying. Plain
// fetch, no SDK: the endpoint is one POST.

const MAX_TOKENS = 16_000;
// A free tier answers 429 when a minute's quota is used up; waiting is the cure. A day's quota is
// not, so it is treated as a spend limit and never retried.
const MAX_RETRIES = 3;
const DEFAULT_RETRY_SECONDS = 10;
const MAX_RETRY_SECONDS = 30;

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface ApiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  extra_content?: unknown;
}

type ApiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "tool"; tool_call_id: string; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ApiToolCall[] };

interface ApiResponse {
  choices?: { message?: { content?: string | null; tool_calls?: ApiToolCall[] }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAiCompatibleModel implements Model {
  private readonly fetch: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async send(request: ModelRequest): Promise<ModelResponse> {
    const body = JSON.stringify({
      model: this.options.modelId,
      max_tokens: MAX_TOKENS,
      messages: toApiMessages(request),
      tools: request.tools.map(toApiTool),
      tool_choice: "auto",
    });
    const reply = await this.post(body);
    return fromApiResponse(reply);
  }

  private async post(body: string): Promise<ApiResponse> {
    const url = new URL("chat/completions", withTrailingSlash(this.options.baseUrl));
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` },
        body,
      });
      if (response.ok) return (await response.json()) as ApiResponse;

      const text = await response.text();
      if (response.status === 429 && isDailyQuota(text)) throw new SpendLimitReached();
      const retryable = response.status === 429 || response.status === 500 || response.status === 503;
      if (!retryable || attempt >= MAX_RETRIES) {
        // The body is the provider's error, never the key; cut short so a log line stays a line.
        throw new Error(`The model endpoint answered ${response.status}: ${text.slice(0, 500)}`);
      }
      await this.sleep(retrySeconds(response, text) * 1000);
    }
  }
}

function withTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

// Gemini names the quota it ran out of, such as "GenerateRequestsPerDayPerProjectPerModel-FreeTier".
export function isDailyQuota(body: string): boolean {
  return /PerDay/i.test(body);
}

function retrySeconds(response: Response, body: string): number {
  const header = Number(response.headers.get("retry-after"));
  const fromBody = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  const seconds = Number.isFinite(header) && header > 0 ? header : fromBody ? Number(fromBody[1]) : DEFAULT_RETRY_SECONDS;
  return Math.min(Math.ceil(seconds), MAX_RETRY_SECONDS);
}

function toApiTool(tool: ToolDefinition) {
  return {
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  };
}

export function toApiMessages(request: ModelRequest): ApiMessage[] {
  const messages: ApiMessage[] = [{ role: "system", content: request.system }];
  for (const message of request.messages) messages.push(...toApiMessage(message));
  return messages;
}

function toApiMessage(message: ModelMessage): ApiMessage[] {
  if (message.role === "user") {
    // Tool results answer the assistant's calls, so they come first, each as its own message.
    const results: ApiMessage[] = [];
    const texts: string[] = [];
    for (const block of message.content) {
      if (block.type === "tool_result") {
        results.push({
          role: "tool",
          tool_call_id: block.toolCallId,
          content: block.isError ? `Error: ${block.content}` : block.content,
        });
      } else {
        texts.push(block.text);
      }
    }
    return texts.length === 0 ? results : [...results, { role: "user", content: texts.join("\n\n") }];
  }

  const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  const toolCalls = message.content.flatMap((block): ApiToolCall[] =>
    block.type === "tool_call"
      ? [
          {
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
            ...(block.providerData === undefined ? {} : { extra_content: block.providerData }),
          },
        ]
      : [],
  );
  // Reasoning blocks are Anthropic's; this endpoint carries its own in each call's extra_content.
  return [{ role: "assistant", content: text === "" ? null : text, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) }];
}

export function fromApiResponse(reply: ApiResponse): ModelResponse {
  const choice = reply.choices?.[0];
  const content: AssistantMessage["content"] = [];
  if (choice?.message?.content) content.push({ type: "text", text: choice.message.content });
  for (const call of choice?.message?.tool_calls ?? []) {
    content.push({
      type: "tool_call",
      id: call.id,
      name: call.function.name,
      input: parseArguments(call.function.arguments),
      ...(call.extra_content === undefined ? {} : { providerData: call.extra_content }),
    });
  }
  const hasToolCalls = content.some((block) => block.type === "tool_call");
  return {
    message: { role: "assistant", content },
    // Some providers say "stop" on a turn that calls tools; the calls are what count.
    stopReason: hasToolCalls ? "tool_use" : fromFinishReason(choice?.finish_reason ?? null),
    usage: { inputTokens: reply.usage?.prompt_tokens ?? 0, outputTokens: reply.usage?.completion_tokens ?? 0 },
  };
}

// The model's arguments are untrusted; arguments that are not JSON go to the tool layer as they
// are, and its schema check turns them into a tool error the model can correct.
function parseArguments(text: string): unknown {
  try {
    return JSON.parse(text === "" ? "{}" : text);
  } catch {
    return text;
  }
}

function fromFinishReason(reason: string | null): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}
