// The agent talks to a model only through this interface, so tests and checks can script it
// with a fake and never call a paid API. A tool call's input is the model's output: it is
// untrusted, and the tool layer validates it against a schema before it runs.

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's input; its top level is always an object. */
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolCall {
  type: "tool_call";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  type: "tool_result";
  toolCallId: string;
  content: string;
  isError?: boolean;
}

// A model that reasons before it calls a tool needs that reasoning handed back unchanged on the
// next turn, so the assistant's turn keeps it rather than dropping it.
export interface Reasoning {
  type: "reasoning";
  text: string;
  signature: string;
}

export interface RedactedReasoning {
  type: "redacted_reasoning";
  data: string;
}

export interface UserMessage {
  role: "user";
  content: Array<TextBlock | ToolResult>;
}

export interface AssistantMessage {
  role: "assistant";
  content: Array<TextBlock | ToolCall | Reasoning | RedactedReasoning>;
}

export type ModelMessage = UserMessage | AssistantMessage;

export interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  tools: ToolDefinition[];
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface ModelResponse {
  message: AssistantMessage;
  stopReason: StopReason;
}

export interface Model {
  send(request: ModelRequest): Promise<ModelResponse>;
}

export function toolCallsIn(message: AssistantMessage): ToolCall[] {
  return message.content.filter((block): block is ToolCall => block.type === "tool_call");
}

export function textIn(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}
