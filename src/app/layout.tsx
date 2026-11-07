import type { Metadata, Viewport } from "next";
import { DM_Mono, Plus_Jakarta_Sans } from "next/font/google";
import type { ReactNode } from "react";
import { InboxRunProvider } from "@/components/inbox-run";
import { MAIN_CONTENT_ID, SiteHeader, SkipLink } from "@/components/site-header";
import { getDatabase } from "@/db/client";
import { getCurrentUser } from "@/server/auth/current-user";
import { isAnyRunGoing } from "@/server/inbox/inbox-run";
import "./globals.css";

const sans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

const mono = DM_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Order desk · Harbor Point",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // The canvas token of each theme; metadata cannot read a CSS custom property.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f3ee" },
    { media: "(prefers-color-scheme: dark)", color: "#141517" },
  ],
};

// The admin's Run all and Reset are server actions posted from the header on any page, and one
// email's Agent run can take most of the 300 s a function is allowed (ADR 0003).
export const maxDuration = 300;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  // Only an admin's menu offers Stop.
  const runGoing = user?.role === "admin" ? await isAnyRunGoing(getDatabase(), new Date()) : false;

  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <SkipLink />
        <InboxRunProvider>
          <SiteHeader user={user} runGoing={runGoing} />
          <main id={MAIN_CONTENT_ID} className="page">
            {children}
          </main>
        </InboxRunProvider>
      </body>
    </html>
  );
}
