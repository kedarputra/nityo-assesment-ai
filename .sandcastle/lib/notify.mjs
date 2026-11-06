// Slack notifications for a run's events, through one incoming webhook.
//
// Off unless SANDCASTLE_SLACK_WEBHOOK_URL is set, in .sandcastle/.env or exported.
// A notification never stops or slows a run: posts go out one at a time, in the
// order of the events, behind the run's back; a failed post is reported once on
// the console, and the run goes on.
//
//   SANDCASTLE_SLACK_WEBHOOK_URL  the incoming webhook (https://hooks.slack.com/services/...)
//   SANDCASTLE_SLACK_EVENTS       the events to send, comma-separated; empty or `all` sends every one
//   SANDCASTLE_SLACK_MENTION      put before each alert, e.g. `<@U0123ABCD>` or `<!here>`
//   SANDCASTLE_SLACK_MACHINE      the name a message gives this machine; the host name by default

import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { duration } from "./duration.mjs";
import { fullCheckLine } from "./run-record.mjs";

/** Every event a run sends, in the order a run sends them. */
export const EVENTS = [
  "run-start",
  "round-start",
  "round-error",
  "round-end",
  "full-check-start",
  "full-check",
  "allowance-spent",
  "run-end",
  "run-stopped",
];

/** The settings from `env`, or null when no webhook is set. Throws on a wrong value. */
export function slackSettings(env) {
  const webhook = (env.SANDCASTLE_SLACK_WEBHOOK_URL ?? "").trim();
  if (!webhook) return null;
  if (!/^https:\/\//.test(webhook)) {
    throw new Error("SANDCASTLE_SLACK_WEBHOOK_URL must be an https:// URL, a Slack incoming webhook.");
  }

  const raw = (env.SANDCASTLE_SLACK_EVENTS ?? "").trim();
  let events = new Set(EVENTS);
  if (raw && raw !== "all") {
    const named = raw.split(",").map((event) => event.trim()).filter(Boolean);
    const unknown = named.filter((event) => !EVENTS.includes(event));
    if (unknown.length > 0) {
      throw new Error(
        `SANDCASTLE_SLACK_EVENTS names no event called ${unknown.join(", ")}. ` +
          `The events are: ${EVENTS.join(", ")}.`,
      );
    }
    events = new Set(named);
  }

  return {
    webhook,
    events,
    mention: (env.SANDCASTLE_SLACK_MENTION ?? "").trim(),
    machine: (env.SANDCASTLE_SLACK_MACHINE ?? "").trim() || hostname(),
  };
}

// ---------------------------------------------------------------------------
// The message for each event
// ---------------------------------------------------------------------------
//
// Each message is a Block Kit card inside an attachment, so it has a colored bar:
// a header, fields in two columns, then sections and a footer. The top-level
// text holds the machine's name and, on an alert, the mention: Slack shows it
// above the card, and a mention there notifies.

const LIST_LIMIT = 25;
const SECTION_LIMIT = 2900; // Slack refuses a section text past 3000 characters.

const COLOR = {
  info: "#439FE0",
  good: "#2EB67D",
  warn: "#ECB22E",
  bad: "#E01E5A",
  idle: "#9AA0A6",
};

