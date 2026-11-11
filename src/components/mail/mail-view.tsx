import { CircleCheck, Flag } from "lucide-react";
import { formatBusinessDay, formatBusinessTime } from "@/lib/business-clock";
import type { AgentPresence } from "@/server/desk/presence";
import type { ReplyView } from "@/server/desk/replies";
import type { EmailWork } from "@/server/inbox/email-work";
import type { InboxEmailWithBody, InboxView } from "@/server/inbox/inbox";
import { RefreshWhileReading } from "../inbox-run";
import { AgentRunsProvider } from "../inbox/agent-run";
import { Avatar } from "../inbox/avatar";
import { ProposalPane } from "../inbox/proposal-pane";
import { ReviewDeskProvider } from "../inbox/review-desk";
import { StatusPill } from "../inbox/status-pill";
import {
  FLAG_NAMES,
  TRIAGE_STATUS_NAMES,
  folderName,
  folderPurpose,
  inFolder,
  isHandled,
  needsReview,
  type DeskEmail,
  type DeskLabel,
  type FolderId,
} from "./folders";
import { LabelChip } from "./label-chip";
import { MailList } from "./mail-list";
import { ProcessingBox } from "./processing-box";
import { ReadingWorkspace } from "./reading-workspace";

export interface MailViewProps {
  folder: FolderId;
  view: InboxView;
  emails: DeskEmail[];
  labels: DeskLabel[];
  selected: InboxEmailWithBody | null;
  work: EmailWork | null;
  reply: ReplyView | null;
  presence: AgentPresence;
  isAdmin: boolean;
  notFound: boolean;
}

// The mail view (ADR 0005): the live box of what the agent is reading, the folder's list, and
// the reading pane with the email, a command bar, the reply composer and the agent's work.
export function MailView({ folder, view, emails, labels, selected, work, reply, presence, isAdmin, notFound }: MailViewProps) {
  const inThisFolder = emails.filter((email) => inFolder(email, folder));
  const ids = inThisFolder.map((email) => email.emailId);
  const position = selected ? ids.indexOf(selected.emailId) : -1;
  const desk = selected ? emails.find((email) => email.emailId === selected.emailId) : undefined;
  const agentOn = presence.state !== "off";
  const live = presence.reading.length > 0 || presence.runAll !== null;

  return (
    <AgentRunsProvider>
      <RefreshWhileReading active={live} />
      <ReviewDeskProvider folder={folder} view={view} shownIds={ids} selectedId={selected?.emailId ?? null}>
        <div className="mail" data-view={view}>
          <div className="mail-list-pane">
            <ProcessingBox
              reading={presence.reading}
              handled={emails.filter((email) => isHandled(email.status)).length}
              total={emails.length}
              runAll={presence.runAll}
              canStop={isAdmin}
            />
            <MailList
              // A new folder starts on its first page with nothing selected.
              key={folder}
              folder={folder}
              title={folderName(folder, labels)}
              purpose={folderPurpose(folder)}
              emails={inThisFolder}
              labels={labels}
              selectedId={selected?.emailId ?? null}
              agentOn={agentOn}
            />
          </div>
          <section className="reading-pane" aria-label="Reading pane">
            {selected && desk && reply ? (
              <ReadingWorkspace
                emailId={selected.emailId}
                folder={folder}
                flag={desk.flag}
                triageStatus={desk.triageStatus}
                labelIds={desk.labelIds}
                labels={labels}
                canRunAgent={agentOn && (selected.status === "not_run" || selected.status === "failed")}
                previousId={position > 0 ? (ids[position - 1] ?? null) : null}
                nextId={position >= 0 && position < ids.length - 1 ? (ids[position + 1] ?? null) : null}
                position={position + 1}
                total={ids.length}
                reply={reply}
                message={<EmailMessage email={selected} desk={desk} labels={labels} />}
                agentPanel={<ProposalPane email={selected} work={work} agentOn={agentOn} showReply={false} />}
              />
            ) : (
              <NoEmailChosen notFound={notFound} />
            )}
          </section>
        </div>
      </ReviewDeskProvider>
    </AgentRunsProvider>
  );
}

// The email as Outlook shows it: subject, then sender, recipient and time, then what a person has
// put on it. Subjects, names and bodies are untrusted (security 4): React renders them as text.
function EmailMessage({ email, desk, labels }: { email: InboxEmailWithBody; desk: DeskEmail; labels: DeskLabel[] }) {
  const review = needsReview(desk);
  return (
    <article className="message">
      <h1 className="message-subject">{email.subject}</h1>
      <div className="message-marks">
        <StatusPill status={email.status} />
        {review ? (
          <span className="flag-chip flag-chip--review">
            <Flag size={14} aria-hidden="true" fill="currentColor" />
            Needs review
          </span>
        ) : null}
        {desk.flag !== "none" ? (
          <span className={`flag-chip flag-chip--${desk.flag}`}>
            {desk.flag === "complete" ? <CircleCheck size={14} aria-hidden="true" /> : <Flag size={14} aria-hidden="true" />}
            {FLAG_NAMES[desk.flag]}
          </span>
        ) : null}
        <span className={`triage-chip triage-chip--${desk.triageStatus}`}>{TRIAGE_STATUS_NAMES[desk.triageStatus]}</span>
        {desk.labelIds.map((id) => {
          const label = labels.find((candidate) => candidate.id === id);
          return label ? <LabelChip key={id} label={label} /> : null;
        })}
      </div>
      <header className="message-head">
        <Avatar name={email.fromName} />
        <div className="message-head-text">
          <p className="message-from">
            <b>{email.fromName}</b> <span className="meta">&lt;{email.fromEmail}&gt;</span>
          </p>
          <p className="meta">
            To orders@harborpointsupply.example
            {desk.customerName ? (
              <>
                {" "}
                · <span className="message-customer">{desk.customerName}</span>
              </>
            ) : null}
          </p>
        </div>
        <p className="message-time meta">
          <time dateTime={email.receivedAt.toISOString()}>
            {formatBusinessDay(email.receivedAt)} {formatBusinessTime(email.receivedAt)}
          </time>
          <span className="id">{email.emailId}</span>
        </p>
      </header>
      <pre className="message-body reading">{email.body}</pre>
    </article>
  );
}

function NoEmailChosen({ notFound }: { notFound: boolean }) {
  return (
    <div className="pane-empty reading-empty">
      <h2 className="title">{notFound ? "That email isn’t in today’s inbox" : "Pick an email to read"}</h2>
      <p className="meta">Choose an email from the list. Its message, your reply and the agent’s work open here.</p>
    </div>
  );
}
