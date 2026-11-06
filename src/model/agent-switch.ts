// The agent is switched on by its key. A deploy without ANTHROPIC_API_KEY serves the desk with the
// agent off: every page works, nothing calls the model, and nothing is spent (docs/deployment.md).
export function isAgentConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim());
}

export const AGENT_OFF_MESSAGE = "The agent is switched off on this desk for now, so it won’t read emails.";
