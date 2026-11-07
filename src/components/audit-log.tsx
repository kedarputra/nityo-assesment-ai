import { formatBusinessDay, formatBusinessTime } from "@/lib/business-clock";
import { formatUsd } from "@/lib/money";
import type { AuditEntry } from "@/server/audit/audit-log";
import { checkName } from "./inbox/checks";

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
      if (event.detail.recheck === true) {
        return event.detail.verdict === "released" ? "Re-checked: every check passed" : "Re-checked: still waiting";
      }
      return event.detail.verdict === "released" ? "Every check passed" : "Sent to review";
    case "order.released":
      return `Released ${String(event.detail.soNumber)}`;
    case "proposal.edited":
      return "Edited the Proposal";
    case "proposal.override":
      return `Overrode “${checkName(String(event.detail.check))}”`;
    case "proposal.approved":
      return `Approved and released ${String(event.detail.soNumber)}`;
    case "proposal.approval_refused":
      return "Approval refused";
    case "proposal.rejected":
      return "Rejected";
    case "proposal.held":
      return "Put on hold";
    case "release.undone":
      return `Undid the release of ${String(event.detail.soNumber)}`;
    case "reply.ready":
      return "Marked the reply ready";
    case "proposal.superseded":
      return "Withdrew an undecided Proposal from an earlier run";
    case "inbox_run.started":
      return "Started Run all";
    case "inbox_run.ended":
      return `Run all ended: ${String(event.detail.reason)}`;
    case "snapshot.reset":
      return `Reset to 07:00 by ${String(event.detail.by)}`;
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
    case "proposal.approved":
      return typeof detail.totalCents === "number" ? `Order total ${formatUsd(detail.totalCents)}` : "";
    case "proposal.override":
      return clip(String(detail.note));
    case "proposal.rejected":
    case "proposal.held":
      return clip(String(detail.reason));
    case "proposal.edited":
      return clip(JSON.stringify(detail.edit ?? {}));
    default:
      return clip(JSON.stringify(detail));
  }
}

function clip(text: string): string {
  return text.length <= DETAIL_CHARS ? text : `${text.slice(0, DETAIL_CHARS)}…`;
}
