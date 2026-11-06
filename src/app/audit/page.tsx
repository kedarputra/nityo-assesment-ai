import type { Metadata } from "next";
import { AuditLog } from "@/components/audit-log";
import { requireUser } from "@/server/auth/current-user";

export const metadata: Metadata = {
  title: "Audit log · Harbor Point",
};

export default async function AuditLogPage() {
  // The proxy already turned away anyone without a session; this is the page's own check.
  await requireUser();

  return <AuditLog />;
}
