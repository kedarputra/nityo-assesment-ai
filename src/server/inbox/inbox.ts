import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/db/database";
import { emails, users } from "@/db/schema";

// Where an email stands on the desk. No Agent run exists yet, so every email is "not_run";
// later tickets add the statuses a run and a person's decision produce.
export type InboxStatus = "not_run";

export const inboxFilters = ["all", "needs-you", "done", "other"] as const;
export type InboxFilter = (typeof inboxFilters)[number];

export const inboxViews = ["list", "detail"] as const;
export type InboxView = (typeof inboxViews)[number];

export interface InboxEmail {
  emailId: string;
  receivedAt: Date;
  fromName: string;
  fromEmail: string;
  subject: string;
  status: InboxStatus;
}

export interface InboxEmailWithBody extends InboxEmail {
  body: string;
}

const listColumns = {
  emailId: emails.emailId,
  receivedAt: emails.receivedAt,
  fromName: emails.fromName,
  fromEmail: emails.fromEmail,
  subject: emails.subject,
};

export async function listInboxEmails(db: Database): Promise<InboxEmail[]> {
  const rows = await db.select(listColumns).from(emails).orderBy(asc(emails.receivedAt), asc(emails.emailId));
  return rows.map((row) => ({ ...row, status: "not_run" }));
}

export async function findInboxEmail(db: Database, emailId: string): Promise<InboxEmailWithBody | null> {
  const [row] = await db
    .select({ ...listColumns, body: emails.body })
    .from(emails)
    .where(eq(emails.emailId, emailId));
  return row ? { ...row, status: "not_run" } : null;
}

// The filter an email of this status falls under, besides All.
function filterOf(status: InboxStatus): Exclude<InboxFilter, "all"> {
  switch (status) {
    case "not_run":
      return "other";
  }
}

export function isInFilter(email: InboxEmail, filter: InboxFilter): boolean {
  return filter === "all" || filterOf(email.status) === filter;
}

export function countByFilter(inbox: InboxEmail[]): Record<InboxFilter, number> {
  const counts: Record<InboxFilter, number> = { all: 0, "needs-you": 0, done: 0, other: 0 };
  for (const email of inbox) {
    counts.all += 1;
    counts[filterOf(email.status)] += 1;
  }
  return counts;
}

export async function isTipDismissed(db: Database, userId: number): Promise<boolean> {
  const [user] = await db.select({ tipDismissedAt: users.tipDismissedAt }).from(users).where(eq(users.id, userId));
  return user?.tipDismissedAt != null;
}

export async function dismissTip(db: Database, userId: number, now: Date): Promise<void> {
  await db.update(users).set({ tipDismissedAt: now }).where(eq(users.id, userId));
}

export interface InboxQuery {
  filter: InboxFilter;
  emailId: string | null;
  view: InboxView;
}

type SearchParams = Record<string, string | string[] | undefined>;

// The URL holds the desk's state (DESIGN.md, "Interaction"). Anything it does not recognise
// falls back to the default rather than failing the page.
const inboxQuery = z.object({
  filter: z.enum(inboxFilters).catch("all"),
  email: z
    .string()
    .regex(/^E\d{3}$/)
    .nullable()
    .catch(null),
  view: z.enum(inboxViews).catch("list"),
});

export function parseInboxQuery(searchParams: SearchParams): InboxQuery {
  const query = inboxQuery.parse({
    filter: searchParams.filter,
    email: searchParams.email ?? null,
    view: searchParams.view,
  });
  return { filter: query.filter, emailId: query.email, view: query.view };
}
