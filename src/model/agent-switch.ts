// The agent is switched on by a model key. A deploy with neither key serves the desk with the agent
// off: every page works, nothing calls a model, and nothing is spent (docs/deployment.md).
//
// Two providers: Anthropic when ANTHROPIC_API_KEY is set, otherwise Gemini's free tier when
// GEMINI_API_KEY is set. Kept free of any SDK import, so the header and pages can ask cheaply.

type Env = Record<string, string | undefined>;

export type ModelProvider = "anthropic" | "gemini";

export interface ModelChoice {
  provider: ModelProvider;
  modelId: string;
}

export const DEFAULT_ANTHROPIC_MODEL_ID = "claude-opus-5-5";
// The newest Flash on Gemini's free tier (aistudio.google.com/docs/pricing, November 2026).
export const DEFAULT_GEMINI_MODEL_ID = "gemini-3.8-flash";

function setting(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

export function modelChoiceFromEnv(env: Env = process.env): ModelChoice | null {
  if (setting(env, "ANTHROPIC_API_KEY")) {
    return { provider: "anthropic", modelId: setting(env, "ANTHROPIC_MODEL") ?? DEFAULT_ANTHROPIC_MODEL_ID };
  }
  if (setting(env, "GEMINI_API_KEY")) {
    return { provider: "gemini", modelId: setting(env, "GEMINI_MODEL") ?? DEFAULT_GEMINI_MODEL_ID };
  }
  return null;
}

export function isAgentConfigured(env: Env = process.env): boolean {
  return modelChoiceFromEnv(env) !== null;
}

export const AGENT_OFF_MESSAGE = "The agent is switched off on this desk for now, so it won’t read emails.";
