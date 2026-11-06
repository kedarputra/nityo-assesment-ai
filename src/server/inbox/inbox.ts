import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/db/database";
import { agentRuns, emails, users, type AgentRunOutcome } from "@/db/schema";

// Where an email stands on the desk, from its latest Agent run. Later tickets add the statuses
// a person's decision produces.
export const inboxStatuses = ["not_run", "reading", "released", "needs_you", "no_action", "failed"] as const;
export type InboxStatus = (typeof inboxStatuses)[number];

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
  const runs = await latestRuns(db);
  return rows.map((row) => ({ ...row, status: statusOf(runs.get(row.emailId)) }));
}

export async function findInboxEmail(db: Database, emailId: string): Promise<InboxEmailWithBody | null> {
  const [row] = await db
    .select({ ...listColumns, body: emails.body })
    .from(emails)
    .where(eq(emails.emailId, emailId));
  if (!row) return null;
  const runs = await latestRuns(db, emailId);
  return { ...row, status: statusOf(runs.get(emailId)) };
}

interface LatestRun {
  endedAt: Date | null;
  outcome: AgentRunOutcome | null;
}

// Each email's latest Agent run, newest first so the first one seen wins.
async function latestRuns(db: Database, emailId?: string): Promise<Map<string, LatestRun>> {
  const rows = await db
    .select({ emailId: agentRuns.emailId, endedAt: agentRuns.endedAt, outcome: agentRuns.outcome })
    .from(agentRuns)
    .where(emailId === undefined ? undefined : eq(agentRuns.emailId, emailId))
    .orderBy(desc(agentRuns.startedAt));
  const latest = new Map<string, LatestRun>();
  for (const row of rows) if (!latest.has(row.emailId)) latest.set(row.emailId, row);
  return latest;
}

function statusOf(run: LatestRun | undefined): InboxStatus {
  if (!run) return "not_run";
  if (run.endedAt === null || run.outcome === null) return "reading";
  switch (run.outcome) {
    case "released":
      return "released";
    case "proposal":
    case "routed":
      return "needs_you";
    case "no_action":
      return "no_action";
    case "failed":
      return "failed";
  }
}

// The filter an email of this status falls under, besides All.
function filterOf(status: InboxStatus): Exclude<InboxFilter, "all"> {
  switch (status) {
    case "released":
    case "no_action":
      return "done";
    case "needs_you":
    case "failed":
      return "needs-you";
    case "not_run":
    case "reading":
      return "other";
  }
}

// An email counts as handled once a run has finished with it and nothing is left for a person.
export function isHandled(status: InboxStatus): boolean {
  return filterOf(status) === "done";
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