/** Slack's mrkdwn gives `&`, `<` and `>` a meaning; text from a run must not. */
const esc = (text) => String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const clip = (text, limit) => {
  const flat = String(text ?? "").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

/** At most LIST_LIMIT lines, and a count of the rest. */
const capped = (lines) =>
  lines.length > LIST_LIMIT
    ? [...lines.slice(0, LIST_LIMIT), `… and ${lines.length - LIST_LIMIT} more`]
    : lines;

/** A titled list, as the text of a section. */
const list = (title, lines) => `*${title}*\n${capped(lines).join("\n")}`;

/** Text from a run, such as an error, in a code block. */
const code = (text, limit = 1500) => `\`\`\`${esc(clip(text, limit))}\`\`\``;

const ticketName = (ticket) =>
  `\`${esc(ticket.id)}\`${ticket.title ? ` ${esc(clip(ticket.title, 120))}` : ""}`;

const unpushed = (notOnOrigin) =>
  list(
    `:warning: Only on this machine, ${notOnOrigin.length}: push by hand`,
    notOnOrigin.map(([what, why]) => `• ${esc(what)} (${esc(clip(why, 200))})`),
  );

const OUTCOME_ICON = {
  complete: ":white_check_mark:",
  incomplete: ":hourglass_flowing_sand:",
  failed: ":x:",
  "not-started": ":double_vertical_bar:",
};

/** One ticket's outcome, whether it merged, and why it stopped. */
const ticketLine = (ticket) => {
  const outcome = ticket.outcome ?? "unfinished";
  const merge = outcome === "complete" ? (ticket.closed ? ", merged and closed" : ", not merged") : "";
  const detail = ticket.detail ? `: ${esc(clip(ticket.detail, 300))}` : "";
  return `${OUTCOME_ICON[outcome] ?? "•"} ${ticketName(ticket)}: ${esc(outcome)}${merge}${detail}`;
};

/** A token count, short: 950, 12.3k, 4.56M. */
const tokens = (count) => {
  const n = Number(count) || 0;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
};

/** The full check before a round's tickets, or the final one after the last round. */
const checkName = (final) => (final ? "Final full check" : "Full check");

/** When a check ran: a project's tip is checked again after each round that merged into it. */
const checkWhen = (check) => (check.final ? "final" : check.round ? `before round ${check.round}` : "before a round");

/** Why a full check runs, and what a red does, by the tip's state (lib/check-branch.mjs). */
const CHECK_WHY = {
  pending: "this run's merges made it; when red, the fixer runs",
  unchecked: "it moved outside a run, or was never checked; when red, its tickets are held",
};

const CHECK_ICON = {
  green: ":large_green_circle:",
  fixed: ":large_green_circle:",
  red: ":red_circle:",
};

/**
 * Each event's card, from what the run knows when it sends it: `title` (plain
 * text, emoji allowed), `color`, `fields` as [label, mrkdwn] pairs, `sections`
 * as mrkdwn, and `alert` when it takes the mention.
 */
const MESSAGES = {
  "run-start": ({ parallel, rounds }) => ({
    title: ":rocket: Run started",
    color: COLOR.info,
    fields: [
      ["At a time", `up to ${parallel} ticket(s)`],
      ["Rounds", `at most ${rounds}`],
    ],
  }),

  "round-start": ({ round, rounds, ready, held }) => {
    const sections = [];
    if (ready.length > 0) {
      sections.push(
        list(
          "Ready",
          ready.map(
            (ticket) =>
              `• ${ticketName(ticket)} (${esc(ticket.project)}` +
              `${ticket.stage && ticket.stage !== "new" ? `, resumes at ${esc(ticket.stage)}` : ""})`,
          ),
        ),
      );
    }
    if (held.length > 0) {
      sections.push(list("Held", held.map((ticket) => `• \`${esc(ticket.id)}\`: ${esc(clip(ticket.reason, 300))}`)));
    }
    return {
      title: ready.length > 0 ? `:arrow_forward: Round ${round}/${rounds} started` : `:double_vertical_bar: Round ${round}/${rounds}: no ticket can start`,
      color: ready.length > 0 ? COLOR.info : COLOR.idle,
      fields: [
        ["Ready", String(ready.length)],
        ["Held", String(held.length)],
      ],
      sections,
    };
  },

  "round-error": ({ round, ticket, reason }) => ({
    alert: true,
    title: `:x: Round ${round}: error`,
    color: COLOR.bad,
    fields: [
      ["Ticket", ticketName(ticket)],
      ["Project", esc(ticket.project)],
    ],
    sections: [`*Reason*\n${code(reason)}`],
  }),

  "round-end": ({ round, rounds, seconds, tickets }) => {
    const closed = tickets.filter((ticket) => ticket.closed).length;
    const failed = tickets.some((ticket) => ticket.outcome === "failed");
    return {
      title: `:checkered_flag: Round ${round}/${rounds} ended`,
      color: failed ? COLOR.bad : closed === tickets.length ? COLOR.good : COLOR.warn,
      fields: [
        ["Merged and closed", `${closed} of ${tickets.length}`],
        ["Took", duration(seconds)],
      ],
      sections: [
        list(
          "Tickets",
          tickets.map(ticketLine),
        ),
      ],
    };
  },

  "full-check-start": ({ project, base, state, final, round, minutes }) => {
    const fields = [
      ["Project", esc(project)],
      ["Branch", `\`${esc(base)}\``],
    ];
    if (!final && round) fields.push(["Before", `round ${round}`]);
    if (minutes) fields.push(["Time limit", `${minutes} min`]);
    const when = final ? "The last merges, before the run ends." : "Before tickets build on the checkout.";
    const why = CHECK_WHY[state] ? ` The tip is ${esc(state)}: ${CHECK_WHY[state]}.` : "";
    return {
      title: `:mag: ${checkName(final)} started`,
      color: COLOR.info,
      fields,
      sections: [`${when}${why}`],
    };
  },

  "full-check": ({ project, base, status, reason, final, seconds }) => {
    const fields = [
      ["Project", esc(project)],
      ["Branch", `\`${esc(base)}\``],
    ];
    if (seconds !== undefined && seconds !== null) fields.push(["Took", duration(seconds)]);
    const name = checkName(final);
    if (status === "green") return { title: `:large_green_circle: ${name} passed`, color: COLOR.good, fields };
    if (status === "fixed") {
      return {
        title: `:large_green_circle: ${name} fixed`,
        color: COLOR.good,
        fields,
        sections: ["It was red, and the fixer made it green."],
      };
    }
    return {
      alert: true,
      title: `:red_circle: ${name} did not pass`,
      color: COLOR.bad,
      fields,
      sections: [`*Reason*\n${code(reason)}`],
    };
  },

  "allowance-spent": () => ({
    title: ":battery: Usage allowance spent",
    color: COLOR.warn,
    sections: [
      "No new model call starts. Clean merges and closes still happen. " +
        "Run again after the allowance resets, and the tickets resume.",
    ],
  }),

  "run-end": ({ summary = {}, roundsRun = 0, rounds, tickets = [], checks = [], record, checkStop, allowanceSpent, notOnOrigin }) => {
    const s = summary;
    const started = s.ticketsStarted ?? 0;
    const fields = [
      ["Took", duration(s.elapsedSeconds ?? 0)],
      ["Rounds with tickets", `${roundsRun}${rounds ? ` (at most ${rounds})` : ""}`],
      ["Tickets started", `${started}${s.resumed ? `, ${s.resumed} resumed` : ""}`],
      [
        "Merged and closed",
        `${s.mergedAndClosed ?? 0} of ${started}` +
          (s.secondsPerClosedTicket ? `, ${duration(s.secondsPerClosedTicket)} each` : ""),
      ],
      [
        "Outcomes",
        `${s.complete ?? 0} complete, ${s.incomplete ?? 0} incomplete, ` +
          `${s.failed ?? 0} failed, ${s.notStarted ?? 0} not started`,
      ],
    ];
    if (checks.length > 0) fields.push(["Full checks", esc(clip(fullCheckLine(checks), 1500))]);
    if (s.usage) {
      fields.push([
        "Tokens",
        `${tokens(s.usage.inputTokens)} in, ${tokens(s.usage.outputTokens)} out, ` +
          `${tokens(s.usage.cacheReadInputTokens)} cache read, ${tokens(s.usage.cacheCreationInputTokens)} cache write`,
      ]);
    }
    if (record) fields.push(["Run record", `\`${esc(record)}\``]);

    const sections = [];
    if (checkStop) sections.push(`*Why it ended early*\n${code(checkStop)}`);
    if (allowanceSpent) sections.push("The usage allowance is spent.");
    if (tickets.length > 0) sections.push(list("Tickets", tickets.map(ticketLine)));
    if (checks.length > 0) {
      sections.push(
        list(
          "Full checks",
          checks.map(
            (check) =>
              `${CHECK_ICON[check.status] ?? ":grey_question:"} ${esc(check.project)} \`${esc(check.base)}\`: ` +
              `${esc(check.status ?? "unfinished")}, ${checkWhen(check)}` +
              (check.seconds ? `, ${duration(check.seconds)}` : ""),
          ),
        ),
      );
    }
    if (notOnOrigin.length > 0) sections.push(unpushed(notOnOrigin));
    const alert = Boolean(checkStop) || notOnOrigin.length > 0;
    return {
      alert,
      title: checkStop ? ":octagonal_sign: Run ended early" : ":checkered_flag: Run ended",
      color: alert ? COLOR.bad : allowanceSpent ? COLOR.warn : COLOR.good,
      fields,
      sections,
    };
  },

  "run-stopped": ({ reason, record, notOnOrigin }) => {
    const sections = [`*Reason*\n${code(reason)}`, "Run the same command again to resume."];
    if (notOnOrigin.length > 0) sections.push(unpushed(notOnOrigin));
    return {
      alert: true,
      title: ":octagonal_sign: Run stopped",
      color: COLOR.bad,
      fields: record ? [["Run record", `\`${esc(record)}\``]] : [],
      sections,
    };
  },
};

/** One or more section blocks for a text, split at line ends under Slack's limit. */
function sections(text) {
  const blocks = [];
  let chunk = "";
  for (const line of text.split("\n")) {
    const next = chunk ? `${chunk}\n${line}` : line;
    if (next.length > SECTION_LIMIT && chunk) {
      blocks.push(chunk);
      chunk = clip(line, SECTION_LIMIT);
    } else {
      chunk = clip(next, SECTION_LIMIT);
    }
  }
  if (chunk) blocks.push(chunk);
  return blocks.map((part) => ({ type: "section", text: { type: "mrkdwn", text: part } }));
}

/**
 * The webhook payload for one event: the machine's name in bold, and the mention
 * on an alert, above a card with the event, and a footer with the efforts.
 */
export function slackPayload(event, data, settings, efforts = []) {
  const message = MESSAGES[event](data);
  const scope = efforts.length > 0 ? efforts.map(esc).join(", ") : "every effort";
  const mention = message.alert && settings.mention ? `\n${settings.mention}` : "";

  const blocks = [{ type: "header", text: { type: "plain_text", text: clip(message.title, 150), emoji: true } }];
  const fields = message.fields ?? [];
  if (fields.length > 0) {
    blocks.push({
      type: "section",
      fields: fields.map(([label, value]) => ({ type: "mrkdwn", text: clip(`*${label}*\n${value}`, 2000) })),
    });
  }
  for (const text of message.sections ?? []) blocks.push(...sections(text));
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `sandcastle · ${scope}` }] });

  return {
    text: `*[${esc(settings.machine)}]*${mention}`,
    attachments: [{ color: message.color, fallback: message.title, blocks }],
  };
}

