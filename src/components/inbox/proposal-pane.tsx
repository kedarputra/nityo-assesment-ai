import Link from "next/link";
import type { NoActionReason, RequestKind, RouteReason } from "@/db/schema";
import { isHardRule } from "@/agent/release-checks";
import { isTimedOut, SPEND_LIMIT_ERROR_CLASS } from "@/agent/run-errors";
import { formatBusinessDay } from "@/lib/business-clock";
import { formatUsd } from "@/lib/money";
import { AGENT_OFF_MESSAGE } from "@/model/agent-switch";
import type { EmailWork, LinkedProposalView, NoActionView, ProposalView, RoutedRequestView } from "@/server/inbox/email-work";
import type { InboxEmailWithBody } from "@/server/inbox/inbox";
import { RunAgentButton } from "./agent-run";
import { CheckList, PassingChecks } from "./checks";
import { ChangeLines, formatChange } from "./change-lines";
import { DraftReplyEditor, ProposalReview, SwappedFor } from "./proposal-review";
import { StatusPill } from "./status-pill";

// The Proposal pane (DESIGN.md, "Components"): what the agent did with the chosen email, why
// anything is waiting for a person, the lines, the decision, and the Draft reply. Everything the
// model wrote is untrusted (security 4), so it is only ever rendered as text.

// The kind tag's words (DESIGN.md, "Kind tag").
const KIND_NAMES: Record<RequestKind, string> = {
  "new order": "New order",
  "order change": "Order change",
  cancellation: "Cancellation",
  return: "Return",
  "billing dispute": "Billing dispute",
  "quote request": "Quote request",
  "order inquiry": "Order inquiry",
  "no action": "No action",
};

// A routed Request's headline: what the person is being asked to handle.
const ROUTED_HEADLINES: Record<RouteReason, string> = {
  quote: "A quote request for you to answer",
  return: "A return for you to decide",
  billing: "A billing question for accounts",
  inquiry: "A question about an earlier order",
  prospect: "A new company wants to order",
  "no-quantities": "An order that doesn’t say how many",
  "missing-attachment": "An order whose attachment didn’t come through",
};

const NO_ACTION_REASONS: Record<NoActionReason, string> = {
  spam: "It’s spam: nothing a customer asks of us.",
  "auto-reply": "It’s an automatic reply, so there’s nothing to answer.",
  duplicate: "It repeats an email whose order is already in.",
};

export function ProposalPane({
  email,
  work,
  agentOn,
}: {
  email: InboxEmailWithBody | null;
  work: EmailWork | null;
  agentOn: boolean;
}) {
  if (!email) return <NothingToDecide email={null} agentOn={agentOn} />;
  if (!work) return <NothingToDecide email={email} agentOn={agentOn} />;
  if (!work.run.finished) return <StillReading />;
  if (work.run.outcome === "failed") return <RunDidNotFinish email={email} errorClass={work.run.errorClass} />;

  // The first undecided Proposal takes the desk's keys.
  const firstUndecided = work.proposals.find(isUndecided)?.id ?? null;
  return (
    <div className="proposal">
      <StatusPill status={email.status} />
      {work.run.requestKinds.length > 0 ? <KindTags kinds={work.run.requestKinds} /> : null}
      {work.noAction ? <NoActionCard noAction={work.noAction} /> : null}
      {work.proposals.map((proposal) => (
        <ProposalCard key={proposal.id} proposal={proposal} takesKeys={proposal.id === firstUndecided} />
      ))}
      {work.routed.map((request, index) => (
        <RoutedCard key={index} request={request} />
      ))}
      {work.flags.length > 0 ? <Flags flags={work.flags} /> : null}
      {work.related.length > 0 ? <Related related={work.related} /> : null}
      {work.context.length > 0 ? <AgentNotes notes={work.context} /> : null}
      {work.notes.length > 0 ? <Notes notes={work.notes} /> : null}
      {work.draftReply !== null ? <DraftReplyEditor emailId={email.emailId} reply={work.draftReply} /> : null}
    </div>
  );
}

