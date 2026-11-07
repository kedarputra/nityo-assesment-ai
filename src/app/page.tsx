import { InboxDesk } from "@/components/inbox/inbox-desk";
import { getDatabase } from "@/db/client";
import { isAgentConfigured } from "@/model/agent-switch";
import { requireUser } from "@/server/auth/current-user";
import { findEmailWork } from "@/server/inbox/email-work";
import { isInboxRunActive } from "@/server/inbox/inbox-run";
import {
  countByFilter,
  findInboxEmail,
  isInFilter,
  isTipDismissed,
  listInboxEmails,
  parseInboxQuery,
} from "@/server/inbox/inbox";

// "Run the agent" and Run all are server actions on this page; the agent reads on after they
// answer (`after`, ADR 0004), within the function's 300 s cap.
export const maxDuration = 300;

export default async function InboxPage({ searchParams }: PageProps<"/">) {
  // The proxy already turned away anyone without a session; this is the page's own check.
  const user = await requireUser();
  const query = parseInboxQuery(await searchParams);
  const db = getDatabase();

  const [emails, tipDismissed, runAllGoing] = await Promise.all([
    listInboxEmails(db),
    isTipDismissed(db, user.id),
    isInboxRunActive(db),
  ]);
  const shown = emails.filter((email) => isInFilter(email, query.filter));
  // With no email in the URL, the desk opens the first one the filter shows. An email the URL asks
  // for that is not in today's inbox (E999, or not an id at all) opens nothing, and says so.
  const askedFor = (await searchParams).email;
  const selectedId = query.emailId ?? (askedFor === undefined ? (shown[0]?.emailId ?? null) : null);
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
      notFound={askedFor !== undefined && selected === null}
      runAllGoing={runAllGoing}
      isAdmin={user.role === "admin"}
    />
  );
}
