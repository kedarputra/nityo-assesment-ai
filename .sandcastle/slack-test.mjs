// Send sample events to the Slack webhook, with no run: to check the webhook and
// how each card looks. Every ticket, branch and effort in a message is a sample
// whose name starts with `tt-0000`.
//
//   npm run sandcastle:slack-test                         every event
//   npm run sandcastle:slack-test -- run-start round-end  only the named events
//   npm run sandcastle:slack-test -- --print              the text of each message; send nothing
//
// The settings come from .sandcastle/.env, as for a run; an exported value wins
// over the file. Each named event is sent, also one SANDCASTLE_SLACK_EVENTS leaves out.

import { readFileSync } from "node:fs";
import { createNotifier, EVENTS, payloadText, slackPayload, slackSettings } from "./lib/notify.mjs";

const ENV_FILE = new URL(".env", import.meta.url);

/** The SANDCASTLE_SLACK_* lines of .sandcastle/.env, read as main.mts reads the file. */
function loadSlackEnv() {
  let contents = "";
  try {
    contents = readFileSync(ENV_FILE, "utf8");
  } catch {
    // No file: rely on whatever is already exported.
  }
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(SANDCASTLE_SLACK_[A-Z_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const value = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    if (value && process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

const EFFORTS = ["tt-0000-slack-test"];
const ticket = { id: "tt-0000-01", title: "Sample ticket from slack-test", project: "frontend" };

/** Each event's data, in the shape main.mts sends it. */
const SAMPLE = {
  "run-start": { parallel: 2, rounds: 5 },
  "round-start": {
    round: 1,
    rounds: 5,
    ready: [ticket, { ...ticket, id: "tt-0000-03", stage: "implemented" }],
    held: [{ id: "tt-0000-02", reason: "Blocked by tt-0000-01" }],
  },
  "round-error": { round: 1, ticket, reason: "Sample: the sandbox exited with code 1." },
  "round-end": {
    round: 1,
    rounds: 5,
    seconds: 1830,
    tickets: [
      { ...ticket, outcome: "complete", closed: true },
      { ...ticket, id: "tt-0000-03", outcome: "failed", detail: "Sample: the ticket's checks failed" },
    ],
  },
  "full-check-start": {
    project: "frontend",
    base: "feat/tt-0000-slack-test",
    state: "pending",
    final: true,
    minutes: 40,
  },
  "full-check": {
    project: "frontend",
    base: "feat/tt-0000-slack-test",
    status: "red",
    reason: "Sample: 2 tests failed",
    final: true,
    seconds: 754,
  },
  "allowance-spent": {},
  "run-end": {
    summary: {
      elapsedSeconds: 8130,
      ticketsStarted: 2,
      resumed: 1,
      complete: 1,
      incomplete: 0,
      failed: 1,
      notStarted: 0,
      mergedAndClosed: 1,
      secondsPerClosedTicket: 8130,
      usage: { inputTokens: 18_400, outputTokens: 212_000, cacheReadInputTokens: 9_870_000, cacheCreationInputTokens: 640_000 },
    },
    roundsRun: 2,
    rounds: 5,
    tickets: [
      { ...ticket, outcome: "complete", closed: true },
      { ...ticket, id: "tt-0000-03", outcome: "failed", detail: "Sample: the ticket's checks failed" },
    ],
    checks: [
      { project: "frontend", base: "feat/tt-0000-slack-test", status: "green", final: false, round: 2, seconds: 690 },
      { project: "frontend", base: "feat/tt-0000-slack-test", status: "red", final: true, seconds: 754 },
    ],
    record: ".sandcastle/runs/sample.json",
    checkStop: null,
    allowanceSpent: false,
    notOnOrigin: [["feat/tt-0000-slack-test in frontend", "Sample: push refused"]],
  },
  "run-stopped": { reason: "Sample: Ctrl-C", record: ".sandcastle/runs/sample.json", notOnOrigin: [] },
};

const args = process.argv.slice(2);
const print = args.includes("--print");
const named = args.filter((arg) => !arg.startsWith("--"));
const events = named.length > 0 ? named : EVENTS;

const unknown = events.filter((event) => !EVENTS.includes(event));
if (unknown.length > 0) {
  console.error(`No event called ${unknown.join(", ")}. The events are: ${EVENTS.join(", ")}.`);
  process.exit(1);
}

loadSlackEnv();
const settings = slackSettings(process.env);

if (print) {
  const shown = settings ?? { webhook: "", events: new Set(EVENTS), mention: "<!here>", machine: "print" };
  for (const event of events) {
    console.log(`----- ${event}\n${payloadText(slackPayload(event, SAMPLE[event], shown, EFFORTS))}\n`);
  }
  process.exit(0);
}

if (!settings) {
  console.error("SANDCASTLE_SLACK_WEBHOOK_URL is empty in .sandcastle/.env. Set it, or use --print.");
  process.exit(1);
}

let failed = false;
const notifier = createNotifier(
  { ...settings, events: new Set(events) },
  {
    efforts: EFFORTS,
    log: (line) => {
      failed = true;
      console.error(line);
    },
  },
);
for (const event of events) notifier.notify(event, SAMPLE[event]);
await notifier.flush();

if (failed) {
  console.error("A post failed: see above.");
  process.exit(1);
}
console.log(`Sent ${events.length} event(s) to Slack: ${events.join(", ")}.`);
