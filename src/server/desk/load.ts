import { cache } from "react";
import type { DeskLabel } from "@/components/mail/folders";
import { getDatabase } from "@/db/client";
import { listDeskEmails } from "./desk-emails";
import { agentPresence } from "./presence";
import { listLabels } from "./triage";

// What the shell and the mail view both read, once per request (React `cache`): the day's
// emails with their triage, the labels, and the agent's presence.
export const loadDeskEmails = cache(() => listDeskEmails(getDatabase()));
export const loadLabels = cache(async (): Promise<DeskLabel[]> => listLabels(getDatabase()));
export const loadPresence = cache(() => agentPresence(getDatabase()));