/** Every piece of text in a payload, in order: what a reader sees, for tests and logs. */
export function payloadText(payload) {
  const out = [payload.text];
  for (const attachment of payload.attachments ?? []) {
    for (const block of attachment.blocks ?? []) {
      if (block.text) out.push(block.text.text);
      for (const field of block.fields ?? []) out.push(field.text);
      for (const element of block.elements ?? []) out.push(element.text);
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One POST, with one retry when Slack asks to slow down. */
export async function postJson(url, body) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 429 && attempt === 1) {
      await sleep(Math.min(Number(response.headers.get("retry-after")) || 1, 30) * 1000);
      continue;
    }
    if (!response.ok) {
      throw new Error(`Slack answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    return;
  }
}

// For `notifySync`: a child Node posts the payload on stdin, so a process `exit`
// listener, which cannot wait for a promise, can still send one message.
const POST_SCRIPT =
  "const body=require('fs').readFileSync(0,'utf8');" +
  "fetch(process.env.SANDCASTLE_SLACK_POST_URL,{method:'POST',headers:{'content-type':'application/json'}," +
  "body,signal:AbortSignal.timeout(8000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))";

/**
 * A notifier for `settings` (null turns it off). `notify` queues a post and
 * returns at once; `flush` waits for the queue; `notifySync` sends one message
 * before it returns, for the process's `exit`.
 */
export function createNotifier(settings, { efforts = [], post = postJson, log = console.error } = {}) {
  let queue = Promise.resolve();
  let warned = false;
  const wanted = (event) => Boolean(settings) && settings.events.has(event);
  const warn = (error) => {
    if (warned) return;
    warned = true;
    log(`  ✗ Slack: a notification was not sent, and the run goes on: ${error?.message ?? error}`);
  };

  return {
    enabled: Boolean(settings),
    events: settings ? [...settings.events] : [],

    notify(event, data) {
      if (!wanted(event)) return;
      let body;
      try {
        body = slackPayload(event, data, settings, efforts);
      } catch (error) {
        warn(error);
        return;
      }
      queue = queue.then(() => post(settings.webhook, body)).catch(warn);
    },

    flush() {
      return queue;
    },

    notifySync(event, data) {
      if (!wanted(event)) return;
      try {
        execFileSync(process.execPath, ["-e", POST_SCRIPT], {
          input: JSON.stringify(slackPayload(event, data, settings, efforts)),
          env: { ...process.env, SANDCASTLE_SLACK_POST_URL: settings.webhook },
          stdio: ["pipe", "ignore", "ignore"],
          timeout: 10_000,
        });
      } catch (error) {
        warn(error);
      }
    },
  };
}
