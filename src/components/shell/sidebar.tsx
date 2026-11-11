"use client";

import {
  Activity,
  BookOpen,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  FileText,
  Flag,
  Inbox,
  Plus,
  ScrollText,
  Send,
  Tag,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { mailHref, type DeskLabel, type FolderId, type SystemFolder } from "@/components/mail/folders";
import type { LabelColor } from "@/db/schema";
import type { PresenceState } from "@/server/desk/presence";
import { createLabelAction } from "@/server/desk/actions";
import { PresenceDot, PRESENCE_WORDS } from "./presence-badge";
import { CollapseButton } from "./shell-buttons";

export interface SidebarProps {
  counts: Record<SystemFolder, number>;
  labels: DeskLabel[];
  role: "reviewer" | "admin";
  presence: PresenceState;
  reading: number;
}

const LABEL_COLORS: LabelColor[] = ["dusk", "apricot", "sandy", "pumpkin", "green", "red", "grey"];

// The sidebar (ADR 0005): sections of menus, each menu with its sub-menus, every one foldable.
// Counts sit at the right of each item; the item you are on is marked, and its section opens.
export function Sidebar({ counts, labels, role, presence, reading }: SidebarProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const folder = (pathname === "/" ? (searchParams.get("folder") ?? "inbox") : null) as FolderId | null;
  const isFolder = (id: FolderId) => folder === id;

  return (
    <nav id="sidebar" className="sidebar" aria-label="Main">
      <div className="sidebar-top">
        <span className="sidebar-title">Order desk</span>
        <CollapseButton />
      </div>

      <div className="sidebar-scroll">
        <Section title="Mail">
          <Item
            href={mailHref({ folder: "inbox" })}
            icon={Inbox}
            label="Inbox"
            count={counts.inbox}
            current={isFolder("inbox")}
            subItems={
              <>
                <SubItem href={mailHref({ folder: "needs-review" })} label="Needs review" count={counts["needs-review"]} current={isFolder("needs-review")} tone="bad" icon={Flag} />
                <SubItem href={mailHref({ folder: "flagged" })} label="Flagged" count={counts.flagged} current={isFolder("flagged")} tone="warn" icon={Flag} />
                <SubItem href={mailHref({ folder: "done" })} label="Done" count={counts.done} current={isFolder("done")} tone="ok" icon={CircleCheck} />
                <SubItem href={mailHref({ folder: "not-run" })} label="Not run yet" count={counts["not-run"]} current={isFolder("not-run")} />
              </>
            }
            openByDefault
          />
          <Item
            href={mailHref({ folder: "drafts" })}
            icon={FileText}
            label="Drafts"
            count={counts.drafts}
            current={isFolder("drafts")}
            subItems={<SubItem href={mailHref({ folder: "ready" })} label="Ready to send" count={counts.ready} current={isFolder("ready")} icon={Send} />}
            openByDefault
          />
        </Section>

        <Section title="Labels">
          {labels.length === 0 ? <p className="sidebar-empty">No labels yet.</p> : null}
          {labels.map((label) => (
            <Item
              key={label.id}
              href={mailHref({ folder: `label-${label.id}` })}
              icon={Tag}
              label={label.name}
              count={label.count}
              current={isFolder(`label-${label.id}`)}
              swatch={label.color}
            />
          ))}
          <NewLabel />
        </Section>

        <Section title="Agent">
          <Item
            href="/agent"
            icon={Activity}
            label="Activity"
            current={pathname === "/agent"}
            trailing={
              <span className="sidebar-presence" title={`Agent: ${PRESENCE_WORDS[presence]}`}>
                <PresenceDot state={presence} />
                {reading > 0 ? <span className="count">{reading}</span> : null}
              </span>
            }
          />
          <Item href="/agent/schedule" icon={CalendarClock} label={role === "admin" ? "Schedule" : "Schedule (view)"} current={pathname === "/agent/schedule"} />
          <Item href="/audit" icon={ScrollText} label="Audit log" current={pathname === "/audit"} />
        </Section>

        <Section title="Help">
          <Item href="/guide" icon={BookOpen} label={role === "admin" ? "Guide for admins" : "Guide for reviewers"} current={pathname === "/guide"} />
        </Section>
      </div>

      <RoleCard role={role} />
    </nav>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const id = `section-${title.toLowerCase()}`;
  return (
    <div className="sidebar-section">
      <button type="button" className="section-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        <span>{title}</span>
      </button>
      <ul id={id} className="sidebar-list" hidden={!open}>
        {children}
      </ul>
    </div>
  );
}

function Item({
  href,
  icon: Icon,
  label,
  count,
  current,
  subItems,
  openByDefault = false,
  swatch,
  trailing,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  count?: number;
  current: boolean;
  subItems?: ReactNode;
  openByDefault?: boolean;
  swatch?: LabelColor;
  trailing?: ReactNode;
}) {
  const [open, setOpen] = useState(openByDefault);
  const subId = `sub-${label.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <li className="sidebar-item">
      <div className="item-row" data-current={current ? "true" : undefined}>
        <Link href={href} className="item-link" aria-current={current ? "page" : undefined} title={label}>
          {swatch ? <span className={`swatch swatch--${swatch}`} aria-hidden="true" /> : <Icon size={18} aria-hidden="true" />}
          <span className="item-label">{label}</span>
          {trailing ?? (count !== undefined && count > 0 ? <span className="count">{count}</span> : null)}
        </Link>
        {subItems ? (
          <button
            type="button"
            className="item-expand"
            aria-label={open ? `Hide ${label}’s folders` : `Show ${label}’s folders`}
            aria-expanded={open}
            aria-controls={subId}
            onClick={() => setOpen(!open)}
          >
            {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          </button>
        ) : null}
      </div>
      {subItems ? (
        <ul id={subId} className="sidebar-sub" hidden={!open}>
          {subItems}
        </ul>
      ) : null}
    </li>
  );
}

function SubItem({
  href,
  label,
  count,
  current,
  tone,
  icon: Icon,
}: {
  href: string;
  label: string;
  count: number;
  current: boolean;
  tone?: "bad" | "warn" | "ok";
  icon?: LucideIcon;
}) {
  return (
    <li>
      <Link href={href} className={`sub-link${tone ? ` sub-link--${tone}` : ""}`} aria-current={current ? "page" : undefined} title={label}>
        {Icon ? <Icon size={14} aria-hidden="true" className="sub-icon" /> : <span className="sub-dot" aria-hidden="true" />}
        <span className="item-label">{label}</span>
        {count > 0 ? <span className={`count${tone ? ` count--${tone}` : ""}`}>{count}</span> : null}
      </Link>
    </li>
  );
}

function NewLabel() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState<LabelColor>("dusk");
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  if (!open) {
    return (
      <li>
        <button type="button" className="sub-link new-label-btn" onClick={() => setOpen(true)}>
          <Plus size={14} aria-hidden="true" />
          <span className="item-label">New label</span>
        </button>
      </li>
    );
  }

  return (
    <li>
      <form
        className="new-label"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          startSaving(async () => {
            const result = await createLabelAction({ name, color });
            if (!result.ok) {
              setError(result.message);
              return;
            }
            setName("");
            setOpen(false);
            router.refresh();
          });
        }}
      >
        <label htmlFor="new-label-name" className="visually-hidden">
          Label name
        </label>
        <input
          id="new-label-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Label name"
          maxLength={40}
          required
          autoFocus
        />
        <fieldset className="swatches">
          <legend className="visually-hidden">Colour</legend>
          {LABEL_COLORS.map((option) => (
            <label key={option} className={`swatch-pick swatch--${option}`} title={option}>
              <input type="radio" name="label-color" value={option} checked={color === option} onChange={() => setColor(option)} />
              <span className="visually-hidden">{option}</span>
            </label>
          ))}
        </fieldset>
        {error ? <p className="inline-error">{error}</p> : null}
        <div className="new-label-actions">
          <button type="submit" className="btn btn--primary btn--small" disabled={saving} aria-busy={saving}>
            Add label
          </button>
          <button type="button" className="btn btn--ghost btn--small" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      </form>
    </li>
  );
}

// Who you are on this desk and what you can do here: the role's use case, in four lines.
function RoleCard({ role }: { role: "reviewer" | "admin" }) {
  return (
    <div className="role-card">
      <p className="role-card-title">{role === "admin" ? "You’re an admin" : "You’re a reviewer"}</p>
      <ul>
        <li>Decide the agent’s Proposals</li>
        <li>Reply, label, flag and set status</li>
        <li>Run the agent on emails you pick</li>
        {role === "admin" ? <li>Run all, schedule and reset</li> : null}
      </ul>
    </div>
  );
}
