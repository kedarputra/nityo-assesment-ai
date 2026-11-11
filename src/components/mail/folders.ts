import { z } from "zod";
import type { LabelColor, TriageFlag, TriageStatus } from "@/db/schema";
import type { InboxStatus } from "@/server/inbox/inbox";

// The same reading of an agent status as the inbox's filters (src/server/inbox/inbox.ts), kept
// here as plain data so the browser bundle never pulls in the server's modules.
const DONE: readonly InboxStatus[] = ["released", "no_action", "approved", "rejected"];
const WAITING_FOR_A_PERSON: readonly InboxStatus[] = ["needs_you", "failed"];

export function isHandled(status: InboxStatus): boolean {
  return DONE.includes(status);
}

export function needsYou(status: InboxStatus): boolean {
  return WAITING_FOR_A_PERSON.includes(status);
}

// The mail view's folders (ADR 0005), shared by the sidebar, the list and the server page. The
// agent's outcome decides the system folders; a person's flag, reply and labels decide the rest.

export const systemFolders = ["inbox", "needs-review", "flagged", "done", "not-run", "drafts", "ready"] as const;
export type SystemFolder = (typeof systemFolders)[number];
export type FolderId = SystemFolder | `label-${number}`;

export type ReplyState = "draft" | "ready" | "agent-draft" | "none";

// One email as the mail list shows it.
export interface DeskEmail {
  emailId: string;
  receivedAt: Date;
  fromName: string;
  fromEmail: string;
  subject: string;
  // The first words of the body, as plain text.
  preview: string;
  customerName: string | null;
  status: InboxStatus;
  triageStatus: TriageStatus;
  flag: TriageFlag;
  labelIds: number[];
  reply: ReplyState;
}

export interface DeskLabel {
  id: number;
  name: string;
  color: LabelColor;
  count: number;
}

export const FOLDER_NAMES: Record<SystemFolder, string> = {
  inbox: "Inbox",
  "needs-review": "Needs review",
  flagged: "Flagged",
  done: "Done",
  "not-run": "Not run yet",
  drafts: "Drafts",
  ready: "Ready to send",
};

// What each folder is for, in a line: the list's subheading.
export const FOLDER_PURPOSE: Record<SystemFolder, string> = {
  inbox: "Every order email received on Mon 2 Nov, oldest first.",
  "needs-review": "Waiting for a person: a Proposal to decide, a request to answer, or a run that didn’t finish.",
  flagged: "Emails someone flagged to follow up.",
  done: "Released by the agent, decided by a person, or needing no action.",
  "not-run": "Emails the agent hasn’t read yet.",
  drafts: "Replies in progress: the agent’s drafts and yours.",
  ready: "Replies approved for sending. Nothing is sent from this desk; each is logged as would send.",
};

// A red flag the system sets: the email waits for a person (ADR 0005). Only a decision clears it.
export function needsReview(email: Pick<DeskEmail, "status">): boolean {
  return needsYou(email.status);
}

export function inFolder(email: DeskEmail, folder: FolderId): boolean {
  if (folder.startsWith("label-")) return email.labelIds.includes(Number(folder.slice("label-".length)));
  switch (folder as SystemFolder) {
    case "inbox":
      return true;
    case "needs-review":
      return needsReview(email);
    case "flagged":
      return email.flag === "follow-up";
    case "done":
      return isHandled(email.status);
    case "not-run":
      return email.status === "not_run";
    case "drafts":
      return email.reply === "draft" || email.reply === "agent-draft";
    case "ready":
      return email.reply === "ready";
  }
  return false;
}

const folderParam = z
  .string()
  .regex(new RegExp(`^(${systemFolders.join("|")}|label-\\d{1,6})$`))
  .catch("inbox");

export function parseFolder(value: string | string[] | undefined): FolderId {
  return folderParam.parse(typeof value === "string" ? value : "inbox") as FolderId;
}

export function folderName(folder: FolderId, labels: DeskLabel[]): string {
  if (folder.startsWith("label-")) {
    const id = Number(folder.slice("label-".length));
    return labels.find((label) => label.id === id)?.name ?? "Label";
  }
  return FOLDER_NAMES[folder as SystemFolder];
}

export function folderPurpose(folder: FolderId): string {
  if (folder.startsWith("label-")) return "Emails carrying this label.";
  return FOLDER_PURPOSE[folder as SystemFolder];
}

export function mailHref({ folder, emailId, view }: { folder: FolderId; emailId?: string | null; view?: "detail" }): string {
  const params = new URLSearchParams();
  if (folder !== "inbox") params.set("folder", folder);
  if (emailId) params.set("email", emailId);
  if (view) params.set("view", view);
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

export function folderCounts(emails: DeskEmail[]): Record<SystemFolder, number> {
  const counts = Object.fromEntries(systemFolders.map((folder) => [folder, 0])) as Record<SystemFolder, number>;
  for (const email of emails) for (const folder of systemFolders) if (inFolder(email, folder)) counts[folder] += 1;
  return counts;
}

export const TRIAGE_STATUS_NAMES: Record<TriageStatus, string> = {
  new: "New",
  "in-progress": "In progress",
  waiting: "Waiting on customer",
  done: "Done",
};

export const FLAG_NAMES: Record<TriageFlag, string> = {
  none: "No flag",
  "follow-up": "Follow up",
  complete: "Complete",
};
