import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "@/agent/audit";
import type { Database } from "@/db/database";
import {
  emailLabels,
  emails,
  emailTriage,
  labelColors,
  labels,
  triageFlags,
  triageStatuses,
  type LabelColor,
  type TriageFlag,
  type TriageStatus,
} from "@/db/schema";

// A person's triage (ADR 0005): labels, a status and a flag beside the agent's outcome. Any
// person may change them, on one email or many at once, and every change is audited in the
// transaction that makes it. The agent's outcome is never touched here.

export class TriageRefused extends Error {
  override name = "TriageRefused";
}

export const LABEL_NAME_MAX = 40;
export const LABEL_EXISTS = "A label with that name already exists.";
const LABEL_GONE = "That label no longer exists.";
const EMAIL_UNKNOWN = "That email isn’t in today’s inbox.";

export interface EmailTriageView {
  emailId: string;
  status: TriageStatus;
  flag: TriageFlag;
  labelIds: number[];
}

export interface LabelView {
  id: number;
  name: string;
  color: LabelColor;
  count: number;
}

export interface Label {
  id: number;
  name: string;
  color: LabelColor;
}

// Every email a person has triaged or labelled. An email missing from the map is New, unflagged
// and unlabelled; one present only for its labels has those defaults too.
export async function listTriage(db: Database): Promise<Map<string, EmailTriageView>> {
  const triaged = await db.select({ emailId: emailTriage.emailId, status: emailTriage.status, flag: emailTriage.flag }).from(emailTriage);
  const labelled = await db
    .select({ emailId: emailLabels.emailId, labelId: emailLabels.labelId })
    .from(emailLabels)
    .orderBy(asc(emailLabels.emailId), asc(emailLabels.labelId));

  const views = new Map<string, EmailTriageView>();
  const viewOf = (emailId: string): EmailTriageView => {
    let view = views.get(emailId);
    if (!view) {
      view = { emailId, status: "new", flag: "none", labelIds: [] };
      views.set(emailId, view);
    }
    return view;
  };
  for (const row of triaged) Object.assign(viewOf(row.emailId), { status: row.status, flag: row.flag });
  for (const row of labelled) viewOf(row.emailId).labelIds.push(row.labelId);
  return views;
}

// The team's labels by name, each with how many emails carry it.
export async function listLabels(db: Database): Promise<LabelView[]> {
  const rows = await db
    .select({ id: labels.id, name: labels.name, color: labels.color, count: count(emailLabels.emailId) })
    .from(labels)
    .leftJoin(emailLabels, eq(emailLabels.labelId, labels.id))
    .groupBy(labels.id)
    .orderBy(asc(sql`lower(${labels.name})`), asc(labels.id));
  return rows.map((row) => ({ ...row, count: Number(row.count) }));
}

export async function createLabel(
  db: Database,
  create: { name: string; color: LabelColor; userId: number; at: Date },
): Promise<Label> {
  const name = create.name.trim().replace(/\s+/g, " ");
  if (name.length === 0) throw new TriageRefused("Give the label a name.");
  if (name.length > LABEL_NAME_MAX) throw new TriageRefused(`A label’s name is at most ${LABEL_NAME_MAX} characters.`);
  if (!(labelColors as readonly string[]).includes(create.color)) throw new TriageRefused("Choose one of the label colours.");

  try {
    return await db.transaction(async (tx) => {
      const [taken] = await tx
        .select({ id: labels.id })
        .from(labels)
        .where(sql`lower(${labels.name}) = lower(${name})`);
      if (taken) throw new TriageRefused(LABEL_EXISTS);
      const [label] = await tx
        .insert(labels)
        .values({ name, color: create.color, createdBy: create.userId, createdAt: create.at })
        .returning({ id: labels.id, name: labels.name, color: labels.color });
      if (!label) throw new Error("The label was not stored.");
      await recordAudit(tx, {
        at: create.at,
        actor: "person",
        userId: create.userId,
        action: "label.created",
        emailId: null,
        runId: null,
        detail: { labelId: label.id, name: label.name, color: label.color },
      });
      return label;
    });
  } catch (error) {
    // Two people creating the same name at once: the unique index has the last word.
    if (isUniqueViolation(error)) throw new TriageRefused(LABEL_EXISTS);
    throw error;
  }
}

// Deletes a label and takes it off every email that carried it.
export async function deleteLabel(db: Database, remove: { labelId: number; userId: number; at: Date }): Promise<void> {
  await db.transaction(async (tx) => {
    const [label] = await tx.select().from(labels).where(eq(labels.id, remove.labelId)).for("update");
    if (!label) throw new TriageRefused(LABEL_GONE);
    const carried = await tx.select({ emailId: emailLabels.emailId }).from(emailLabels).where(eq(emailLabels.labelId, label.id));
    await tx.delete(labels).where(eq(labels.id, label.id));
    await recordAudit(tx, {
      at: remove.at,
      actor: "person",
      userId: remove.userId,
      action: "label.deleted",
      emailId: null,
      runId: null,
      detail: { labelId: label.id, name: label.name, emailIds: carried.map((row) => row.emailId).sort() },
    });
  });
}

