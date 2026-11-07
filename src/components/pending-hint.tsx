"use client";

import { useLinkStatus } from "next/link";

// The pages are rendered on the server, a long way from the desk, so a click can take a moment to
// land. Inside a <Link>, this thin bar runs while that link's page is on its way (Next.js
// `useLinkStatus`), so a click is never silent. Always rendered, so it never shifts the layout.
export function PendingHint() {
  const { pending } = useLinkStatus();
  return <span aria-hidden="true" className={pending ? "pending-hint is-pending" : "pending-hint"} />;
}
