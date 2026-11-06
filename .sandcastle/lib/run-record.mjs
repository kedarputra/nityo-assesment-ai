// What a run did and how long each part took, written as it goes.
//
// One JSON file per run under `.sandcastle/runs/`, rewritten after every
// event, so a run killed part-way still leaves its timings up to that point. It is
// the measurement two runs are compared by: tickets per hour, elapsed time per
// completed ticket, fresh against resumed, and token use where the session gave it.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { duration } from "./duration.mjs";
import { addUsage, NO_USAGE } from "./usage.mjs";

const now = () => new Date().toISOString();
const seconds = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 1000);

/** When a check ran. A project's tip is checked again after each round that merged into it. */
const checkWhen = (check) => (check.final ? "final" : check.round ? `before round ${check.round}` : "before a round");

/**
 * The full checks in one line: how many passed, how many each project had, and
 * each one that did not pass, with when it ran.
 */
export function fullCheckLine(checks) {
  if (checks.length === 0) return "none";
  const passed = (check) => check.status === "green" || check.status === "fixed";
  const perProject = new Map();
  for (const check of checks) perProject.set(check.project, (perProject.get(check.project) ?? 0) + 1);
  const counts = [...perProject].map(([project, count]) => `${project} ${count}`).join(", ");
  const bad = checks
    .filter((check) => !passed(check))
    .map((check) => `${check.project} ${checkWhen(check)}: ${check.status ?? "unfinished"}`);
  return (
    `${checks.filter(passed).length} of ${checks.length} passed (${counts})` +
    (bad.length > 0 ? `; not passed: ${bad.join(", ")}` : "")
  );
}

export class RunRecord {
  /** `dir: null` keeps the record in memory only, as a dry run does. */
  constructor({ dir, settings }) {
    this.started = now();
    this.path = dir ? join(dir, `${this.started.replace(/[:.]/g, "-")}.json`) : null;
    if (dir) mkdirSync(dir, { recursive: true });
    this.data = {
      started: this.started,
      settings,
      iterations: [],
      tickets: {},
      merges: [],
      checks: [],
    };
    this.save();
  }

  save() {
    if (!this.path) return;
    writeFileSync(this.path, `${JSON.stringify(this.data, null, 2)}\n`);
  }

  iteration(number, { ready, held }) {
    const entry = {
      number,
      started: now(),
      ready: ready.map((ticket) => ticket.id),
      held,
    };
    this.data.iterations.push(entry);
    this.save();
    return entry;
  }

  endIteration(entry) {
    entry.ended = now();
    entry.seconds = seconds(entry.started, entry.ended);
    this.save();
  }

  /** The ticket's entry, created on first use. One per ticket per run. */
  ticket(ticket) {
    this.data.tickets[ticket.id] ??= {
      project: ticket.project,
      branch: ticket.branch,
      queued: now(),
      phases: [],
      usage: null,
    };
    return this.data.tickets[ticket.id];
  }

  /** Times `work` as one phase of a ticket. Returns what `work` returns. */
  async phase(ticket, name, work) {
    const entry = { name, started: now() };
    const record = this.ticket(ticket);
    record.started ??= entry.started;
    record.phases.push(entry);
    this.save();
    try {
      return await work((usage) => {
        if (!usage) return;
        entry.usage = addUsage(entry.usage ?? NO_USAGE, usage);
        record.usage = addUsage(record.usage ?? NO_USAGE, usage);
      });
    } finally {
      entry.ended = now();
      entry.seconds = seconds(entry.started, entry.ended);
      this.save();
    }
  }

  note(ticket, fields) {
    Object.assign(this.ticket(ticket), fields);
    this.save();
  }

  merge(ticket, outcome) {
    this.data.merges.push({ id: ticket.id, project: ticket.project, at: now(), ...outcome });
    this.save();
  }

  /**
   * Starts the entry for one full check of a project's checkout. The caller
   * fills it in (`status`, `fixer`, `attempt`) and calls `endCheck`.
   */
  check(fields) {
    const entry = { started: now(), ...fields };
    this.data.checks.push(entry);
    this.save();
    return entry;
  }

  endCheck(entry, fields) {
    Object.assign(entry, fields, { ended: now() });
    entry.seconds = seconds(entry.started, entry.ended);
    this.save();
  }

  /** Closes the record and returns the summary lines to print. */
  finish(extra = {}) {
    const ended = now();
    const tickets = Object.entries(this.data.tickets);
    const count = (outcome) => tickets.filter(([, t]) => t.outcome === outcome).length;
    const merged = tickets.filter(([, t]) => t.closed).length;
    const hours = seconds(this.started, ended) / 3600;

    let usage = null;
    for (const [, ticket] of tickets) {
      if (ticket.usage) usage = addUsage(usage ?? NO_USAGE, ticket.usage);
    }

    const waits = tickets
      .filter(([, t]) => t.started)
      .map(([, t]) => seconds(t.queued, t.started));

    this.data.summary = {
      ended,
      elapsedSeconds: seconds(this.started, ended),
      ticketsStarted: tickets.filter(([, t]) => t.started).length,
      resumed: tickets.filter(([, t]) => t.resumed).length,
      complete: count("complete"),
      incomplete: count("incomplete"),
      failed: count("failed"),
      notStarted: count("not-started"),
      mergedAndClosed: merged,
      ticketsPerHour: hours > 0 ? Number((merged / hours).toFixed(2)) : null,
      secondsPerClosedTicket: merged > 0 ? Math.round(seconds(this.started, ended) / merged) : null,
      longestQueueWaitSeconds: waits.length > 0 ? Math.max(...waits) : 0,
      fullChecks: this.data.checks.map((c) => `${c.project} ${checkWhen(c)}: ${c.status ?? "unfinished"}`),
      usage,
      ...extra,
    };
    this.save();

    const s = this.data.summary;
    return [
      `Run record: ${this.path}`,
      `  ${duration(s.elapsedSeconds)} elapsed; ${s.ticketsStarted} ticket(s) started (${s.resumed} resumed from an earlier run)`,
      `  ${s.complete} complete, ${s.incomplete} incomplete, ${s.failed} failed, ${s.notStarted} not started`,
      `  ${s.mergedAndClosed} merged and closed` +
        (s.ticketsPerHour !== null
          ? ` — ${s.ticketsPerHour}/hour, ${duration(s.secondsPerClosedTicket)} each`
          : ""),
      `  full checks: ${fullCheckLine(this.data.checks)}`,
      usage
        ? `  tokens: ${usage.inputTokens} in, ${usage.cacheCreationInputTokens} cache write, ` +
          `${usage.cacheReadInputTokens} cache read, ${usage.outputTokens} out`
        : "  tokens: not captured",
    ];
  }
}
