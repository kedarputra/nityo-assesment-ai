import Anthropic from "@anthropic-ai/sdk";
import type {
  AssistantMessage,
  Model,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  StopReason,
  ToolDefinition,
} from "./model";

export const DEFAULT_MODEL_ID = "claude-opus-5-5";

// Large enough that a turn with reasoning and several tool calls is not cut off, and small
// enough for a non-streaming request to stay inside the SDK's HTTP timeout.
const MAX_TOKENS = 16_000;

export function modelIdFromEnv(env: Record<string, string | undefined> = process.env): string {
  const configured = env.ANTHROPIC_MODEL?.trim();
  return configured ? configured : DEFAULT_MODEL_ID;
}

/** The one part of the SDK client this model uses; tests hand in a stub. */
export interface MessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export class AnthropicModel implements Model {
  private readonly modelId: string;
  private client: MessagesClient | undefined;

  constructor(options: { client?: MessagesClient; modelId?: string } = {}) {
    this.client = options.client;
    this.modelId = options.modelId ?? modelIdFromEnv();
  }

  async send(request: ModelRequest): Promise<ModelResponse> {
    const reply = await this.messagesClient().messages.create({
      model: this.modelId,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      system: request.system,
      tools: request.tools.map(toApiTool),
      messages: request.messages.map(toApiMessage),
    });
    return {
      message: { role: "assistant", content: reply.content.map(fromApiBlock) },
      stopReason: fromApiStopReason(reply.stop_reason),
    };
  }

  // Created on first use, so building or importing the app needs no API key.
  private messagesClient(): MessagesClient {
    this.client ??= new Anthropic();
    return this.client;
  }
}

function toApiTool(tool: ToolDefinition): Anthropic.Tool {
  return { name: tool.name, description: tool.description, input_schema: tool.inputSchema };
}

function toApiMessage(message: ModelMessage): Anthropic.MessageParam {
  if (message.role === "user") {
    return {
      role: "user",
      content: message.content.map((block): Anthropic.TextBlockParam | Anthropic.ToolResultBlockParam => {
        if (block.type === "text") return { type: "text", text: block.text };
        return {
          type: "tool_result",
          tool_use_id: block.toolCallId,
          content: block.content,
          is_error: block.isError,
        };
      }),
    };
  }
  return { role: "assistant", content: message.content.map(toApiAssistantBlock) };
}

function toApiAssistantBlock(block: AssistantMessage["content"][number]): Anthropic.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_call":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "reasoning":
      return { type: "thinking", thinking: block.text, signature: block.signature };
    case "redacted_reasoning":
      return { type: "redacted_thinking", data: block.data };
  }
}

function fromApiBlock(block: Anthropic.ContentBlock): AssistantMessage["content"][number] {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return { type: "tool_call", id: block.id, name: block.name, input: block.input };
    case "thinking":
      return { type: "reasoning", text: block.thinking, signature: block.signature };
    case "redacted_thinking":
      return { type: "redacted_reasoning", data: block.data };
    default:
      // The app defines no server tools, so any other block is unexpected; dropping it would
      // send the model a history that is not what it wrote.
      throw new Error(`The model replied with a ${block.type} block, which the app does not handle.`);
  }
}

function fromApiStopReason(reason: Anthropic.StopReason | null): StopReason {
  switch (reason) {
    case "end_turn":
    case "tool_use":
    case "max_tokens":
    case "refusal":
      return reason;
    default:
      return "other";
  }
}
