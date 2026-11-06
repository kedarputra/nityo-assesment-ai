import { desc, eq } from "drizzle-orm";
import type { Database } from "@/db/database";
import { auditEvents, users, type AuditActor } from "@/db/schema";

export interface AuditEntry {
  id: number;
  at: Date;
  actor: AuditActor;
  username: string | null;
  action: string;
  emailId: string | null;
  detail: Record<string, unknown>;
}

// The newest events first (DESIGN.md, "Audit log"); a page holds the latest `limit` of them.
export async function listAuditEvents(db: Database, limit = 500): Promise<AuditEntry[]> {
  return db
    .select({
      id: auditEvents.id,
      at: auditEvents.at,
      actor: auditEvents.actor,
      username: users.username,
      action: auditEvents.action,
      emailId: auditEvents.emailId,
      detail: auditEvents.detail,
    })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.userId))
    .orderBy(desc(auditEvents.id))
    .limit(limit);
}
