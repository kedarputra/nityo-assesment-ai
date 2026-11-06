import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureWorktree } from "../lib/branch-state.mjs";
import { git } from "../lib/git.mjs";
import { reviewDiff } from "../lib/review-diff.mjs";
import { duration } from "../lib/duration.mjs";
import { fullCheckLine, RunRecord } from "../lib/run-record.mjs";
import { makeRepo, write } from "./helpers.mjs";

const BASE = "feat/tt-1-effort";

test("reviewDiff names generated files but leaves them out of the diff", (t) => {
  const repo = makeRepo(t);
  const { path } = ensureWorktree(repo, "sandcastle/issue-01-a", BASE);
  write(path, "src/feature.ts", "export const feature = true;\n");
  write(path, "package-lock.json", '{"lockfileVersion": 3}\n');
  write(path, "src/api/models/Generated.ts", "export type Generated = {};\n");
  write(path, "drizzle/migrations/meta/0001_snapshot.json", "{}\n");
  write(path, "drizzle/migrations/meta/_journal.json", '{"entries": []}\n');
  git(path, ["add", "-A"]);
  git(path, ["commit", "--quiet", "-m", "RALPH: feature"]);

  const diff = reviewDiff(path, BASE);
  assert.match(diff.commits, /RALPH: feature/);
  for (const file of ["package-lock.json", "src/api/models/Generated.ts", "0001_snapshot.json", "_journal.json"]) {
    assert.match(diff.summary, new RegExp(file.replace(/[.]/g, "\\.")), `${file} is listed`);
  }
  assert.match(diff.diff, /src\/feature\.ts/);
  assert.match(diff.diff, /_journal\.json/, "the journal is small and stays in the diff");
  assert.doesNotMatch(diff.diff, /package-lock|Generated\.ts|_snapshot/);
  assert.match(diff.note, /complete/);
});

test("reviewDiff cuts a long diff on a file boundary and names what it cut", (t) => {
  const repo = makeRepo(t);
  const { path } = ensureWorktree(repo, "sandcastle/issue-01-a", BASE);
  for (const name of ["a", "b", "c"]) write(path, `src/${name}.ts`, `${"x".repeat(400)}\n`);
  git(path, ["add", "-A"]);
  git(path, ["commit", "--quiet", "-m", "three files"]);

  const diff = reviewDiff(path, BASE, { limitBytes: 900 });
  assert.match(diff.note, /cut at/);
  assert.match(diff.note, /src\/c\.ts/);
  assert.doesNotMatch(diff.diff, /src\/c\.ts/);
  assert.match(diff.diff, /src\/a\.ts/);
});

test("RunRecord times phases and summarises the run", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-record-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const record = new RunRecord({ dir, settings: { parallel: 3 } });
  const a = { id: "01-a", project: "backend", branch: "sandcastle/issue-01-a" };
  const b = { id: "02-b", project: "backend", branch: "sandcastle/issue-02-b" };

  const result = await record.phase(a, "implement", async (report) => {
    report({ inputTokens: 1, cacheCreationInputTokens: 2, cacheReadInputTokens: 3, outputTokens: 4 });
    return "done";
  });
  assert.equal(result, "done");
  record.note(a, { outcome: "complete", resumed: true, closed: true });
  record.note(b, { outcome: "not-started" });

  const lines = record.finish();
  const saved = JSON.parse(readFileSync(record.path, "utf8"));
  assert.equal(saved.summary.complete, 1);
  assert.equal(saved.summary.notStarted, 1);
  assert.equal(saved.summary.resumed, 1);
  assert.equal(saved.summary.mergedAndClosed, 1);
  assert.equal(saved.summary.usage.outputTokens, 4);
  assert.equal(saved.tickets["01-a"].phases[0].name, "implement");
  assert.match(lines.join("\n"), /1 merged and closed/);
  assert.match(lines.join("\n"), /under 1 min elapsed/, "no bare seconds");
  assert.doesNotMatch(lines.join("\n"), /\d+s (elapsed|each)/);
});

test("duration gives minutes under an hour, and hours and minutes past it", () => {
  assert.equal(duration(11531), "3 h 12 min");
  assert.equal(duration(769), "13 min");
  assert.equal(duration(3600), "1 h 0 min");
  assert.equal(duration(20), "under 1 min");
  assert.equal(duration(undefined), "");
});

test("fullCheckLine counts the checks of each project once, and names each that did not pass", () => {
  const checks = [
    { project: "backend", status: "green", round: 1 },
    { project: "frontend", status: "green", round: 1 },
    { project: "backend", status: "fixed", round: 2 },
    { project: "backend", status: "red", round: 3 },
    { project: "frontend", status: "green", final: true },
  ];
  assert.equal(
    fullCheckLine(checks),
    "4 of 5 passed (backend 3, frontend 2); not passed: backend before round 3: red",
  );
  assert.equal(fullCheckLine([]), "none");
});
