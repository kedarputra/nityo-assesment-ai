import { modelChoiceFromEnv, type ModelChoice } from "@/model/agent-switch";

// `make eval` calls the real model and resets the database it runs on, so it refuses to start
// without a key, and refuses any database that is not on this machine.

export class EvalRefused extends Error {
  override name = "EvalRefused";
}

export interface EvalConfig {
  connectionString: string;
  choice: ModelChoice;
  modelId: string;
  rounds: number;
}

const DEFAULT_ROUNDS = 3;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function evalConfigFromEnv(env: Record<string, string | undefined>): EvalConfig {
  const choice = modelChoiceFromEnv(env);
  if (choice === null) {
    throw new EvalRefused("Neither ANTHROPIC_API_KEY nor GEMINI_API_KEY is set. The eval runs the real model; see .env.example.");
  }
  return {
    connectionString: localConnectionString(env),
    choice,
    modelId: choice.modelId,
    rounds: roundsFrom(env.EVAL_RUNS),
  };
}

function localConnectionString(env: Record<string, string | undefined>): string {
  const connectionString = env.DATABASE_URL_UNPOOLED || env.DATABASE_URL;
  if (!connectionString) throw new EvalRefused("DATABASE_URL (or DATABASE_URL_UNPOOLED) is not set; point it at a local Postgres.");
  let host: string;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    throw new EvalRefused("DATABASE_URL is not a URL.");
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new EvalRefused(`The database is on ${host}; each eval round resets it to the Snapshot, so it must be local.`);
  }
  return connectionString;
}

function roundsFrom(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_ROUNDS;
  if (!/^[1-9]\d*$/.test(value.trim())) throw new EvalRefused(`EVAL_RUNS must be a whole number of runs, not ${JSON.stringify(value)}.`);
  return Number(value.trim());
}
