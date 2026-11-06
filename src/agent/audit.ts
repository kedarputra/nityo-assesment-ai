import type { Database } from "@/db/database";
import { auditEvents, type AuditActor } from "@/db/schema";

export interface AuditEvent {
  at: Date;
  actor: AuditActor;
  // The signed-in person behind the event, when there is one.
  userId?: number | null;
  action: string;
  emailId: string | null;
  runId: string | null;
  detail: Record<string, unknown>;
}

// Callers pass the transaction that makes the change, so the event and the change commit together.
export async function recordAudit(db: Database, event: AuditEvent): Promise<void> {
  await db.insert(auditEvents).values(event);
}
