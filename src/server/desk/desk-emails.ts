import { asc, eq } from "drizzle-orm";
import type { DeskEmail } from "@/components/mail/folders";
import type { Database } from "@/db/database";
import { customerContacts, customers, emails } from "@/db/schema";
import { listInboxEmails } from "@/server/inbox/inbox";
import { listReplies } from "./replies";
import { listTriage } from "./triage";

const PREVIEW_CHARS = 140;

// The day's emails as the mail list shows them: the agent's outcome, a person's triage, the
// reply's state, the sender's customer and the first words of the body.
export async function listDeskEmails(db: Database): Promise<DeskEmail[]> {
  const [inbox, bodies, contacts, triage, replies] = await Promise.all([
    listInboxEmails(db),
    db.select({ emailId: emails.emailId, body: emails.body }).from(emails).orderBy(asc(emails.receivedAt)),
    db
      .select({ email: customerContacts.email, name: customers.name })
      .from(customerContacts)
      .innerJoin(customers, eq(customerContacts.customerId, customers.customerId)),
    listTriage(db),
    listReplies(db),
  ]);
  const bodyOf = new Map(bodies.map((row) => [row.emailId, row.body]));
  const customerOf = new Map(contacts.map((row) => [row.email.toLowerCase(), row.name]));

  return inbox.map((email) => {
    const entry = triage.get(email.emailId);
    return {
      ...email,
      preview: previewOf(bodyOf.get(email.emailId) ?? ""),
      customerName: customerOf.get(email.fromEmail.toLowerCase()) ?? null,
      triageStatus: entry?.status ?? "new",
      flag: entry?.flag ?? "none",
      labelIds: entry?.labelIds ?? [],
      reply: replies.get(email.emailId) ?? "none",
    };
  });
}

// The body on one line, cut at a word: what Outlook shows under the subject.
export function previewOf(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= PREVIEW_CHARS) return flat;
  const cut = flat.slice(0, PREVIEW_CHARS);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), PREVIEW_CHARS - 20)).trimEnd()}…`;
}
