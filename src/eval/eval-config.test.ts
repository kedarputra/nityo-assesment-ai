import { describe, expect, it } from "vitest";
import { EvalRefused, evalConfigFromEnv } from "./eval-config";

const localEnv = {
  ANTHROPIC_API_KEY: "sk-test",
  DATABASE_URL: "postgres://harbor:harbor@localhost:5432/harbor_point",
};

describe("the eval's configuration", () => {
  it("refuses to run without a model key", () => {
    expect(() => evalConfigFromEnv({ ...localEnv, ANTHROPIC_API_KEY: " " })).toThrow(EvalRefused);
    expect(() => evalConfigFromEnv({ ...localEnv, ANTHROPIC_API_KEY: undefined })).toThrow(/ANTHROPIC_API_KEY nor GEMINI_API_KEY/);
  });

  it("runs Gemini's free tier when only its key is set", () => {
    const config = evalConfigFromEnv({ ...localEnv, ANTHROPIC_API_KEY: undefined, GEMINI_API_KEY: "g" });
    expect(config.choice).toEqual({ provider: "gemini", modelId: "gemini-3.8-flash" });
    expect(config.modelId).toBe("gemini-3.8-flash");
  });

  it("refuses a database that is not on this machine, because each round resets it", () => {
    expect(() => evalConfigFromEnv({ ...localEnv, DATABASE_URL: "postgres://u:p@ep-cool-1.neon.tech/db" })).toThrow(
      /ep-cool-1\.neon\.tech.*local/,
    );
    expect(() => evalConfigFromEnv({ ...localEnv, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
    expect(() => evalConfigFromEnv({ ...localEnv, DATABASE_URL: "not a url" })).toThrow(EvalRefused);
  });

  it("prefers the unpooled URL, as the other database scripts do", () => {
    const config = evalConfigFromEnv({ ...localEnv, DATABASE_URL_UNPOOLED: "postgres://u:p@127.0.0.1/eval" });
    expect(config.connectionString).toBe("postgres://u:p@127.0.0.1/eval");
  });

  it("runs three rounds of the default model unless told otherwise", () => {
    expect(evalConfigFromEnv(localEnv)).toMatchObject({ rounds: 3, modelId: "claude-opus-5-5" });
    expect(evalConfigFromEnv({ ...localEnv, EVAL_RUNS: "1", ANTHROPIC_MODEL: "claude-sonnet-5" })).toMatchObject({
      rounds: 1,
      modelId: "claude-sonnet-5",
    });
    expect(() => evalConfigFromEnv({ ...localEnv, EVAL_RUNS: "0" })).toThrow(/EVAL_RUNS/);
    expect(() => evalConfigFromEnv({ ...localEnv, EVAL_RUNS: "three" })).toThrow(/EVAL_RUNS/);
  });
});