function NothingToDecide({ email, agentOn }: { email: InboxEmailWithBody | null; agentOn: boolean }) {
  return (
    <div className="pane-empty">
      {email ? <StatusPill status={email.status} /> : null}
      <h2 className="headline">Nothing to decide yet</h2>
      {agentOn ? (
        <p className="meta">
          The agent hasn’t read {email ? "this email" : "today’s emails"} yet. When it has, what it proposes shows up
          here for you to approve, change or reject.
        </p>
      ) : (
        <div className="agent-off" role="note">
          <span className="agent-off-icon" aria-hidden="true">
            ⏸︎
          </span>
          <p>
            <b>{AGENT_OFF_MESSAGE}</b> You can still read every email and handle it yourself; when the agent is on, its
            proposal for each email shows up here.
          </p>
        </div>
      )}
      {email && agentOn ? <RunAgentButton emailId={email.emailId} /> : null}
    </div>
  );
}

function StillReading() {
  return (
    <div className="pane-empty" aria-busy="true">
      <StatusPill status="reading" />
      <h2 className="headline">The agent is reading this email</h2>
      <p className="meta">What it proposes will show up here in a minute or so.</p>
      <div className="skeleton" />
      <div className="skeleton skeleton--short" />
    </div>
  );
}

// A failed run can run again: "Run the agent" withdraws its undecided Proposals and starts afresh.
function RunDidNotFinish({ email, errorClass }: { email: InboxEmailWithBody; errorClass: string | null }) {
  return (
    <div className="pane-empty">
      <StatusPill status={email.status} />
      <div className="card card--bad">
        <h2 className="headline">{didNotFinishHeadline(errorClass)}</h2>
        <p>{didNotFinishNextStep(errorClass)}</p>
        {errorClass ? <p className="meta id">{errorClass}</p> : null}
      </div>
      <RunAgentButton emailId={email.emailId} />
    </div>
  );
}

function didNotFinishHeadline(errorClass: string | null): string {
  if (isTimedOut(errorClass)) return "The agent timed out on this email";
  if (errorClass === SPEND_LIMIT_ERROR_CLASS) return "The model’s spending limit is reached, so runs are paused";
  return "The agent didn’t finish this email";
}

function didNotFinishNextStep(errorClass: string | null): string {
  if (isTimedOut(errorClass)) {
    return "Nothing it couldn’t finish was released. Run it again: it starts afresh, and its steps so far are in the audit log.";
  }
  if (errorClass === SPEND_LIMIT_ERROR_CLASS) {
    return "Nothing it couldn’t finish was released. Ask an admin to raise the limit, then run it again.";
  }
  return "Nothing it couldn’t finish was released. Its steps so far are in the audit log; run it again, or read the email and handle it yourself.";
}

function emailHref(emailId: string): string {
  return `/?${new URLSearchParams({ filter: "all", email: emailId }).toString()}`;
}

function KindTags({ kinds }: { kinds: RequestKind[] }) {
  return (
    <ul className="tags" aria-label="What the email asks">
      {kinds.map((kind) => (
        <li key={kind} className="tag">
          {KIND_NAMES[kind]}
        </li>
      ))}
    </ul>
  );
}

// No lines and no gate: a routed Request changes nothing in the ERP; a person takes it from here.
function RoutedCard({ request }: { request: RoutedRequestView }) {
  return (
    <article className="proposal-card">
      <h2 className="headline">{ROUTED_HEADLINES[request.reason]}</h2>
      <p className="meta">Routed to you · nothing changes in the ERP</p>
      <div className="thinks reading">
        <h3 className="who">What the agent thinks</h3>
        <p>{request.summary}</p>
      </div>
    </article>
  );
}

function NoActionCard({ noAction }: { noAction: NoActionView }) {
  return (
    <article className="proposal-card">
      <h2 className="headline">No action needed</h2>
      <p>{NO_ACTION_REASONS[noAction.reason]}</p>
      {noAction.duplicateOf ? (
        <p>
          Same as <Link href={emailHref(noAction.duplicateOf)}>{noAction.duplicateOf}</Link>.
        </p>
      ) : null}
      <p className="meta">{noAction.note}</p>
    </article>
  );
}