// Puts labels on, and takes labels off, every one of `emailIds`. Applying what is already there
// changes nothing and records nothing.
export async function setLabels(
  db: Database,
  change: { emailIds: string[]; add: number[]; remove: number[]; userId: number; at: Date },
): Promise<void> {
  const emailIds = unique(change.emailIds);
  const add = unique(change.add);
  const remove = unique(change.remove).filter((labelId) => !add.includes(labelId));
  if (emailIds.length === 0 || (add.length === 0 && remove.length === 0)) return;

  await db.transaction(async (tx) => {
    await requireEmails(tx, emailIds);
    const known = await tx
      .select({ id: labels.id, name: labels.name })
      .from(labels)
      .where(inArray(labels.id, [...add, ...remove]));
    if (known.length !== add.length + remove.length) throw new TriageRefused(LABEL_GONE);
    const nameOf = new Map(known.map((label) => [label.id, label.name]));

    const added =
      add.length === 0
        ? []
        : await tx
            .insert(emailLabels)
            .values(emailIds.flatMap((emailId) => add.map((labelId) => ({ emailId, labelId, addedBy: change.userId, addedAt: change.at }))))
            .onConflictDoNothing()
            .returning({ emailId: emailLabels.emailId, labelId: emailLabels.labelId });
    const removed =
      remove.length === 0
        ? []
        : await tx
            .delete(emailLabels)
            .where(and(inArray(emailLabels.emailId, emailIds), inArray(emailLabels.labelId, remove)))
            .returning({ emailId: emailLabels.emailId, labelId: emailLabels.labelId });
    if (added.length === 0 && removed.length === 0) return;

    const changed = unique([...added, ...removed].map((row) => row.emailId)).sort();
    await recordAudit(tx, {
      at: change.at,
      actor: "person",
      userId: change.userId,
      action: "labels.changed",
      emailId: changed.length === 1 ? (changed[0] ?? null) : null,
      runId: null,
      detail: {
        added: namesOf(added, nameOf),
        removed: namesOf(removed, nameOf),
        emailIds: changed,
      },
    });
  });
}

// Sets the status, the flag, or both, on every one of `emailIds`.
export async function setTriage(
  db: Database,
  change: { emailIds: string[]; status?: TriageStatus; flag?: TriageFlag; userId: number; at: Date },
): Promise<void> {
  const emailIds = unique(change.emailIds);
  if (change.status === undefined && change.flag === undefined) throw new TriageRefused("Choose a status or a flag.");
  if (change.status !== undefined && !(triageStatuses as readonly string[]).includes(change.status)) {
    throw new TriageRefused("That isn’t a status.");
  }
  if (change.flag !== undefined && !(triageFlags as readonly string[]).includes(change.flag)) throw new TriageRefused("That isn’t a flag.");
  if (emailIds.length === 0) return;

  const set = {
    ...(change.status === undefined ? {} : { status: change.status }),
    ...(change.flag === undefined ? {} : { flag: change.flag }),
    updatedBy: change.userId,
    updatedAt: change.at,
  };
  await db.transaction(async (tx) => {
    await requireEmails(tx, emailIds);
    await tx
      .insert(emailTriage)
      .values(emailIds.map((emailId) => ({ emailId, ...set })))
      .onConflictDoUpdate({ target: emailTriage.emailId, set });
    await recordAudit(tx, {
      at: change.at,
      actor: "person",
      userId: change.userId,
      action: "triage.changed",
      emailId: emailIds.length === 1 ? (emailIds[0] ?? null) : null,
      runId: null,
      detail: {
        ...(change.status === undefined ? {} : { status: change.status }),
        ...(change.flag === undefined ? {} : { flag: change.flag }),
        emailIds: [...emailIds].sort(),
      },
    });
  });
}

async function requireEmails(tx: Database, emailIds: string[]): Promise<void> {
  const found = await tx.select({ emailId: emails.emailId }).from(emails).where(inArray(emails.emailId, emailIds));
  if (found.length !== emailIds.length) throw new TriageRefused(EMAIL_UNKNOWN);
}

function namesOf(rows: { labelId: number }[], nameOf: Map<number, string>): string[] {
  return unique(rows.map((row) => nameOf.get(row.labelId) ?? String(row.labelId))).sort();
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

// Postgres's unique_violation, through Drizzle's wrapper or straight from the driver.
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
