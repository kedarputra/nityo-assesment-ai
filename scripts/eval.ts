// `make eval`: a live run of the real model over all 40 emails, scored against the walkthrough
// (issue 11). A person runs it; it is never part of `make verify` or `make check`, because it
// calls a real model. Each round resets the local database to the Snapshot first.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import * as schema from "@/db/schema";
import { EvalRefused, evalConfigFromEnv } from "@/eval/eval-config";
import { readExpectedOutcomes } from "@/eval/expected-outcomes";
import { evalReport, type EvalRound } from "@/eval/report";
import { evalRound } from "@/eval/run-eval";
import { scoreRun } from "@/eval/score";
import { modelFor } from "@/model/configured-model";

const reportDirectory = "eval-reports";

async function main(): Promise<void> {
  const config = evalConfigFromEnv(process.env);
  const expected = readExpectedOutcomes();
  const startedAt = new Date();
  const reportFile = path.join(reportDirectory, `eval-${startedAt.toISOString().replaceAll(":", "-")}.md`);
  mkdirSync(reportDirectory, { recursive: true });

  const client = new Client({ connectionString: config.connectionString });
  await client.connect();
  try {
    const db = drizzle({ client, schema });
    await migrate(db, { migrationsFolder: "./drizzle" });
    const rounds: EvalRound[] = [];
    for (let round = 1; round <= config.rounds; round += 1) {
      const model = modelFor(config.choice);
      const results = await evalRound(db, model, config.modelId, (emailId) => {
        console.log(`eval: run ${round} of ${config.rounds}, ${emailId}`);
      });
      rounds.push({ score: scoreRun(expected, results), results });
      // Written after every round, so a run stopped part-way keeps what it paid for.
      writeFileSync(reportFile, evalReport({ modelId: config.modelId, startedAt, rounds }));
    }
    console.log(`eval: report written to ${reportFile}`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof EvalRefused ? `eval: ${error.message}` : error);
  process.exitCode = 1;
});