// Shown on both emails of a link, so a reviewer sees the whole story (ticket 08 of the map).
function Related({ related }: { related: EmailWork["related"] }) {
  return (
    <section className="thinks" aria-label="Related emails">
      <h3 className="who">Related</h3>
      <ul className="checks">
        {related.map((link) => (
          <li key={link.emailId}>
            <span>
              Related: <Link href={emailHref(link.emailId)}>{link.emailId}</Link> {link.why}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AgentNotes({ notes }: { notes: string[] }) {
  return (
    <section className="thinks" aria-label="What the agent noted">
      <h3 className="who">What the agent noted</h3>
      <ul className="checks">
        {notes.map((note, index) => (
          <li key={index}>
            <span>{note}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Notes({ notes }: { notes: EmailWork["notes"] }) {
  return (
    <section className="thinks" aria-label="From other emails">
      <h3 className="who">From other emails</h3>
      <ul className="checks">
        {notes.map((note, index) => (
          <li key={index}>
            <span>
              <Link href={emailHref(note.sourceEmailId)}>{note.sourceEmailId}</Link> {note.note}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function isUndecided(proposal: ProposalView): boolean {
  return proposal.status === "open" || proposal.status === "held";
}

function ProposalCard({ proposal, takesKeys }: { proposal: ProposalView; takesKeys: boolean }) {
  const failing = proposal.checks.filter((check) => !check.passes);

  return (
    <article className="proposal-card">
      <h2 className="headline">{headline(proposal)}</h2>
      <p className="meta">
        {proposal.customerName} · {proposal.shipToName ?? <span className="id">{proposal.shipToId}</span>} · wanted{" "}
        {formatRequestedDate(proposal.requestedDate)}
        {proposal.requestedDateAlternative ? ` or ${formatRequestedDate(proposal.requestedDateAlternative)}` : null}
        {proposal.requestedDateWords ? ` (“${proposal.requestedDateWords}”)` : null}
      </p>
      {proposal.decision ? <Decision proposal={proposal} /> : null}
      {proposal.linked.length > 0 ? <LinkedProposals linked={proposal.linked} /> : null}
      {isUndecided(proposal) ? (
        <ProposalReview proposal={proposal} takesKeys={takesKeys} />
      ) : (
        <>
          {failing.length > 0 ? (
            <section className="why-waiting" aria-label="Why it was waiting">
              <h3 className="section-name">Why it was waiting</h3>
              <CheckList checks={failing} />
            </section>
          ) : null}
          <PassingChecks checks={proposal.checks} />
          {proposal.kind === "new order" ? <Lines proposal={proposal} /> : <ChangeLines proposal={proposal} />}
        </>
      )}
    </article>
  );
}

function headline(proposal: ProposalView): string {
  switch (proposal.kind) {
    case "new order":
      return newOrderHeadline(proposal);
    case "order change":
    case "cancellation":
      return changeHeadline(proposal, proposal.kind);
  }
}

function changeHeadline(proposal: ProposalView, kind: "order change" | "cancellation"): string {
  const order = proposal.targetSoNumber ?? "the order";
  const change = formatChange(proposal.totalCents);
  const what = kind === "cancellation" ? `Cancel ${order}` : `Change ${order}`;
  switch (proposal.status) {
    case "released":
      return `You ${kind === "cancellation" ? "cancelled" : "changed"} ${order} for ${proposal.customerName}, ${change}`;
    case "rejected":
      return `${what} for ${proposal.customerName}: rejected`;
    case "held":
      return `${what} for ${proposal.customerName} is on hold, ${change}`;
    case "superseded":
      return `${what} for ${proposal.customerName} was replaced by a later run`;
    case "open":
      if (proposal.checks.some((check) => !check.passes && isHardRule(check.check))) {
        return `${order} can’t be ${kind === "cancellation" ? "cancelled" : "changed"} (${change})`;
      }
      return `${what} for ${proposal.customerName}, ${change}, waiting for you`;
  }
}

function newOrderHeadline(proposal: ProposalView): string {
  const total = formatUsd(proposal.totalCents);
  switch (proposal.status) {
    case "released":
      if (proposal.decision) return `You released ${proposal.soNumber ?? "the order"} for ${proposal.customerName}, ${total}`;
      return `Released ${proposal.soNumber ?? "the order"}: ${total} for ${proposal.customerName}`;
    case "rejected":
      return `The order from ${proposal.customerName} was rejected`;
    case "held":
      return `The order from ${proposal.customerName} is on hold, ${total}`;
    case "superseded":
      return `The order from ${proposal.customerName} was replaced by a later run`;
    case "open":
      if (proposal.checks.some((check) => !check.passes && isHardRule(check.check))) {
        return `${proposal.customerName} can’t get this order yet (${total})`;
      }
      return `New order for ${proposal.customerName}, ${total}, waiting for you`;
  }
}

// Who decided, and the reason they gave for a reject or a hold.
function Decision({ proposal }: { proposal: ProposalView }) {
  const { decision } = proposal;
  if (!decision) return null;
  const words = DECISION_WORDS[proposal.status];
  return (
    <p className="decision">
      <span className={`pill pill--${words.pill}`}>
        <span aria-hidden="true">{words.icon}</span>
        {words.label}
      </span>{" "}
      <span className="meta">by {decision.by}</span>
      {decision.reason ? <span className="meta"> · “{decision.reason}”</span> : null}
    </p>
  );
}

const DECISION_WORDS: Record<ProposalView["status"], { pill: string; icon: string; label: string }> = {
  released: { pill: "approved", icon: "✓", label: "Approved" },
  rejected: { pill: "rejected", icon: "✕", label: "Rejected" },
  held: { pill: "on_hold", icon: "◐", label: "On hold" },
  open: { pill: "needs_you", icon: "!", label: "Needs you" },
  superseded: { pill: "no_action", icon: "–", label: "Replaced by a later run" },
};

// A requested date is a calendar day; noon at Harbor Point keeps it on that day in any zone.
function formatRequestedDate(isoDate: string): string {
  return formatBusinessDay(new Date(`${isoDate}T12:00:00-05:00`));
}

function Lines({ proposal }: { proposal: ProposalView }) {
  return (
    <table className="lines">
      <thead>
        <tr>
          <th scope="col">Product</th>
          <th scope="col" className="num">
            Qty
          </th>
          <th scope="col" className="num">
            Price
          </th>
          <th scope="col" className="num">
            Total
          </th>
        </tr>
      </thead>
      <tbody>
        {proposal.lines.map((line) => (
          <tr key={line.lineNo}>
            <td>
              {line.productName ?? "Not in the catalog"}
              <br />
              <span className="id">{line.sku}</span>
              {line.swappedFor ? <SwappedFor line={line} swappedFor={line.swappedFor} /> : null}
            </td>
            <td className="num">{line.quantity}</td>
            <td className="num">
              {line.unitPriceCents === null ? "–" : formatUsd(line.unitPriceCents)}
              {line.priceSource ? <span className="meta"> {line.priceSource}</span> : null}
            </td>
            <td className="num">{line.lineTotalCents === null ? "–" : formatUsd(line.lineTotalCents)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row" colSpan={3}>
            Order total
          </th>
          <td className="num">{formatUsd(proposal.totalCents)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

const LINKED_WORDS: Record<LinkedProposalView["relation"], string> = {
  follows: "Adds to the order still waiting from",
  "followed-by": "More for this order is waiting from",
};

// U2: a follow-up and the pending order it adds to are decided separately, so each shows the other.
function LinkedProposals({ linked }: { linked: LinkedProposalView[] }) {
  return (
    <section className="thinks" aria-label="Linked Proposals">
      <h3 className="who">Goes with</h3>
      <ul className="checks">
        {linked.map((other) => (
          <li key={other.proposalId}>
            <span>
              {LINKED_WORDS[other.relation]} <Link href={emailHref(other.emailId)}>{other.emailId}</Link>:{" "}
              {formatUsd(other.totalCents)}, {DECISION_WORDS[other.status].label.toLowerCase()}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Flags({ flags }: { flags: EmailWork["flags"] }) {
  return (
    <section className="why-waiting" aria-label="What the agent flagged">
      <h3 className="section-name">What the agent flagged</h3>
      <ul className="checks">
        {flags.map((flag, index) => (
          <li key={index}>
            <span aria-hidden="true">!</span>
            <span>
              <span className="id">{flag.code}</span> {flag.note}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
