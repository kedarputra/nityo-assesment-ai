"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export const AUDIT_LOG_PATH = "/audit";

const SECTIONS = [
  { href: "/", name: "Inbox" },
  { href: AUDIT_LOG_PATH, name: "Audit log" },
] as const;

export function HeaderNav() {
  const pathname = usePathname();

  return (
    <nav className="tabs" aria-label="Sections">
      {SECTIONS.map((section) => (
        <Link key={section.href} href={section.href} aria-current={pathname === section.href ? "page" : undefined}>
          {section.name}
        </Link>
      ))}
    </nav>
  );
}
