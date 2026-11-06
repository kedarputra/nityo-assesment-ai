import { formatBusinessDay, formatBusinessTime } from "@/lib/business-clock";
import { formatUsd } from "@/lib/money";
import type { AuditEntry } from "@/server/audit/audit-log";

// The audit log (DESIGN.md, "Audit log"): when, who, what, which email, and the detail, newest
// first. Details hold what the model sent, so they are rendered only as text (security 4).
export function AuditLog({ events }: { events: AuditEntry[] }) {
  return (
    <div className="narrow">
      <h1 className="title">Audit log</h1>
      <p className="meta">Everything the agent did and every call a person made, newest first.</p>
      {events.length === 0 ? <NothingYet /> : <AuditTable events={events} />}
    </div>
  );
}

function NothingYet() {
  return (
    <div className="card audit-empty">
      <h2 className="headline">Nothing has happened yet</h2>
      <p>
        The agent hasn’t read any emails today, and no one has made a decision. Each step and each call will be listed
        here as it happens.
      </p>
    </div>
  );
}

function AuditTable({ events }: { events: AuditEntry[] }) {
  return (
    <div className="card audit-card">
      <table className="audit">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Who</th>
            <th scope="col">What</th>
            <th scope="col">Email</th>
            <th scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id}>
              <td className="num">
                <time dateTime={event.at.toISOString()}>
                  {formatBusinessDay(event.at)} {formatBusinessTime(event.at)}
                </time>
              </td>
              <td>{who(event)}</td>
              <td>{what(event)}</td>
              <td>{event.emailId ? <span className="id">{event.emailId}</span> : "–"}</td>
              <td className="audit-detail">{detailOf(event)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function who(event: AuditEntry): string {
  switch (event.actor) {
    case "agent":
      return event.username ? `Agent, started by ${event.username}` : "Agent";
    case "gate":
      return "Release gate";
    case "person":
      return event.username ?? "A person";
  }
}

function what(event: AuditEntry): string {
  const tool = typeof event.detail.tool === "string" ? event.detail.tool : "a tool";
  switch (event.action) {
    case "run.started":
      return "Started reading";
    case "run.finished":
      return `Finished: ${String(event.detail.outcome)}`;
    case "tool.called":
      return `Called ${tool}`;
    case "tool.refused":
      return `Refused a call to ${tool}`;
    case "gate.verdict":
      return event.detail.verdict === "released" ? "Every check passed" : "Sent to review";
    case "order.released":
      return `Released ${String(event.detail.soNumber)}`;
    default:
      return event.action;
  }
}

const DETAIL_CHARS = 240;

function detailOf(event: AuditEntry): string {
  const { detail } = event;
  switch (event.action) {
    case "tool.called":
    case "tool.refused":
      return clip(JSON.stringify(detail.input ?? {}) + (typeof detail.problem === "string" ? ` — ${detail.problem}` : ""));
    case "gate.verdict":
    case "order.released":
      return typeof detail.totalCents === "number" ? `Order total ${formatUsd(detail.totalCents)}` : "";
    default:
      return clip(JSON.stringify(detail));
  }
}

function clip(text: string): string {
  return text.length <= DETAIL_CHARS ? text : `${text.slice(0, DETAIL_CHARS)}…`;
}
