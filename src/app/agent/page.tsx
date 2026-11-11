import { Bot, CalendarClock, Hand, Play } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { RefreshWhileReading } from "@/components/inbox-run";
import { AgentControls } from "@/components/agent/agent-controls";
import { isHandled, mailHref } from "@/components/mail/folders";
import { ProcessingBox } from "@/components/mail/processing-box";
import { PresenceDot, PRESENCE_WORDS } from "@/components/shell/presence-badge";
import { getDatabase } from "@/db/client";
import { formatBusinessTime } from "@/lib/business-clock";
import { requireUser } from "@/server/auth/current-user";
import { loadDeskEmails, loadPresence } from "@/server/desk/load";
import { listRecentRuns } from "@/server/desk/runs";

export const metadata: Metadata = { title: "Agent · Harbor Point" };
export const maxDuration = 300;

const OUTCOME_WORDS: Record<string, string> = {
  released: "Released",
  proposal: "Proposal",
  routed: "Routed",
  no_action: "No action",
  failed: "Didn’t finish",
};

// The agent's page (ADR 0005): whether it is on, what it is reading, how to start it by role, and
// what it did last.
export default async function AgentPage() {
  const user = await requireUser();
  const [presence, emails, runs] = await Promise.all([loadPresence(), loadDeskEmails(), listRecentRuns(getDatabase())]);
  const isAdmin = user.role === "admin";
  const waiting = emails.filter((email) => email.status === "not_run" || email.status === "failed").length;

  return (
    <div className="page-pad agent-page">
      <RefreshWhileReading active={presence.reading.length > 0 || presence.runAll !== null} />
      <header className="page-head">
        <h1 className="page-title">Agent activity</h1>
        <p className="page-lede">What the agent is doing now, how to start it, and its latest runs.</p>
      </header>

      <div className="agent-grid">
        <section className={`presence-card presence-card--${presence.state}`} aria-label="Agent status">
          <div className="presence-card-head">
            <span className="presence-avatar" aria-hidden="true">
              <Bot size={22} />
              <PresenceDot state={presence.state} />
            </span>
            <div>
              <h2 className="presence-card-title">{PRESENCE_WORDS[presence.state]}</h2>
              <p className="meta">{presence.modelId ? `Model: ${presence.modelId}` : "No model key on this desk"}</p>
            </div>
          </div>
          <ul className="fact-list">
            <li>
              <b>{presence.reading.length}</b> being read now
            </li>
            <li>
              <b>{waiting}</b> waiting for the agent (not run, or didn’t finish)
            </li>
            <li>
              <b>{emails.filter((email) => isHandled(email.status)).length}</b> of {emails.length} handled today
            </li>
            <li>
              Schedule: <b>{presence.schedule.enabled ? `every ${presence.schedule.intervalMinutes} min` : "off"}</b>
              {presence.schedule.enabled && presence.schedule.nextRunAt ? ` · next ${formatBusinessTime(presence.schedule.nextRunAt)}` : null}
            </li>
          </ul>
        </section>

        <ProcessingBox
          reading={presence.reading}
          handled={emails.filter((email) => isHandled(email.status)).length}
          total={emails.length}
          runAll={presence.runAll}
          canStop={isAdmin}
        />

        <section className="panel-card" aria-labelledby="start-title">
          <h2 id="start-title" className="section-title">
            Start the agent
          </h2>
          <ul className="trigger-list">
            <li>
              <Hand size={18} aria-hidden="true" />
              <div>
                <b>One email</b>
                <p className="meta">Open an email that hasn’t run and press Run the agent. Anyone can.</p>
              </div>
            </li>
            <li>
              <Play size={18} aria-hidden="true" />
              <div>
                <b>Selected emails</b>
                <p className="meta">Tick up to 20 emails in the list and press Run agent in the bar that appears. Anyone can.</p>
              </div>
            </li>
            <li>
              <Bot size={18} aria-hidden="true" />
              <div>
                <b>Every email left</b>
                <p className="meta">Run all reads every email not done yet, one after another, even with the tab closed. Admins only.</p>
                {isAdmin ? <AgentControls runGoing={presence.runAll !== null} agentOn={presence.state !== "off"} /> : null}
              </div>
            </li>
            <li>
              <CalendarClock size={18} aria-hidden="true" />
              <div>
                <b>On a schedule</b>
                <p className="meta">Every 5 to 60 minutes the agent reads whatever is waiting. </p>
                <Link href="/agent/schedule" className="link">
                  {isAdmin ? "Set the schedule" : "See the schedule"}
                </Link>
              </div>
            </li>
          </ul>
        </section>
      </div>

      <section className="panel-card" aria-labelledby="runs-title">
        <h2 id="runs-title" className="section-title">
          Latest runs
        </h2>
        {runs.length === 0 ? (
          <p className="meta">The agent hasn’t run yet today.</p>
        ) : (
          <div className="table-wrap">
            <table className="runs-table">
              <thead>
                <tr>
                  <th scope="col">Started</th>
                  <th scope="col">Email</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Model calls</th>
                  <th scope="col">Started by</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.runId}>
                    <td className="num">{formatBusinessTime(run.startedAt)}</td>
                    <td>
                      <Link href={mailHref({ folder: "inbox", emailId: run.emailId, view: "detail" })}>
                        <span className="id">{run.emailId}</span> {run.subject}
                      </Link>
                    </td>
                    <td>
                      {run.endedAt === null ? (
                        <span className="run-state run-state--reading">Reading…</span>
                      ) : (
                        <span className={`run-state run-state--${run.outcome ?? "failed"}`}>
                          {OUTCOME_WORDS[run.outcome ?? "failed"] ?? run.outcome}
                          {run.errorClass ? ` (${run.errorClass})` : ""}
                        </span>
                      )}
                    </td>
                    <td className="num">{run.modelCalls}</td>
                    <td>{run.trigger === "schedule" ? "Schedule" : run.trigger === "person" ? "Run all / selected" : "One email"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
