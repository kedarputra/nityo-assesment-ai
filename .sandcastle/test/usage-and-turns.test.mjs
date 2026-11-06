import assert from "node:assert/strict";
import { test } from "node:test";
import { afterTurn } from "../lib/turns.mjs";
import { collectUsage, isAllowanceSpent, sessionUsage, totalUsage } from "../lib/usage.mjs";

test("isAllowanceSpent knows the allowance messages and nothing else", () => {
  for (const message of [
    "claude exited with code 1:\nClaude AI usage limit reached|1761811200",
    "claude exited with code 1:\nYou've hit your limit · resets 3pm (Asia/Jakarta)",
    "You've hit your session limit · resets 5pm",
    "5-hour limit reached ∙ resets 2am",
    "Weekly limit reached ∙ resets Nov 3",
  ]) {
    assert.equal(isAllowanceSpent(new Error(message)), true, message);
  }
  for (const message of [
    "claude exited with code 1:\nAPI Error: 529 Overloaded",
    "Prompt is too long",
    "fatal: not a git repository",
    "rate limit exceeded, retrying in 5s",
  ]) {
    assert.equal(isAllowanceSpent(new Error(message)), false, message);
  }
});

const line = (id, usage) =>
  JSON.stringify({ type: "assistant", message: { id, usage } });

test("sessionUsage counts each API response once", () => {
  const jsonl = [
    JSON.stringify({ type: "user", message: { content: "hi" } }),
    line("m1", { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 5 }),
    line("m1", { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 5 }),
    line("m2", { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 110, output_tokens: 7 }),
    "not json",
  ].join("\n");
  assert.deepEqual(sessionUsage(jsonl), {
    inputTokens: 12,
    cacheCreationInputTokens: 100,
    cacheReadInputTokens: 110,
    outputTokens: 12,
  });
});

test("a resumed session's copied history is not counted twice", () => {
  const usage = { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 };
  const seen = new Map();
  collectUsage([line("m1", usage)].join("\n"), seen);
  collectUsage([line("m1", usage), line("m2", usage)].join("\n"), seen);
  assert.equal(totalUsage(seen).outputTokens, 2);
});

test("afterTurn: done on the promise, stop after idle turns or the turn limit", () => {
  const limits = { maxTurns: 4, maxIdle: 2 };
  assert.equal(afterTurn({ turn: 1, idle: 0, completed: true, progressed: false }, limits).action, "done");

  const first = afterTurn({ turn: 1, idle: 0, completed: false, progressed: false }, limits);
  assert.deepEqual(first, { action: "continue", idle: 1 });
  const second = afterTurn({ turn: 2, idle: first.idle, completed: false, progressed: false }, limits);
  assert.equal(second.action, "stop");
  assert.match(second.reason, /no progress in 2 turns/);

  const moving = afterTurn({ turn: 2, idle: 1, completed: false, progressed: true }, limits);
  assert.deepEqual(moving, { action: "continue", idle: 0 });
  const last = afterTurn({ turn: 4, idle: 0, completed: false, progressed: true }, limits);
  assert.equal(last.action, "stop");
  assert.match(last.reason, /after 4 turns/);
});
