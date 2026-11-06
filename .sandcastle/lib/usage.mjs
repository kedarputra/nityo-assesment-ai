// Reading the model's allowance and token use out of what a run leaves behind.

import { readFileSync } from "node:fs";

/**
 * Whether an agent failed because the account's usage allowance is spent.
 *
 * Claude Code exits non-zero with the reason in its output, and sandcastle puts
 * that output in the error's message. The wording has changed across versions
 * ("Claude AI usage limit reached|<epoch>", "You've hit your limit · resets 3pm",
 * "5-hour limit reached ∙ resets …"), so this matches the parts they share. A
 * plain rate limit (HTTP 429, retried by the CLI itself) is not the allowance.
 */
const ALLOWANCE_SPENT =
  /usage limit reached|hit your (?:\w+ )?limit|(?:session|weekly|5-hour|opus) limit reached|limit reached\W+resets|out of extra usage/i;

export function isAllowanceSpent(error) {
  const text = String(error?.message ?? error ?? "") + String(error?.cause?.message ?? "");
  return ALLOWANCE_SPENT.test(text);
}

export const NO_USAGE = Object.freeze({
  inputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 0,
});

export function addUsage(a, b) {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

/**
 * Adds a Claude Code session's API responses to `byMessage`, keyed by message id.
 *
 * Sandcastle's own `usage` is the last message's snapshot, which says how full the
 * context ended, not what the session cost. Every API response is one assistant
 * message with its own `usage`. The JSONL repeats a message once per content
 * block, and a resumed session carries its parent's messages again, so keying by
 * id counts each response once however many files it appears in.
 */
export function collectUsage(jsonl, byMessage = new Map()) {
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.includes('"usage"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry?.message;
    if (entry?.type !== "assistant" || !message?.usage) continue;
    byMessage.set(message.id ?? `line-${byMessage.size}`, message.usage);
  }
  return byMessage;
}

/** The summed usage of the responses `collectUsage` gathered. */
export function totalUsage(byMessage) {
  let total = { ...NO_USAGE };
  for (const usage of byMessage.values()) {
    total = addUsage(total, {
      inputTokens: usage.input_tokens ?? 0,
      cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
    });
  }
  return total;
}

/** The tokens one session JSONL used. */
export const sessionUsage = (jsonl) => totalUsage(collectUsage(jsonl));

/**
 * Adds the sessions a sandcastle run captured to `byMessage`. A session file that
 * cannot be read is skipped: the total is then a floor, never an overcount.
 */
export function collectRunUsage(result, byMessage = new Map()) {
  for (const iteration of result?.iterations ?? []) {
    if (!iteration.sessionFilePath) continue;
    try {
      collectUsage(readFileSync(iteration.sessionFilePath, "utf8"), byMessage);
    } catch {
      // Unreadable: leave it out.
    }
  }
  return byMessage;
}
