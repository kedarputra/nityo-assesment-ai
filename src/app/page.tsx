import { InboxDesk } from "@/components/inbox/inbox-desk";
import { getDatabase } from "@/db/client";
import { requireUser } from "@/server/auth/current-user";
import {
  countByFilter,
  findInboxEmail,
  isInFilter,
  isTipDismissed,
  listInboxEmails,
  parseInboxQuery,
} from "@/server/inbox/inbox";

export default async function InboxPage({ searchParams }: PageProps<"/">) {
  // The proxy already turned away anyone without a session; this is the page's own check.
  const user = await requireUser();
  const query = parseInboxQuery(await searchParams);
  const db = getDatabase();

  const [emails, tipDismissed] = await Promise.all([listInboxEmails(db), isTipDismissed(db, user.id)]);
  const shown = emails.filter((email) => isInFilter(email, query.filter));
  // With no email in the URL, the desk opens the first one the filter shows.
  const selectedId = query.emailId ?? shown[0]?.emailId ?? null;
  const selected = selectedId ? await findInboxEmail(db, selectedId) : null;

  return (
    <InboxDesk
      query={query}
      emails={emails}
      counts={countByFilter(emails)}
      shown={shown}
      selected={selected}
      tipDismissed={tipDismissed}
    />
  );
}
