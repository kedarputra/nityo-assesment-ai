import { isHardRule } from "@/agent/release-checks";
import { formatBusinessDay } from "@/lib/business-clock";
import { formatUsd } from "@/lib/money";
import type { EmailWork, ProposalView } from "@/server/inbox/email-work";
import type { InboxEmailWithBody } from "@/server/inbox/inbox";
import { RunAgentButton } from "./agent-run";
import { CheckList, PassingChecks } from "./checks";
import { DraftReplyEditor, ProposalReview } from "./proposal-review";
import { StatusPill } from "./status-pill";

// The Proposal pane (DESIGN.md, "Components"): what the agent did with the chosen email, why
// anything is waiting for a person, the lines, the decision, and the Draft reply. Everything the
// model wrote is untrusted (security 4), so it is only ever rendered as text.

export function ProposalPane({ email, work }: { email: InboxEmailWithBody | null; work: EmailWork | null }) {
  if (!email) return <NothingToDecide email={null} />;
  if (!work) return <NothingToDecide email={email} />;
  if (!work.run.finished) return <StillReading />;
  if (work.run.outcome === "failed") return <RunDidNotFinish email={email} errorClass={work.run.errorClass} />;

  // The first undecided Proposal takes the desk's keys.
  const firstUndecided = work.proposals.find(isUndecided)?.id ?? null;
  return (
    <div className="proposal">
      <StatusPill status={email.status} />
      {work.proposals.map((proposal) => (
        <ProposalCard key={proposal.id} proposal={proposal} takesKeys={proposal.id === firstUndecided} />
      ))}
      {work.flags.length > 0 ? <Flags flags={work.flags} /> : null}
      {work.draftReply !== null ? <DraftReplyEditor emailId={email.emailId} reply={work.draftReply} /> : null}
    </div>
  );
}

function NothingToDecide({ email }: { email: InboxEmailWithBody | null }) {
  return (
    <div className="pane-empty">
      {email ? <StatusPill status={email.status} /> : null}
      <h2 className="headline">Nothing to decide yet</h2>
      <p className="meta">
        The agent hasn’t read {email ? "this email" : "today’s emails"} yet. When it has, what it proposes shows up
        here for you to approve, change or reject.
      </p>
      {email ? <RunAgentButton emailId={email.emailId} /> : null}
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

function RunDidNotFinish({ email, errorClass }: { email: InboxEmailWithBody; errorClass: string | null }) {
  return (
    <div className="pane-empty">
      <StatusPill status={email.status} />
      <div className="card card--bad">
        <h2 className="headline">The agent didn’t finish this email</h2>
        <p>
          Nothing it couldn’t finish was released. Its steps so far are in the audit log; read the email and handle it
          yourself for now.
        </p>
        {errorClass ? <p className="meta id">{errorClass}</p> : null}
      </div>
    </div>
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
      </p>
      {proposal.decision ? <Decision proposal={proposal} /> : null}
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
          <Lines proposal={proposal} />
        </>
      )}
    </article>
  );
}

function headline(proposal: ProposalView): string {
  const total = formatUsd(proposal.totalCents);
  switch (proposal.status) {
    case "released":
      if (proposal.decision) return `You released ${proposal.soNumber ?? "the order"} for ${proposal.customerName}, ${total}`;
      return `Released ${proposal.soNumber ?? "the order"}: ${total} for ${proposal.customerName}`;
    case "rejected":
      return `The order from ${proposal.customerName} was rejected`;
    case "held":
      return `The order from ${proposal.customerName} is on hold, ${total}`;
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
