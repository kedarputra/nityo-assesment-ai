import type { RecordedCheck } from "@/db/schema";
import { formatBusinessDay } from "@/lib/business-clock";
import { formatUsd } from "@/lib/money";
import type { EmailWork, ProposalLineView, ProposalView } from "@/server/inbox/email-work";
import type { InboxEmailWithBody } from "@/server/inbox/inbox";
import { RunAgentButton } from "./agent-run";
import { StatusPill } from "./status-pill";

// The Proposal pane (DESIGN.md, "Components"): what the agent did with the chosen email, why
// anything is waiting for a person, the lines, and the Draft reply. Everything the model wrote is
// untrusted (security 4), so it is only ever rendered as text.

const CHECK_NAMES: Record<string, string> = {
  "known-contact": "A known contact sent it",
  "skus-sellable": "Every product can be sold",
  "no-substitution": "No product swap",
  "confident-skus": "Every product is clear",
  "selling-units": "Quantities in selling units",
  "system-price": "System prices",
  "full-stock": "Fully in stock",
  "credit-hold": "Not on credit hold",
  "credit-limit": "Within the credit limit",
  "ship-to": "One clear ship-to",
  "no-flags": "Nothing flagged",
};

export function ProposalPane({ email, work }: { email: InboxEmailWithBody | null; work: EmailWork | null }) {
  if (!email) return <NothingToDecide email={null} />;
  if (!work) return <NothingToDecide email={email} />;
  if (!work.run.finished) return <StillReading />;
  if (work.run.outcome === "failed") return <RunDidNotFinish email={email} errorClass={work.run.errorClass} />;

  return (
    <div className="proposal">
      <StatusPill status={email.status} />
      {work.proposals.map((proposal) => (
        <ProposalCard key={proposal.id} proposal={proposal} />
      ))}
      {work.flags.length > 0 ? <Flags flags={work.flags} /> : null}
      {work.draftReply !== null ? <DraftReply body={work.draftReply} /> : null}
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

function ProposalCard({ proposal }: { proposal: ProposalView }) {
  const failing = proposal.checks.filter((check) => !check.passes);
  const passing = proposal.checks.filter((check) => check.passes);

  return (
    <article className="proposal-card">
      <h2 className="headline">{headline(proposal)}</h2>
      <p className="meta">
        {proposal.customerName} · {proposal.shipToName ?? <span className="id">{proposal.shipToId}</span>} · wanted{" "}
        {formatRequestedDate(proposal.requestedDate)}
      </p>
      {failing.length > 0 ? (
        <section className="why-waiting" aria-label="Why it’s waiting for you">
          <h3 className="section-name">Why it’s waiting for you</h3>
          <CheckList checks={failing} />
        </section>
      ) : null}
      {passing.length > 0 ? (
        <details className="checks-ok">
          <summary>
            {passing.length} {passing.length === 1 ? "check looks" : "checks look"} good
          </summary>
          <CheckList checks={passing} />
        </details>
      ) : null}
      <Lines proposal={proposal} />
    </article>
  );
}

function headline(proposal: ProposalView): string {
  const total = formatUsd(proposal.totalCents);
  if (proposal.status === "released" && proposal.soNumber) {
    return `Released ${proposal.soNumber}: ${total} for ${proposal.customerName}`;
  }
  return `New order for ${proposal.customerName}, ${total}, waiting for you`;
}

// A requested date is a calendar day; noon at Harbor Point keeps it on that day in any zone.
function formatRequestedDate(isoDate: string): string {
  return formatBusinessDay(new Date(`${isoDate}T12:00:00-05:00`));
}

function CheckList({ checks }: { checks: RecordedCheck[] }) {
  return (
    <ul className="checks">
      {checks.map((check) => (
        <li key={check.check}>
          <span aria-hidden="true">{check.passes ? "✓" : "!"}</span>
          <span>
            <b>{CHECK_NAMES[check.check] ?? check.check}.</b> {check.detail}
          </span>
        </li>
      ))}
    </ul>
  );
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

// Policy 3 and U9: the person sees what the customer asked for and how the replacement differs.
function SwappedFor({ line, swappedFor }: { line: ProposalLineView; swappedFor: NonNullable<ProposalLineView["swappedFor"]> }) {
  const now = line.unitPriceCents === null ? "no price" : formatUsd(line.unitPriceCents);
  return (
    <p className="sub">
      Swapped in for <span className="id">{swappedFor.sku}</span> {swappedFor.name}, which is discontinued: was{" "}
      {swappedFor.pack} at {formatUsd(swappedFor.listPriceCents)}, now {line.pack ?? "–"} at {now}.
    </p>
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

// Editing and "Mark reply ready" arrive with the review actions; for now the draft is shown as is.
function DraftReply({ body }: { body: string }) {
  return (
    <section className="reply">
      <h3 className="section-name">
        <label htmlFor="draft-reply">Reply to customer</label>
      </h3>
      <textarea id="draft-reply" className="reading" readOnly value={body} rows={8} />
      <p className="meta">We never send email from here; this is what would go out.</p>
    </section>
  );
}
