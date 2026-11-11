import { CircleCheck, Flag, Inbox, Play, Reply, Search, Settings, Tag } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/server/auth/current-user";

export const metadata: Metadata = { title: "Guide · Harbor Point" };

// The desk's user flows, by role (ADR 0005): what a reviewer and an admin do, step by step.
export default async function GuidePage() {
  const user = await requireUser();
  const isAdmin = user.role === "admin";

  return (
    <div className="page-pad narrow guide">
      <header className="page-head">
        <h1 className="page-title">{isAdmin ? "Guide for admins" : "Guide for reviewers"}</h1>
        <p className="page-lede">
          The agent reads each order email and works in the ERP. Clean orders it releases on its own; anything risky waits for
          you with the reason.
        </p>
      </header>

      <section className="panel-card">
        <h2 className="section-title">Your daily flow</h2>
        <ol className="flow">
          <li>
            <Inbox size={18} aria-hidden="true" />
            <div>
              <b>Open Needs review</b>
              <p>Every email with a red flag waits for you: a Proposal to decide, a request to answer, or a run that didn’t finish.</p>
            </div>
          </li>
          <li>
            <Flag size={18} aria-hidden="true" />
            <div>
              <b>Read why it’s waiting</b>
              <p>The agent’s panel lists the failed checks first. A lock means a hard rule: hold or reject. Others you can approve with a note.</p>
            </div>
          </li>
          <li>
            <CircleCheck size={18} aria-hidden="true" />
            <div>
              <b>Decide</b>
              <p>Edit quantities, products, lines or the ship-to, then Approve &amp; release, Put on hold or Reject. A release can be undone for 10 seconds.</p>
            </div>
          </li>
          <li>
            <Reply size={18} aria-hidden="true" />
            <div>
              <b>Reply</b>
              <p>Press Reply: the agent’s draft is already there. Edit it, Save draft, or Approve for sending (logged as would send).</p>
            </div>
          </li>
          <li>
            <Tag size={18} aria-hidden="true" />
            <div>
              <b>Keep track</b>
              <p>Add labels, flag what to follow up, set a status. Tick several emails to do it to all of them at once.</p>
            </div>
          </li>
        </ol>
      </section>

      <section className="panel-card">
        <h2 className="section-title">What you can do</h2>
        <div className="role-table">
          <div>
            <h3>Reviewer</h3>
            <ul className="bullets">
              <li>Decide Proposals, one at a time</li>
              <li>Compose and approve replies</li>
              <li>Labels, flags and statuses, one email or many</li>
              <li>Run the agent on one email, or up to 20 selected</li>
              <li>Search everything, by keyword or by meaning</li>
            </ul>
          </div>
          <div>
            <h3>Admin</h3>
            <ul className="bullets">
              <li>Everything a reviewer can</li>
              <li>Run all, and Stop it</li>
              <li>Turn the schedule on and set how often</li>
              <li>Reset the desk to 07:00 on Mon 2 Nov</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="panel-card">
        <h2 className="section-title">Signs on the desk</h2>
        <ul className="legend">
          <li>
            <span className="flag-mark flag-mark--review">
              <Flag size={14} aria-hidden="true" fill="currentColor" />
            </span>
            <b>Red flag:</b> needs review. Set by the system; deciding clears it.
          </li>
          <li>
            <span className="flag-mark flag-mark--follow">
              <Flag size={14} aria-hidden="true" />
            </span>
            <b>Amber flag:</b> someone flagged it to follow up.
          </li>
          <li>
            <span className="presence-dot presence-dot--active" aria-hidden="true" />
            <b>Agent Active</b> · <span className="presence-dot presence-dot--idle" aria-hidden="true" /> Idle ·{" "}
            <span className="presence-dot presence-dot--paused" aria-hidden="true" /> Paused ·{" "}
            <span className="presence-dot presence-dot--off" aria-hidden="true" /> Off
          </li>
        </ul>
      </section>

      <p className="guide-links">
        <Link href="/?folder=needs-review" className="btn btn--primary">
          <Inbox size={16} aria-hidden="true" />
          Go to Needs review
        </Link>
        <Link href="/search" className="btn">
          <Search size={16} aria-hidden="true" />
          Search
        </Link>
        {isAdmin ? (
          <Link href="/agent" className="btn">
            <Settings size={16} aria-hidden="true" />
            Agent controls
          </Link>
        ) : (
          <Link href="/agent" className="btn">
            <Play size={16} aria-hidden="true" />
            Agent activity
          </Link>
        )}
      </p>
    </div>
  );
}
