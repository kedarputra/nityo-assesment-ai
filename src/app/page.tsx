import { MailView } from "@/components/mail/mail-view";
import { parseFolder } from "@/components/mail/folders";
import { getDatabase } from "@/db/client";
import { requireUser } from "@/server/auth/current-user";
import { loadDeskEmails, loadLabels, loadPresence } from "@/server/desk/load";
import { findReply } from "@/server/desk/replies";
import { findEmailWork } from "@/server/inbox/email-work";
import { findInboxEmail } from "@/server/inbox/inbox";

// "Run the agent" and the runs on selected emails are server actions on this page; the agent
// reads on after they answer (`after`, ADR 0004), within the function's 300 s cap.
export const maxDuration = 300;

type SearchParams = Record<string, string | string[] | undefined>;

export default async function MailPage({ searchParams }: PageProps<"/">) {
  // The proxy already turned away anyone without a session; this is the page's own check.
  const user = await requireUser();
  const params: SearchParams = await searchParams;
  const folder = parseFolder(params.folder);
  const view = params.view === "detail" ? "detail" : "list";
  const askedFor = typeof params.email === "string" ? params.email : undefined;
  const emailId = askedFor && /^E\d{3}$/.test(askedFor) ? askedFor : null;
  const db = getDatabase();

  const [emails, labels, presence] = await Promise.all([loadDeskEmails(), loadLabels(), loadPresence()]);
  const [selected, work, reply] = emailId
    ? await Promise.all([findInboxEmail(db, emailId), findEmailWork(db, emailId), findReply(db, emailId)])
    : [null, null, null];

  return (
    <MailView
      folder={folder}
      view={view}
      emails={emails}
      labels={labels}
      selected={selected}
      work={work}
      reply={reply}
      presence={presence}
      isAdmin={user.role === "admin"}
      notFound={askedFor !== undefined && selected === null}
    />
  );
}
