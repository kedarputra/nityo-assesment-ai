import { modelChoiceFromEnv, type ModelChoice } from "./agent-switch";
import { AnthropicModel } from "./anthropic-model";
import type { Model } from "./model";
import { OpenAiCompatibleModel } from "./openai-compatible-model";

// Gemini's OpenAI-compatible endpoint (aistudio.google.com/docs/openai).
export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

// Gemini 3 thinks at length by default; "low" keeps each tool call to seconds (docs/deployment.md).
export const DEFAULT_GEMINI_REASONING_EFFORT = "low";

// The model the env switches on, or null when the agent is off. Callers check the switch first.
export function configuredModel(env: Record<string, string | undefined> = process.env): { model: Model; choice: ModelChoice } | null {
  const choice = modelChoiceFromEnv(env);
  if (choice === null) return null;
  return { model: modelFor(choice, env), choice };
}

export function modelFor(choice: ModelChoice, env: Record<string, string | undefined> = process.env): Model {
  if (choice.provider === "anthropic") return new AnthropicModel({ modelId: choice.modelId });
  return new OpenAiCompatibleModel({
    // Overridable for a local stand-in of the endpoint; production leaves it unset.
    baseUrl: env.GEMINI_BASE_URL?.trim() || GEMINI_BASE_URL,
    apiKey: env.GEMINI_API_KEY?.trim() ?? "",
    modelId: choice.modelId,
    reasoningEffort: env.GEMINI_REASONING_EFFORT?.trim() || DEFAULT_GEMINI_REASONING_EFFORT,
  });
}
