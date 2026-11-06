import assert from "node:assert/strict";
import { test } from "node:test";
import { createNotifier, EVENTS, payloadText, slackPayload, slackSettings } from "../lib/notify.mjs";

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/XXXX";

test("slackSettings is off with no webhook, and sends every event by default", () => {
  assert.equal(slackSettings({}), null);
  assert.equal(slackSettings({ SANDCASTLE_SLACK_WEBHOOK_URL: "  " }), null);

  const settings = slackSettings({ SANDCASTLE_SLACK_WEBHOOK_URL: WEBHOOK, SANDCASTLE_SLACK_MACHINE: "mac" });
  assert.deepEqual([...settings.events], EVENTS);
  assert.equal(settings.machine, "mac");
  assert.equal(settings.mention, "");
  assert.deepEqual(
    [...slackSettings({ SANDCASTLE_SLACK_WEBHOOK_URL: WEBHOOK, SANDCASTLE_SLACK_EVENTS: "all" }).events],
    EVENTS,
  );
});

test("slackSettings keeps only the named events, and refuses a name it does not know", () => {
  const settings = slackSettings({
    SANDCASTLE_SLACK_WEBHOOK_URL: WEBHOOK,
    SANDCASTLE_SLACK_EVENTS: " round-start, round-error ,run-end",
  });
  assert.deepEqual([...settings.events], ["round-start", "round-error", "run-end"]);

  assert.throws(
    () => slackSettings({ SANDCASTLE_SLACK_WEBHOOK_URL: WEBHOOK, SANDCASTLE_SLACK_EVENTS: "round-start,round-fail" }),
    /round-fail/,
  );
  assert.throws(() => slackSettings({ SANDCASTLE_SLACK_WEBHOOK_URL: "http://example.com" }), /https/);
});

const settings = { webhook: WEBHOOK, events: new Set(EVENTS), mention: "<!here>", machine: "mac" };

const blocksOf = (payload) => payload.attachments[0].blocks;

