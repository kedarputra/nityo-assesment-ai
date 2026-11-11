import type { Metadata } from "next";
import { ScheduleForm } from "@/components/agent/schedule-form";
import { formatBusinessTime } from "@/lib/business-clock";
import { getDatabase } from "@/db/client";
import { requireUser } from "@/server/auth/current-user";
import { getSchedule } from "@/server/agent/schedule";

export const metadata: Metadata = { title: "Schedule · Harbor Point" };

// The agent's schedule (ADR 0005): an admin turns the automatic run on and picks how often; a
// reviewer sees it.
export default async function SchedulePage() {
  const user = await requireUser();
  const schedule = await getSchedule(getDatabase());
  const isAdmin = user.role === "admin";

  return (
    <div className="page-pad narrow">
      <header className="page-head">
        <h1 className="page-title">Schedule</h1>
        <p className="page-lede">The agent can read whatever is waiting on its own, every few minutes, without anyone pressing a button.</p>
      </header>

      <section className="panel-card">
        <h2 className="section-title">How it works</h2>
        <ul className="bullets">
          <li>Every 5 minutes a scheduled job checks in with the desk.</li>
          <li>When the schedule is on and its interval has passed, it starts a run over every email not done yet.</li>
          <li>It waits when a run is already going, or when nothing is waiting.</li>
          <li>Scheduled runs show as <b>Scheduled run</b> in the live box and in the audit log.</li>
        </ul>
        {!schedule.configured ? (
          <p className="callout-line">
            Not connected yet: the scheduled job needs <code>CRON_SECRET</code> set in Vercel, and the <code>APP_URL</code> and{" "}
            <code>CRON_SECRET</code> repository secrets in GitHub (docs/deployment.md, “The schedule”).
          </p>
        ) : null}
      </section>

      <section className="panel-card">
        <h2 className="section-title">Current setting</h2>
        <ul className="fact-list">
          <li>
            Automatic run: <b>{schedule.enabled ? "On" : "Off"}</b>
          </li>
          <li>
            Every: <b>{schedule.intervalMinutes} minutes</b>
          </li>
          <li>
            Last started: <b>{schedule.lastStartedAt ? formatBusinessTime(schedule.lastStartedAt) : "never"}</b>
          </li>
          <li>
            Next: <b>{schedule.enabled && schedule.nextRunAt ? formatBusinessTime(schedule.nextRunAt) : "—"}</b>
          </li>
        </ul>
        {isAdmin ? (
          <ScheduleForm enabled={schedule.enabled} intervalMinutes={schedule.intervalMinutes} />
        ) : (
          <p className="meta">Only an admin can change the schedule.</p>
        )}
      </section>
    </div>
  );
}
