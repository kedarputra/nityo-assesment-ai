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
import { ReviewDeskProvider } from "./review-desk";

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
  // False when the deploy has no Anthropic key: the desk works, the agent does not run.
  agentOn: boolean;
  // The URL asked for an email that is not in today's inbox.
  notFound?: boolean;
}

const FILTER_NAMES: Record<InboxFilter, string> = {
  all: "All",
  "needs-you": "Needs you",
  done: "Done",
  other: "Other",
};

// The three-pane desk (DESIGN.md, "Layout and responsiveness"). The URL holds its state, so the
// rows and filters are links: they work before the page's script loads, and next/link prefetches
// them. (next/form was used here first, but it drops the clicked button's name=value, so a row
// click never reached the URL.)
export function InboxDesk({
  query,
  emails,
  counts,
  shown,
  selected,
  work,
  tipDismissed,
  agentOn,
  notFound = false,
}: InboxDeskProps) {
  return (
    <AgentRunsProvider>
      <ReviewDeskProvider
        filter={query.filter}
        view={query.view}
        shownIds={shown.map((email) => email.emailId)}
        selectedId={selected?.emailId ?? null}
      >
        <div className="desk" data-view={query.view}>
          <section className="desk-pane desk-pane--list" aria-label="Emails">
            <GreetingCard emails={emails} agentOn={agentOn} />
            {tipDismissed ? null : <TipCard />}
            <FilterBar query={query} counts={counts} />
            <EmailList query={query} shown={shown} selectedId={selected?.emailId ?? null} />
          </section>
          <div className="desk-back">
            {/* No scroll to the top: the desk brings the email you came from back into view. */}
            <Link
              className="btn btn--ghost"
              href={inboxHref({ filter: query.filter, emailId: selected?.emailId ?? null })}
              scroll={false}
            >
              ← All emails
            </Link>
          </div>
          <section className="desk-pane desk-pane--email" aria-label="Email">
            {selected ? <EmailDetail email={selected} /> : <NoEmailChosen notFound={notFound} />}
          </section>
          <section className="desk-pane desk-pane--proposal" aria-label="Proposal">
            <ProposalPane email={selected} work={work} agentOn={agentOn} />
          </section>
        </div>
      </ReviewDeskProvider>
    </AgentRunsProvider>
  );
}

function inboxHref({
  filter,
  emailId,
  view,
}: {
  filter: InboxFilter;
  emailId: string | null;
  view?: "detail";
}): string {
  const params = new URLSearchParams({ filter });
  if (emailId) params.set("email", emailId);
  if (view) params.set("view", view);
  return `${INBOX_PATH}?${params.toString()}`;
}

function GreetingCard({ emails, agentOn }: { emails: InboxEmail[]; agentOn: boolean }) {
  const total = emails.length;
  const handled = emails.filter((email) => isHandled(email.status)).length;
  const percent = total === 0 ? 0 : Math.round((handled / total) * 100);

  return (
    <div className="greeting-card">
      {/* The business clock is fixed at 07:00 on Mon 2 Nov (case policy 1), so it is always morning. */}
      <h1 className="greeting">Good morning</h1>
      <p className="greeting-count">{greetingCount(total, handled, agentOn)}</p>
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
        <span className="hide-tablet"> · Press <kbd>?</kbd> for keyboard keys</span>
      </p>
    </div>
  );
}

function greetingCount(total: number, handled: number, agentOn: boolean): string {
  if (total === 0) return "No emails have come in today.";
  const emailsToday = total === 1 ? "1 email came in today." : `${total} emails came in today.`;
  if (handled === 0 && !agentOn) return `${emailsToday} The agent is switched off, so they’re yours to read.`;
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
    <div className="filters" role="group" aria-label="Show">
      {inboxFilters.map((filter) => (
        <Link
          key={filter}
          href={inboxHref({ filter, emailId: query.emailId })}
          className="filter"
          aria-current={query.filter === filter ? "true" : undefined}
          scroll={false}
        >
          {FILTER_NAMES[filter]}
          <span className="filter-count">{counts[filter]}</span>
        </Link>
      ))}
    </div>
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
    <ul className="rows">
      {shown.map((email) => (
        <li key={email.emailId}>
          <EmailRow
            email={email}
            href={inboxHref({ filter: query.filter, emailId: email.emailId, view: "detail" })}
            selected={email.emailId === selectedId}
          />
        </li>
      ))}
    </ul>
  );
}

function EmailRow({ email, href, selected }: { email: InboxEmail; href: string; selected: boolean }) {
  return (
    <Link href={href} className="row" aria-current={selected ? "true" : undefined}>
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
    </Link>
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

function NoEmailChosen({ notFound }: { notFound: boolean }) {
  return (
    <div className="pane-empty">
      <h2 className="title">{notFound ? "That email isn’t in today’s inbox" : "No email chosen"}</h2>
      <p className="meta">Choose an email from the list to read it here.</p>
    </div>
  );
}