test("each event is a card: the name above it, a header, and the efforts below", () => {
  for (const [event, data] of [
    ["run-start", { parallel: 3, rounds: 10 }],
    ["round-start", { round: 1, rounds: 3, ready: [], held: [] }],
    ["round-error", { round: 1, ticket: { id: "a/01", project: "frontend" }, reason: "x" }],
    ["round-end", { round: 1, rounds: 1, seconds: 60, tickets: [] }],
    ["full-check-start", { project: "backend", base: "feat/x", state: "pending", final: false, minutes: 60 }],
    ["full-check", { project: "backend", base: "feat/x", status: "green" }],
    ["allowance-spent", {}],
    ["run-end", { summary: {}, roundsRun: 0, rounds: 1, checkStop: null, allowanceSpent: false, notOnOrigin: [] }],
    ["run-stopped", { reason: "Ctrl-C", record: "r.json", notOnOrigin: [] }],
  ]) {
    const payload = slackPayload(event, data, settings, ["tt-1-a"]);
    assert.match(payload.text, /^\*\[mac\]\*/, event);
    assert.equal(payload.attachments.length, 1, event);
    assert.match(payload.attachments[0].color, /^#[0-9A-F]{6}$/, event);
    const blocks = blocksOf(payload);
    assert.equal(blocks[0].type, "header", event);
    assert.ok(blocks[0].text.text.length <= 150, event);
    assert.deepEqual(blocks.at(-1), { type: "context", elements: [{ type: "mrkdwn", text: "sandcastle · tt-1-a" }] }, event);
    for (const block of blocks) {
      if (block.type === "section" && block.text) assert.ok(block.text.text.length <= 3000, event);
      assert.ok((block.fields ?? []).length <= 10, event);
    }
  }
});

test("round-start lists each ready ticket and each held one with its reason", () => {
  const payload = slackPayload(
    "round-start",
    {
      round: 1,
      rounds: 3,
      ready: [
        { id: "tt-1-a/01", title: "Add the <Button>", project: "frontend", stage: "new" },
        { id: "tt-1-a/02", title: "Route", project: "backend", stage: "implemented" },
      ],
      held: [{ id: "tt-1-a/03", reason: "blocked by tt-1-a/01 & tt-1-a/02" }],
    },
    settings,
    ["tt-1-a"],
  );
  const text = payloadText(payload);
  assert.equal(blocksOf(payload)[0].text.text, ":arrow_forward: Round 1/3 started");
  assert.match(text, /\*Ready\*\n2/);
  assert.match(text, /`tt-1-a\/01` Add the &lt;Button&gt; \(frontend\)/);
  assert.match(text, /`tt-1-a\/02` Route \(backend, resumes at implemented\)/);
  assert.match(text, /`tt-1-a\/03`: blocked by tt-1-a\/01 &amp; tt-1-a\/02/);
  assert.equal(payload.text, "*[mac]*", "a round start is no alert");
});

test("round-error names the ticket and the reason, with the mention above the card", () => {
  const payload = slackPayload(
    "round-error",
    { round: 2, ticket: { id: "tt-1-a/01", title: "Add", project: "frontend" }, reason: "failed: Error: boom" },
    settings,
  );
  assert.equal(payload.text, "*[mac]*\n<!here>");
  assert.equal(blocksOf(payload)[0].text.text, ":x: Round 2: error");
  const text = payloadText(payload);
  assert.match(text, /\*Ticket\*\n`tt-1-a\/01` Add/);
  assert.match(text, /\*Project\*\nfrontend/);
  assert.match(text, /\*Reason\*\n```failed: Error: boom```/);
  assert.match(text, /sandcastle · every effort$/);
});

test("round-end gives each ticket its outcome, whether it merged, and why it stopped", () => {
  const payload = slackPayload(
    "round-end",
    {
      round: 1,
      rounds: 1,
      seconds: 3900,
      tickets: [
        { id: "a/01", title: "One", outcome: "complete", closed: true },
        { id: "a/02", title: "Two", outcome: "complete", closed: false },
        { id: "a/03", title: "Three", outcome: "incomplete", detail: "the reviewer did not sign off" },
      ],
    },
    settings,
  );
  const text = payloadText(payload);
  assert.match(text, /\*Merged and closed\*\n1 of 3/);
  assert.match(text, /\*Took\*\n1 h 5 min/);
  assert.match(text, /`a\/01` One: complete, merged and closed/);
  assert.match(text, /`a\/02` Two: complete, not merged/);
  assert.match(text, /`a\/03` Three: incomplete: the reviewer did not sign off/);
  assert.equal(payload.attachments[0].color, "#ECB22E", "not all closed, none failed: yellow");
});

test("a long list is cut, and says how many it left out", () => {
  const held = Array.from({ length: 40 }, (_, i) => ({ id: `a/${i}`, reason: "blocked ".repeat(30) }));
  const payload = slackPayload("round-start", { round: 1, rounds: 1, ready: [], held }, settings);
  const text = payloadText(payload);
  assert.equal(blocksOf(payload)[0].text.text, ":double_vertical_bar: Round 1/1: no ticket can start");
  assert.match(text, /… and 15 more/);
  assert.ok(blocksOf(payload).filter((block) => block.type === "section").length > 2, "split under the section limit");
});

test("a red full check is an alert, a green one is not", () => {
  const red = slackPayload("full-check", { project: "backend", base: "feat/x", status: "red", reason: "lint" }, settings);
  assert.equal(red.text, "*[mac]*\n<!here>");
  assert.equal(red.attachments[0].color, "#E01E5A");
  const green = slackPayload("full-check", { project: "backend", base: "feat/x", status: "green" }, settings);
  assert.equal(green.text, "*[mac]*");
  assert.equal(green.attachments[0].color, "#2EB67D");
});

test("a full check sends its start, and the final one says so at start and end", () => {
  const start = slackPayload(
    "full-check-start",
    { project: "frontend", base: "feat/x", state: "pending", final: false, round: 3, minutes: 40 },
    settings,
  );
  assert.equal(blocksOf(start)[0].text.text, ":mag: Full check started");
  assert.match(payloadText(start), /\*Before\*\nround 3/);
  assert.equal(start.text, "*[mac]*", "a start is no alert");
  const startText = payloadText(start);
  assert.match(startText, /\*Time limit\*\n40 min/);
  assert.match(startText, /Before tickets build on the checkout\. The tip is pending: .*the fixer runs/);

  const finalStart = slackPayload(
    "full-check-start",
    { project: "frontend", base: "feat/x", state: "unchecked", final: true },
    settings,
  );
  assert.equal(blocksOf(finalStart)[0].text.text, ":mag: Final full check started");
  assert.match(payloadText(finalStart), /its tickets are held/);

  const finalEnd = slackPayload(
    "full-check",
    { project: "frontend", base: "feat/x", status: "red", reason: "lint", final: true, seconds: 754 },
    settings,
  );
  assert.equal(blocksOf(finalEnd)[0].text.text, ":red_circle: Final full check did not pass");
  assert.match(payloadText(finalEnd), /\*Took\*\n13 min/);
  const fixed = slackPayload("full-check", { project: "p", base: "b", status: "fixed", final: true }, settings);
  assert.equal(blocksOf(fixed)[0].text.text, ":large_green_circle: Final full check fixed");
});

test("run-end gives the run's numbers, each ticket and each full check", () => {
  const payload = slackPayload(
    "run-end",
    {
      summary: {
        elapsedSeconds: 8130,
        ticketsStarted: 3,
        resumed: 1,
        complete: 2,
        incomplete: 0,
        failed: 1,
        notStarted: 0,
        mergedAndClosed: 2,
        secondsPerClosedTicket: 4065,
        usage: { inputTokens: 950, outputTokens: 212_000, cacheReadInputTokens: 9_870_000, cacheCreationInputTokens: 0 },
      },
      roundsRun: 5,
      rounds: 10,
      tickets: [
        { id: "a/01", title: "One", outcome: "complete", closed: true },
        { id: "a/02", title: "Two", outcome: "failed", detail: "boom" },
      ],
      checks: [
        { project: "backend", base: "feat/x", status: "green", final: false, round: 2, seconds: 600 },
        { project: "backend", base: "feat/x", status: "red", final: true, seconds: 900 },
      ],
      record: ".sandcastle/runs/r.json",
      checkStop: null,
      allowanceSpent: false,
      notOnOrigin: [],
    },
    settings,
  );
  assert.equal(blocksOf(payload)[0].text.text, ":checkered_flag: Run ended");
  const text = payloadText(payload);
  assert.match(text, /\*Took\*\n2 h 16 min/);
  assert.match(text, /\*Rounds with tickets\*\n5 \(at most 10\)/);
  assert.match(text, /\*Tickets started\*\n3, 1 resumed/);
  assert.match(text, /\*Merged and closed\*\n2 of 3, 1 h 8 min each/);
  assert.match(text, /\*Outcomes\*\n2 complete, 0 incomplete, 1 failed, 0 not started/);
  assert.match(text, /\*Full checks\*\n1 of 2 passed \(backend 2\); not passed: backend final: red/);
  assert.match(text, /:large_green_circle: backend `feat\/x`: green, before round 2, 10 min/);
  assert.match(text, /\*Tokens\*\n950 in, 212\.0k out, 9\.87M cache read, 0 cache write/);
  assert.match(text, /\*Run record\*\n`\.sandcastle\/runs\/r\.json`/);
  assert.match(text, /`a\/01` One: complete, merged and closed/);
  assert.match(text, /`a\/02` Two: failed: boom/);
  assert.match(text, /:red_circle: backend `feat\/x`: red, final, 15 min/);
  assert.equal(payload.text, "*[mac]*", "a clean end is no alert");
});

test("the notifier sends only the chosen events, in order, and a failed post does not throw", async () => {
  const posted = [];
  const logged = [];
  const notifier = createNotifier(
    { ...settings, events: new Set(["run-start", "round-error"]) },
    {
      post: async (url, body) => {
        const text = payloadText(body);
        if (text.includes("Run started")) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (text.includes("second")) throw new Error("no_service");
        posted.push(text);
      },
      log: (line) => logged.push(line),
    },
  );
  const ticket = { id: "a/01", project: "frontend" };
  notifier.notify("run-start", { parallel: 3, rounds: 10 });
  notifier.notify("round-start", { round: 1, rounds: 10, ready: [], held: [] });
  notifier.notify("round-error", { round: 1, ticket, reason: "first" });
  notifier.notify("round-error", { round: 1, ticket, reason: "second" });
  notifier.notify("round-error", { round: 1, ticket, reason: "third" });
  await notifier.flush();

  assert.equal(posted.length, 3);
  assert.match(posted[0], /Run started/);
  assert.match(posted[1], /first/);
  assert.match(posted[2], /third/);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /no_service/);
});

test("with no settings the notifier does nothing", async () => {
  const notifier = createNotifier(null, {
    post: () => assert.fail("nothing is posted"),
  });
  assert.equal(notifier.enabled, false);
  notifier.notify("run-start", { parallel: 1, rounds: 1 });
  notifier.notifySync("run-stopped", { reason: "x", notOnOrigin: [] });
  await notifier.flush();
});
