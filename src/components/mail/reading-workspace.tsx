"use client";

import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Flag,
  Reply,
  Save,
  Send,
  Tag,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import type { TriageFlag, TriageStatus } from "@/db/schema";
import { discardReplyAction, saveReplyAction, setLabelsAction, setTriageAction } from "@/server/desk/actions";
import type { ReplyView } from "@/server/desk/replies";
import { RunAgentButton } from "../inbox/agent-run";
import { TRIAGE_STATUS_NAMES, mailHref, type DeskLabel, type FolderId } from "./folders";

export interface ReadingWorkspaceProps {
  emailId: string;
  folder: FolderId;
  flag: TriageFlag;
  triageStatus: TriageStatus;
  labelIds: number[];
  labels: DeskLabel[];
  canRunAgent: boolean;
  previousId: string | null;
  nextId: string | null;
  position: number;
  total: number;
  reply: ReplyView;
  // Rendered on the server: the email itself, and the agent's work on it.
  message: ReactNode;
  agentPanel: ReactNode;
}

// The reading pane's working parts (ADR 0005), as in Outlook: a command bar over the email, and a
// reply composed in place. Flag, status and labels change here one email at a time.
export function ReadingWorkspace({
  emailId,
  folder,
  flag,
  triageStatus,
  labelIds,
  labels,
  canRunAgent,
  previousId,
  nextId,
  position,
  total,
  reply,
  message,
  agentPanel,
}: ReadingWorkspaceProps) {
  const router = useRouter();
  const [composing, setComposing] = useState(reply.state === "draft" || reply.state === "ready");
  const [notice, setNotice] = useState<{ text: string; problem: boolean } | null>(null);
  const [busy, startBusy] = useTransition();

  function change(work: () => Promise<{ ok: true } | { ok: false; message: string }>, done?: string) {
    setNotice(null);
    startBusy(async () => {
      try {
        const result = await work();
        if (!result.ok) setNotice({ text: result.message, problem: true });
        else if (done) setNotice({ text: done, problem: false });
        router.refresh();
      } catch {
        setNotice({ text: "The server didn’t answer. Try again in a moment.", problem: true });
      }
    });
  }

  return (
    <div className="reading">
      <div className="command-bar" role="toolbar" aria-label="Actions on this email">
        <Link className="icon-btn back-btn" href={mailHref({ folder, emailId })} scroll={false} aria-label="Back to the list">
          <ArrowLeft size={18} aria-hidden="true" />
        </Link>
        <button type="button" className="cmd" onClick={() => setComposing(true)} aria-pressed={composing}>
          <Reply size={16} aria-hidden="true" />
          Reply
        </button>
        <button
          type="button"
          className={flag === "follow-up" ? "cmd cmd--flag-on" : "cmd"}
          aria-pressed={flag === "follow-up"}
          disabled={busy}
          onClick={() => change(() => setTriageAction({ emailIds: [emailId], flag: flag === "follow-up" ? "none" : "follow-up" }))}
        >
          <Flag size={16} aria-hidden="true" fill={flag === "follow-up" ? "currentColor" : "none"} />
          {flag === "follow-up" ? "Flagged" : "Flag"}
        </button>
        <button
          type="button"
          className={flag === "complete" ? "cmd cmd--done-on" : "cmd"}
          aria-pressed={flag === "complete"}
          disabled={busy}
          onClick={() => change(() => setTriageAction({ emailIds: [emailId], flag: flag === "complete" ? "none" : "complete" }))}
        >
          <CircleCheck size={16} aria-hidden="true" />
          Complete
        </button>
        <span className="cmd-select">
          <label htmlFor="email-status" className="visually-hidden">
            Status
          </label>
          <select
            id="email-status"
            value={triageStatus}
            disabled={busy}
            onChange={(event) => change(() => setTriageAction({ emailIds: [emailId], status: event.target.value as TriageStatus }))}
          >
            {(Object.keys(TRIAGE_STATUS_NAMES) as TriageStatus[]).map((status) => (
              <option key={status} value={status}>
                {TRIAGE_STATUS_NAMES[status]}
              </option>
            ))}
          </select>
          <ChevronDown size={14} aria-hidden="true" />
        </span>
        <details className="cmd-menu">
          <summary className="cmd">
            <Tag size={16} aria-hidden="true" />
            Labels
          </summary>
          <div className="cmd-menu-panel">
            {labels.length === 0 ? <p className="meta">No labels yet. Add one in the sidebar.</p> : null}
            {labels.map((label) => {
              const on = labelIds.includes(label.id);
              return (
                <label key={label.id} className="label-toggle">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={busy}
                    onChange={() =>
                      change(() => setLabelsAction({ emailIds: [emailId], add: on ? [] : [label.id], remove: on ? [label.id] : [] }))
                    }
                  />
                  <span className={`swatch swatch--${label.color}`} aria-hidden="true" />
                  {label.name}
                </label>
              );
            })}
          </div>
        </details>
        {canRunAgent ? (
          <span className="cmd-run">
            <RunAgentButton emailId={emailId} />
          </span>
        ) : null}
        <span className="cmd-nav">
          <span className="cmd-pos num">
            {position} of {total}
          </span>
          {previousId ? (
            <Link className="icon-btn" href={mailHref({ folder, emailId: previousId, view: "detail" })} aria-label="Previous email">
              <ChevronLeft size={18} aria-hidden="true" />
            </Link>
          ) : (
            <span className="icon-btn" aria-disabled="true">
              <ChevronLeft size={18} aria-hidden="true" />
            </span>
          )}
          {nextId ? (
            <Link className="icon-btn" href={mailHref({ folder, emailId: nextId, view: "detail" })} aria-label="Next email">
              <ChevronRight size={18} aria-hidden="true" />
            </Link>
          ) : (
            <span className="icon-btn" aria-disabled="true">
              <ChevronRight size={18} aria-hidden="true" />
            </span>
          )}
        </span>
      </div>

      <p className={notice?.problem ? "reading-notice card card--bad" : "reading-notice"} role="status" aria-live="polite" hidden={!notice}>
        {notice?.text}
      </p>

      <div className="reading-grid">
        <div className="reading-message">
          {message}
          {composing ? <ReplyComposer key={`${emailId}-${reply.updatedAt?.toISOString() ?? reply.state}`} reply={reply} onClose={() => setComposing(false)} /> : null}
        </div>
        <aside className="reading-agent" aria-label="What the agent did">
          {agentPanel}
        </aside>
      </div>
    </div>
  );
}

