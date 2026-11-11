"use client";

import {
  ArrowUpDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Flag,
  Layers,
  ListFilter,
  Play,
  Search,
  Tag,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { TriageFlag, TriageStatus } from "@/db/schema";
import { formatBusinessTime } from "@/lib/business-clock";
import { runSelectedAction, setLabelsAction, setTriageAction } from "@/server/desk/actions";
import { RowStatus } from "../inbox/agent-run";
import { Avatar } from "../inbox/avatar";
import { LoadingSkeleton } from "../loading-skeleton";
import {
  FLAG_NAMES,
  TRIAGE_STATUS_NAMES,
  mailHref,
  needsReview,
  type DeskEmail,
  type DeskLabel,
  type FolderId,
} from "./folders";
import { LabelChip } from "./label-chip";

const PAGE_SIZE = 20;
const MAX_RUN_SELECTED = 20;

type SortKey = "oldest" | "newest" | "sender" | "customer" | "attention";
type GroupKey = "none" | "attention" | "triage" | "customer" | "label";
type FlagFilter = "any" | "needs-review" | "follow-up" | "complete" | "none";

const SORT_NAMES: Record<SortKey, string> = {
  oldest: "Oldest first",
  newest: "Newest first",
  sender: "Sender A–Z",
  customer: "Customer A–Z",
  attention: "Needs review first",
};

const GROUP_NAMES: Record<GroupKey, string> = {
  none: "No grouping",
  attention: "Needs review or not",
  triage: "Status",
  customer: "Customer",
  label: "Label",
};

export interface MailListProps {
  folder: FolderId;
  title: string;
  purpose: string;
  emails: DeskEmail[];
  labels: DeskLabel[];
  selectedId: string | null;
  agentOn: boolean;
}

// The message list (ADR 0005), as in Outlook: a checkbox on every row and one for the page, the
// selection's actions in a bar, search inside the folder, sorting, filtering and grouping, and
// pages of 20. Everything here works on the folder's emails in the browser, so it is instant.
export function MailList({ folder, title, purpose, emails, labels, selectedId, agentOn }: MailListProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useRemembered<SortKey>("hp.mail.sort", "oldest");
  const [group, setGroup] = useRemembered<GroupKey>("hp.mail.group", "none");
  const [flagFilter, setFlagFilter] = useState<FlagFilter>("any");
  const [statusFilter, setStatusFilter] = useState<TriageStatus | "any">("any");
  const [labelFilter, setLabelFilter] = useState<number | "any">("any");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [closedGroups, setClosedGroups] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState<{ text: string; problem: boolean } | null>(null);
  const [busy, startBusy] = useTransition();

  // A new folder starts on its first page with nothing selected.
  useEffect(() => {
    setPage(0);
    setSelected(new Set());
  }, [folder]);

  const filtered = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return emails.filter((email) => {
      if (words.length > 0) {
        const haystack = `${email.fromName} ${email.fromEmail} ${email.subject} ${email.preview} ${email.customerName ?? ""} ${email.emailId}`.toLowerCase();
        if (!words.every((word) => haystack.includes(word))) return false;
      }
      if (flagFilter === "needs-review" && !needsReview(email)) return false;
      if (flagFilter !== "any" && flagFilter !== "needs-review" && email.flag !== flagFilter) return false;
      if (statusFilter !== "any" && email.triageStatus !== statusFilter) return false;
      if (labelFilter !== "any" && !email.labelIds.includes(labelFilter)) return false;
      return true;
    });
  }, [emails, query, flagFilter, statusFilter, labelFilter]);

  const sorted = useMemo(() => sortEmails(filtered, sort), [filtered, sort]);
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const onPage = sorted.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const groups = useMemo(() => groupEmails(onPage, group, labels), [onPage, group, labels]);

  const pageIds = onPage.map((email) => email.emailId);
  const selectedOnPage = pageIds.filter((id) => selected.has(id)).length;
  const allOnPage = pageIds.length > 0 && selectedOnPage === pageIds.length;
  const headerBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerBox.current) headerBox.current.indeterminate = selectedOnPage > 0 && !allOnPage;
  }, [selectedOnPage, allOnPage]);

  const filtersOn = flagFilter !== "any" || statusFilter !== "any" || labelFilter !== "any" || query !== "";
  const start = sorted.length === 0 ? 0 : safePage * PAGE_SIZE + 1;
  const end = safePage * PAGE_SIZE + onPage.length;

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function togglePage() {
    setSelected((current) => {
      const next = new Set(current);
      if (allOnPage) for (const id of pageIds) next.delete(id);
      else for (const id of pageIds) next.add(id);
      return next;
    });
  }

  function act(work: () => Promise<{ ok: true } | { ok: false; message: string }>, done: string) {
    setMessage(null);
    startBusy(async () => {
      try {
        const result = await work();
        if (!result.ok) {
          setMessage({ text: result.message, problem: true });
          return;
        }
        setMessage({ text: done, problem: false });
        setSelected(new Set());
        router.refresh();
      } catch {
        setMessage({ text: "The server didn’t answer. Try again in a moment.", problem: true });
      }
    });
  }

  const chosen = [...selected];
  const count = chosen.length;
  const emailsWord = count === 1 ? "1 email" : `${count} emails`;

  return (
    <section className="mail-list" aria-labelledby="mail-list-title">
      <header className="list-head">
        <div className="list-title-row">
          <h1 id="mail-list-title" className="list-title">
            {title}
          </h1>
          <span className="list-count" aria-label={`${emails.length} emails`}>
            {emails.length}
          </span>
        </div>
        <p className="list-purpose">{purpose}</p>
        <div className="local-search">
          <Search size={16} aria-hidden="true" />
          <label htmlFor="local-search" className="visually-hidden">
            Search this folder
          </label>
          <input
            id="local-search"
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
            placeholder={`Search ${title}`}
            autoComplete="off"
          />
        </div>
      </header>

      {count > 0 ? (
        <div className="bulk-bar" role="toolbar" aria-label="Actions on the selected emails">
          <span className="bulk-count">
            <b>{count}</b> selected
          </span>
          <select
            aria-label="Add a label to the selected emails"
            value=""
            disabled={busy || labels.length === 0}
            onChange={(event) =>
              act(() => setLabelsAction({ emailIds: chosen, add: [Number(event.target.value)], remove: [] }), `Label added to ${emailsWord}.`)
            }
          >
            <option value="" disabled>
              Add label…
            </option>
            {labels.map((label) => (
              <option key={label.id} value={label.id}>
                {label.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Remove a label from the selected emails"
            value=""
            disabled={busy || labels.length === 0}
            onChange={(event) =>
              act(() => setLabelsAction({ emailIds: chosen, add: [], remove: [Number(event.target.value)] }), `Label removed from ${emailsWord}.`)
            }
          >
            <option value="" disabled>
              Remove label…
            </option>
            {labels.map((label) => (
              <option key={label.id} value={label.id}>
                {label.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Set the status of the selected emails"
            value=""
            disabled={busy}
            onChange={(event) =>
              act(
                () => setTriageAction({ emailIds: chosen, status: event.target.value as TriageStatus }),
                `${emailsWord} marked ${TRIAGE_STATUS_NAMES[event.target.value as TriageStatus]}.`,
              )
            }
          >
            <option value="" disabled>
              Set status…
            </option>
            {(Object.keys(TRIAGE_STATUS_NAMES) as TriageStatus[]).map((status) => (
              <option key={status} value={status}>
                {TRIAGE_STATUS_NAMES[status]}
              </option>
            ))}
          </select>
          <select
            aria-label="Flag the selected emails"
            value=""
            disabled={busy}
            onChange={(event) =>
              act(
                () => setTriageAction({ emailIds: chosen, flag: event.target.value as TriageFlag }),
                `${emailsWord}: ${FLAG_NAMES[event.target.value as TriageFlag].toLowerCase()}.`,
              )
            }
          >
            <option value="" disabled>
              Flag…
            </option>
            {(Object.keys(FLAG_NAMES) as TriageFlag[]).map((flag) => (
              <option key={flag} value={flag}>
                {FLAG_NAMES[flag]}
              </option>
            ))}
          </select>
          {agentOn ? (
            <button
              type="button"
              className="btn btn--small"
              disabled={busy || count > MAX_RUN_SELECTED}
              title={count > MAX_RUN_SELECTED ? `Up to ${MAX_RUN_SELECTED} at a time` : undefined}
              onClick={() => act(() => runSelectedAction({ emailIds: chosen }), `The agent is reading ${emailsWord} in the background.`)}
            >
              <Play size={14} aria-hidden="true" />
              Run agent
            </button>
          ) : null}
          <button type="button" className="icon-btn" aria-label="Clear the selection" onClick={() => setSelected(new Set())}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      <div className="list-tools">
        <label className="select-all">
          <input ref={headerBox} type="checkbox" checked={allOnPage} onChange={togglePage} disabled={pageIds.length === 0} />
          <span className="visually-hidden">Select every email on this page</span>
        </label>
        <ToolSelect icon={ArrowUpDown} label="Sort" value={sort} onChange={(value) => setSort(value as SortKey)} options={SORT_NAMES} />
        <ToolSelect icon={Layers} label="Group" value={group} onChange={(value) => setGroup(value as GroupKey)} options={GROUP_NAMES} />
        <details className="filter-menu">
          <summary className="tool-btn">
            <ListFilter size={14} aria-hidden="true" />
            Filter{filtersOn ? <span className="tool-dot" aria-label="(on)" /> : null}
          </summary>
          <div className="filter-panel">
            <label>
              Flag
              <select value={flagFilter} onChange={(event) => setFlagFilter(event.target.value as FlagFilter)}>
                <option value="any">Any</option>
                <option value="needs-review">Needs review (red)</option>
                <option value="follow-up">Follow up (amber)</option>
                <option value="complete">Complete</option>
                <option value="none">No flag</option>
              </select>
            </label>
            <label>
              Status
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as TriageStatus | "any")}>
                <option value="any">Any</option>
                {(Object.keys(TRIAGE_STATUS_NAMES) as TriageStatus[]).map((status) => (
                  <option key={status} value={status}>
                    {TRIAGE_STATUS_NAMES[status]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Label
              <select value={labelFilter} onChange={(event) => setLabelFilter(event.target.value === "any" ? "any" : Number(event.target.value))}>
                <option value="any">Any</option>
                {labels.map((label) => (
                  <option key={label.id} value={label.id}>
                    {label.name}
                  </option>
                ))}
              </select>
            </label>
            {filtersOn ? (
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={() => {
                  setFlagFilter("any");
                  setStatusFilter("any");
                  setLabelFilter("any");
                  setQuery("");
                }}
              >
                Clear filters
              </button>
            ) : null}
          </div>
        </details>
      </div>

      {allOnPage && sorted.length > onPage.length && selected.size < sorted.length ? (
        <p className="select-more">
          All {onPage.length} on this page are selected.{" "}
          <button type="button" className="link-btn" onClick={() => setSelected(new Set(sorted.map((email) => email.emailId)))}>
            Select all {sorted.length} in {title}
          </button>
        </p>
      ) : null}

      <p className={message?.problem ? "list-message card card--bad" : "list-message"} role="status" aria-live="polite" hidden={!message}>
        {message?.text}
      </p>

      <div className="rows-wrap">
        {sorted.length === 0 ? (
          <p className="list-empty">{filtersOn ? "No email matches. Clear the search or the filters." : "Nothing here right now."}</p>
        ) : (
          groups.map((section) => {
            const closed = closedGroups.has(section.key);
            return (
              <div key={section.key} className="row-group">
                {group !== "none" ? (
                  <button
                    type="button"
                    className="group-head"
                    aria-expanded={!closed}
                    onClick={() =>
                      setClosedGroups((current) => {
                        const next = new Set(current);
                        if (next.has(section.key)) next.delete(section.key);
                        else next.add(section.key);
                        return next;
                      })
                    }
                  >
                    {closed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                    <span>{section.title}</span>
                    <span className="count">{section.emails.length}</span>
                  </button>
                ) : null}
                <ul className="rows" hidden={closed}>
                  {section.emails.map((email) => (
                    <li key={email.emailId}>
                      <MailRow
                        email={email}
                        folder={folder}
                        labels={labels}
                        current={email.emailId === selectedId}
                        checked={selected.has(email.emailId)}
                        onCheck={() => toggle(email.emailId)}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            );
          })
        )}
      </div>

      <nav className="pager" aria-label="Pages">
        <span className="pager-range">
          {start}–{end} of {sorted.length}
        </span>
        <button type="button" className="icon-btn" aria-label="Previous page" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
        <span className="pager-page">
          Page {safePage + 1} of {pageCount}
        </span>
        <button type="button" className="icon-btn" aria-label="Next page" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>
          <ChevronRight size={18} aria-hidden="true" />
        </button>
      </nav>
    </section>
  );
}

function MailRow({
  email,
  folder,
  labels,
  current,
  checked,
  onCheck,
}: {
  email: DeskEmail;
  folder: FolderId;
  labels: DeskLabel[];
  current: boolean;
  checked: boolean;
  onCheck: () => void;
}) {
  const review = needsReview(email);
  return (
    <div className="mail-row" data-current={current ? "true" : undefined} data-checked={checked ? "true" : undefined} data-unread={email.triageStatus === "new" ? "true" : undefined}>
      <label className="row-check">
        <input type="checkbox" checked={checked} onChange={onCheck} />
        <span className="visually-hidden">Select the email from {email.fromName}</span>
      </label>
      <Link href={mailHref({ folder, emailId: email.emailId, view: "detail" })} className="row" aria-current={current ? "true" : undefined}>
        <Avatar name={email.fromName} />
        <span className="row-body">
          <span className="row-top">
            <span className="row-from">{email.fromName}</span>
            <span className="row-marks">
              {review ? (
                <span className="flag-mark flag-mark--review" title="Needs review">
                  <Flag size={14} aria-hidden="true" fill="currentColor" />
                  <span className="visually-hidden">Needs review</span>
                </span>
              ) : null}
              {email.flag === "follow-up" ? (
                <span className="flag-mark flag-mark--follow" title="Flagged to follow up">
                  <Flag size={14} aria-hidden="true" />
                  <span className="visually-hidden">Follow up</span>
                </span>
              ) : null}
              {email.flag === "complete" ? (
                <span className="flag-mark flag-mark--complete" title="Flag complete">
                  <CircleCheck size={14} aria-hidden="true" />
                  <span className="visually-hidden">Complete</span>
                </span>
              ) : null}
              <time className="row-time num" dateTime={email.receivedAt.toISOString()}>
                {formatBusinessTime(email.receivedAt)}
              </time>
            </span>
          </span>
          <span className="row-subject">{email.subject}</span>
          <span className="row-preview">{email.preview}</span>
          <span className="row-bottom">
            <RowStatus emailId={email.emailId} status={email.status} />
            {email.triageStatus !== "new" ? <span className={`triage-chip triage-chip--${email.triageStatus}`}>{TRIAGE_STATUS_NAMES[email.triageStatus]}</span> : null}
            {email.labelIds.map((id) => {
              const label = labels.find((candidate) => candidate.id === id);
              return label ? <LabelChip key={id} label={label} /> : null;
            })}
            {email.reply === "draft" ? <span className="reply-chip">Draft</span> : null}
            {email.reply === "ready" ? <span className="reply-chip reply-chip--ready">Ready to send</span> : null}
          </span>
        </span>
        <LoadingSkeleton into={["email", "proposal"]} />
      </Link>
    </div>
  );
}

function ToolSelect({
  icon: Icon,
  label,
  value,
  onChange,
  options,
}: {
  icon: typeof Tag;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Record<string, string>;
}) {
  const id = `tool-${label.toLowerCase()}`;
  return (
    <span className="tool-select">
      <Icon size={14} aria-hidden="true" />
      <label htmlFor={id} className="visually-hidden">
        {label}
      </label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {Object.entries(options).map(([key, name]) => (
          <option key={key} value={key}>
            {name}
          </option>
        ))}
      </select>
    </span>
  );
}

// A choice this browser remembers between visits, such as the sort order.
function useRemembered<T extends string>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(key);
      if (stored) setValue(stored as T);
    } catch {
      // Not remembered; the default stands.
    }
  }, [key]);
  return [
    value,
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next);
      } catch {
        // Still applied for this visit.
      }
    },
  ];
}

const TRIAGE_ORDER: TriageStatus[] = ["new", "in-progress", "waiting", "done"];
const ATTENTION_ORDER = (email: DeskEmail) => (needsReview(email) ? 0 : email.flag === "follow-up" ? 1 : 2);

export function sortEmails(emails: DeskEmail[], sort: SortKey): DeskEmail[] {
  const byTime = (a: DeskEmail, b: DeskEmail) => a.receivedAt.getTime() - b.receivedAt.getTime();
  const copy = [...emails];
  switch (sort) {
    case "oldest":
      return copy.sort(byTime);
    case "newest":
      return copy.sort((a, b) => byTime(b, a));
    case "sender":
      return copy.sort((a, b) => a.fromName.localeCompare(b.fromName) || byTime(a, b));
    case "customer":
      return copy.sort((a, b) => (a.customerName ?? "~").localeCompare(b.customerName ?? "~") || byTime(a, b));
    case "attention":
      return copy.sort((a, b) => ATTENTION_ORDER(a) - ATTENTION_ORDER(b) || byTime(a, b));
  }
}

interface RowGroup {
  key: string;
  title: string;
  emails: DeskEmail[];
}

export function groupEmails(emails: DeskEmail[], group: GroupKey, labels: DeskLabel[]): RowGroup[] {
  if (group === "none") return [{ key: "all", title: "All", emails }];
  const groups = new Map<string, RowGroup>();
  const add = (key: string, title: string, email: DeskEmail) => {
    const existing = groups.get(key) ?? { key, title, emails: [] };
    existing.emails.push(email);
    groups.set(key, existing);
  };
  for (const email of emails) {
    switch (group) {
      case "attention":
        if (needsReview(email)) add("a-review", "Needs review", email);
        else if (email.flag === "follow-up") add("b-follow", "Flagged to follow up", email);
        else add("c-rest", "Everything else", email);
        break;
      case "triage":
        // Keyed by position, so the groups read New, In progress, Waiting, Done.
        add(`s-${TRIAGE_ORDER.indexOf(email.triageStatus)}`, TRIAGE_STATUS_NAMES[email.triageStatus], email);
        break;
      case "customer":
        add(`c-${email.customerName ?? "~unknown"}`, email.customerName ?? "Unknown sender", email);
        break;
      case "label":
        if (email.labelIds.length === 0) add("~none", "No label", email);
        for (const id of email.labelIds) add(`l-${id}`, labels.find((label) => label.id === id)?.name ?? "Label", email);
        break;
    }
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}
