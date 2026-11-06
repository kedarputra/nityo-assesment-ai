import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentRuns } from "@/db/schema";
import { ScriptedModel } from "@/model/scripted-model";
import { ingestSnapshot } from "@/snapshot/snapshot";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import { e001Script } from "@/test/e001-script";
import { readExpectedOutcomes } from "./expected-outcomes";
import { evalRound } from "./run-eval";
import { scoreRun } from "./score";

const MODEL_ID = "claude-opus-5-5";

describe("one eval round", () => {
  let testDatabase: TestDatabase;

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    await ingestSnapshot(testDatabase.db);
  });

  afterEach(async () => {
    await testDatabase.close();
  });

  it("resets to the Snapshot, runs every email in received order, and reads back what each run did", async () => {
    const { db } = testDatabase;
    // An earlier round's runs; the Reset must clear them, or the agent would refuse to rerun E001.
    await evalRound(db, new ScriptedModel(e001Script()), MODEL_ID);

    // The script covers E001, the first email; every later email finds the script spent and fails.
    const results = await evalRound(db, new ScriptedModel(e001Script()), MODEL_ID);

    expect(results).toHaveLength(40);
    expect(results.slice(0, 2).map((result) => result.emailId)).toEqual(["E001", "E002"]);
    expect(results[15]?.emailId).toBe("E033");
    expect(results[0]).toMatchObject({
      emailId: "E001",
      outcome: "released",
      errorClass: null,
      flags: [],
      proposals: [
        {
          status: "released",
          shipToId: "S001",
          failingChecks: [],
          lines: [
            { sku: "HPS-1408", quantity: 4, unitPriceCents: 4500 },
            { sku: "HPS-1402", quantity: 6, unitPriceCents: 7100 },
            { sku: "HPS-1502", quantity: 2, unitPriceCents: 3300 },
          ],
        },
      ],
      modelCalls: 9,
      inputTokens: 9_000,
      outputTokens: 1_800,
    });
    expect(results[0]?.costMicroUsd).toBeGreaterThan(0);
    expect(results[1]).toMatchObject({ emailId: "E002", outcome: "failed", errorClass: "Error", proposals: [] });
    expect(await db.$count(agentRuns)).toBe(40);

    const score = scoreRun(readExpectedOutcomes(), results);
    expect(score.unsafeReleases).toEqual([]);
    expect(score.outcomes.matches).toBe(1);
    expect(score.priceMismatches).toEqual([]);
  });
});