const STATE_WORDS: Record<ReplyView["state"], string> = {
  none: "New reply",
  "agent-draft": "The agent’s draft",
  draft: "Your draft",
  ready: "Approved for sending",
};

// The reply, composed as in Outlook: To, Subject and the message, prefilled from the agent's
// draft. "Approve for sending" is logged as would send; nothing leaves this desk.
function ReplyComposer({ reply, onClose }: { reply: ReplyView; onClose: () => void }) {
  const router = useRouter();
  const [subject, setSubject] = useState(reply.subject);
  const [body, setBody] = useState(reply.body);
  const [notice, setNotice] = useState<{ text: string; problem: boolean } | null>(null);
  const [busy, startBusy] = useTransition();

  function save(state: "draft" | "ready") {
    setNotice(null);
    startBusy(async () => {
      try {
        const result = await saveReplyAction({ emailId: reply.emailId, subject, body, state });
        if (!result.ok) {
          setNotice({ text: result.message, problem: true });
          return;
        }
        setNotice({ text: state === "ready" ? "Approved for sending. Logged as would send." : "Draft saved.", problem: false });
        router.refresh();
      } catch {
        setNotice({ text: "The server didn’t answer. Your text is still here; try again.", problem: true });
      }
    });
  }

  function discard() {
    setNotice(null);
    startBusy(async () => {
      try {
        const result = await discardReplyAction({ emailId: reply.emailId });
        if (!result.ok) {
          setNotice({ text: result.message, problem: true });
          return;
        }
        router.refresh();
        onClose();
      } catch {
        setNotice({ text: "The server didn’t answer. Try again in a moment.", problem: true });
      }
    });
  }

  return (
    <form
      className="composer"
      aria-label="Reply"
      onSubmit={(event) => {
        event.preventDefault();
        save("ready");
      }}
    >
      <div className="composer-head">
        <span className={`composer-state composer-state--${reply.state}`}>{STATE_WORDS[reply.state]}</span>
        {reply.updatedAt && reply.updatedByName ? (
          <span className="meta">
            Saved by {reply.updatedByName}
          </span>
        ) : null}
      </div>
      <div className="composer-field">
        <span className="composer-label">To</span>
        <span className="composer-to">{reply.to}</span>
      </div>
      <div className="composer-field">
        <label htmlFor="reply-subject" className="composer-label">
          Subject
        </label>
        <input id="reply-subject" value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={200} required />
      </div>
      <label htmlFor="reply-body" className="visually-hidden">
        Message
      </label>
      <textarea
        id="reply-body"
        className="composer-body"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        rows={10}
        maxLength={10000}
        placeholder="Write your reply"
        required
      />
      <p className="composer-note">Replies aren’t sent from this desk. Approving one logs it as would send.</p>
      <p className={notice?.problem ? "inline-error" : "composer-saved"} role="status" aria-live="polite" hidden={!notice}>
        {notice?.text}
      </p>
      <div className="composer-actions">
        <button type="submit" className="btn btn--primary" disabled={busy} aria-busy={busy}>
          <Send size={16} aria-hidden="true" />
          Approve for sending
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => save("draft")}>
          <Save size={16} aria-hidden="true" />
          Save draft
        </button>
        {reply.state === "draft" || reply.state === "ready" ? (
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={discard}>
            <Trash2 size={16} aria-hidden="true" />
            Discard
          </button>
        ) : (
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={onClose}>
            Close
          </button>
        )}
      </div>
    </form>
  );
}
