import { modelIdFromEnv } from "@/model/anthropic-model";

// `make eval` calls the paid model and resets the database it runs on, so it refuses to start
// without a key, and refuses any database that is not on this machine.

export class EvalRefused extends Error {
  override name = "EvalRefused";
}

export interface EvalConfig {
  connectionString: string;
  modelId: string;
  rounds: number;
}

const DEFAULT_ROUNDS = 3;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function evalConfigFromEnv(env: Record<string, string | undefined>): EvalConfig {
  if (!env.ANTHROPIC_API_KEY?.trim()) {
    throw new EvalRefused("ANTHROPIC_API_KEY is not set. The eval runs the real model; see .env.example.");
  }
  return {
    connectionString: localConnectionString(env),
    modelId: modelIdFromEnv(env),
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
