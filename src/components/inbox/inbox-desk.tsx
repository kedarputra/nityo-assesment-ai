import Form from "next/form";
import Link from "next/link";
import { formatBusinessDay, formatBusinessTime } from "@/lib/business-clock";
import { dismissTipAction } from "@/server/inbox/actions";
import type { EmailWork } from "@/server/inbox/email-work";
import {
  type InboxEmail,
  type InboxEmailWithBody,
  type InboxFilter,
  type InboxQuery,
  inboxFilters,
  isHandled,
} from "@/server/inbox/inbox";
import { AgentRunsProvider, RowStatus } from "./agent-run";
import { Avatar } from "./avatar";
import { ProposalPane } from "./proposal-pane";

const INBOX_PATH = "/";

export interface InboxDeskProps {
  query: InboxQuery;
  // The day's emails, in received_at order, and how many fall under each filter.
  emails: InboxEmail[];
  counts: Record<InboxFilter, number>;
  // The emails the chosen filter shows.
  shown: InboxEmail[];
  selected: InboxEmailWithBody | null;
  // What the agent did with the selected email, or null when it has not run on it.
  work: EmailWork | null;
  tipDismissed: boolean;
}

const FILTER_NAMES: Record<InboxFilter, string> = {
  all: "All",
  "needs-you": "Needs you",
  done: "Done",
  other: "Other",
};

// The three-pane desk (DESIGN.md, "Layout and responsiveness"). The URL holds its state, so
// every control is a GET form: a native button that works before the page's script loads.
export function InboxDesk({ query, emails, counts, shown, selected, work, tipDismissed }: InboxDeskProps) {
  return (
    <AgentRunsProvider>
      <div className="desk" data-view={query.view}>
        <section className="desk-pane desk-pane--list" aria-label="Emails">
          <GreetingCard emails={emails} />
          {tipDismissed ? null : <TipCard />}
          <FilterBar query={query} counts={counts} />
          <EmailList query={query} shown={shown} selectedId={selected?.emailId ?? null} />
        </section>
        <div className="desk-back">
          <Link className="btn btn--ghost" href={inboxHref({ filter: query.filter, emailId: selected?.emailId ?? null })}>
            ← All emails
          </Link>
        </div>
        <section className="desk-pane desk-pane--email" aria-label="Email">
          {selected ? <EmailDetail email={selected} /> : <NoEmailChosen />}
        </section>
        <section className="desk-pane desk-pane--proposal" aria-label="Proposal">
          <ProposalPane email={selected} work={work} />
        </section>
      </div>
    </AgentRunsProvider>
  );
}

function inboxHref({ filter, emailId }: { filter: InboxFilter; emailId: string | null }): string {
  const params = new URLSearchParams({ filter });
  if (emailId) params.set("email", emailId);
  return `${INBOX_PATH}?${params.toString()}`;
}

function GreetingCard({ emails }: { emails: InboxEmail[] }) {
  const total = emails.length;
  const handled = emails.filter((email) => isHandled(email.status)).length;
  const percent = total === 0 ? 0 : Math.round((handled / total) * 100);

  return (
    <div className="greeting-card">
      {/* The business clock is fixed at 07:00 on Mon 2 Nov (case policy 1), so it is always morning. */}
      <h1 className="greeting">Good morning</h1>
      <p className="greeting-count">{greetingCount(total, handled)}</p>
      <div
        className="progress"
        role="progressbar"
        aria-label="Emails handled"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={handled}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      <p className="meta">
        {handled} of {total} handled
      </p>
    </div>
  );
}

function greetingCount(total: number, handled: number): string {
  if (total === 0) return "No emails have come in today.";
  const emailsToday = total === 1 ? "1 email came in today." : `${total} emails came in today.`;
  if (handled === 0) return `${emailsToday} The agent hasn’t read any of them yet.`;
  return `${emailsToday} ${handled} handled so far.`;
}

function TipCard() {
  return (
    <form className="tip" action={dismissTipAction}>
      <p>
        <b>How this works:</b> the agent reads every email and drafts the order. Anything risky waits here for you.
        Each status has an icon and words: <b>✓ Done</b>, <b>! Needs you</b>, <b>○ Not run yet</b>.
      </p>
      <button type="submit" className="btn btn--ghost" aria-label="Dismiss the tip">
        Got it
      </button>
    </form>
  );
}

function FilterBar({ query, counts }: { query: InboxQuery; counts: Record<InboxFilter, number> }) {
  return (
    <Form action={INBOX_PATH} className="filters" aria-label="Show">
      {query.emailId ? <input type="hidden" name="email" value={query.emailId} /> : null}
      {inboxFilters.map((filter) => (
        <button
          key={filter}
          type="submit"
          name="filter"
          value={filter}
          className="filter"
          aria-pressed={query.filter === filter}
        >
          {FILTER_NAMES[filter]}
          <span className="filter-count">{counts[filter]}</span>
        </button>
      ))}
    </Form>
  );
}

function EmailList({ query, shown, selectedId }: { query: InboxQuery; shown: InboxEmail[]; selectedId: string | null }) {
  if (shown.length === 0) {
    return (
      <p className="list-empty">
        Nothing here right now. Try <b>All</b> to see every email from today.
      </p>
    );
  }

  return (
    <Form action={INBOX_PATH}>
      <input type="hidden" name="filter" value={query.filter} />
      <input type="hidden" name="view" value="detail" />
      <ul className="rows">
        {shown.map((email) => (
          <li key={email.emailId}>
            <EmailRow email={email} selected={email.emailId === selectedId} />
          </li>
        ))}
      </ul>
    </Form>
  );
}

function EmailRow({ email, selected }: { email: InboxEmail; selected: boolean }) {
  return (
    <button type="submit" name="email" value={email.emailId} className="row" aria-current={selected ? "true" : undefined}>
      <Avatar name={email.fromName} />
      <span className="row-body">
        <span className="row-top">
          <span className="row-from">{email.fromName}</span>
          <time className="meta num" dateTime={email.receivedAt.toISOString()}>
            {formatBusinessTime(email.receivedAt)}
          </time>
        </span>
        <span className="row-subject">{email.subject}</span>
        <span className="row-bottom">
          <RowStatus emailId={email.emailId} status={email.status} />
        </span>
      </span>
    </button>
  );
}

// Subjects, names and bodies are untrusted (security 4): React renders them as text, and
// nothing here ever reads them as HTML.
function EmailDetail({ email }: { email: InboxEmailWithBody }) {
  return (
    <article className="email-detail">
      <header className="email-head">
        <Avatar name={email.fromName} />
        <div className="email-head-text">
          <h2 className="title">{email.subject}</h2>
          <p className="meta">
            {email.fromName} &lt;{email.fromEmail}&gt; ·{" "}
            <time dateTime={email.receivedAt.toISOString()}>
              {formatBusinessDay(email.receivedAt)} {formatBusinessTime(email.receivedAt)}
            </time>{" "}
            · <span className="id">{email.emailId}</span>
          </p>
        </div>
      </header>
      <pre className="email-body reading">{email.body}</pre>
    </article>
  );
}

function NoEmailChosen() {
  return (
    <div className="pane-empty">
      <h2 className="title">No email chosen</h2>
      <p className="meta">Choose an email from the list to read it here.</p>
    </div>
  );
}
