import { InboxDesk } from "@/components/inbox/inbox-desk";
import { getDatabase } from "@/db/client";
import { isAgentConfigured } from "@/model/agent-switch";
import { requireUser } from "@/server/auth/current-user";
import { findEmailWork } from "@/server/inbox/email-work";
import {
  countByFilter,
  findInboxEmail,
  isInFilter,
  isTipDismissed,
  listInboxEmails,
  parseInboxQuery,
} from "@/server/inbox/inbox";

// "Run the agent" is a server action on this page, and one Agent run usually takes under a
// minute; 300 s is the function's hard cap (speed and observability targets).
export const maxDuration = 300;

export default async function InboxPage({ searchParams }: PageProps<"/">) {
  // The proxy already turned away anyone without a session; this is the page's own check.
  const user = await requireUser();
  const query = parseInboxQuery(await searchParams);
  const db = getDatabase();

  const [emails, tipDismissed] = await Promise.all([listInboxEmails(db), isTipDismissed(db, user.id)]);
  const shown = emails.filter((email) => isInFilter(email, query.filter));
  // With no email in the URL, the desk opens the first one the filter shows.
  const selectedId = query.emailId ?? shown[0]?.emailId ?? null;
  const [selected, work] = selectedId
    ? await Promise.all([findInboxEmail(db, selectedId), findEmailWork(db, selectedId)])
    : [null, null];

  return (
    <InboxDesk
      query={query}
      emails={emails}
      counts={countByFilter(emails)}
      shown={shown}
      selected={selected}
      work={work}
      tipDismissed={tipDismissed}
      agentOn={isAgentConfigured()}
    />
  );
}
