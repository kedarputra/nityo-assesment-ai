import type { Metadata, Viewport } from "next";
import { DM_Mono, Plus_Jakarta_Sans } from "next/font/google";
import { Suspense, type ReactNode } from "react";
import { InboxRunProvider } from "@/components/inbox-run";
import { folderCounts } from "@/components/mail/folders";
import { DrawerScrim } from "@/components/shell/shell-buttons";
import { ShellProvider } from "@/components/shell/shell-state";
import { Sidebar } from "@/components/shell/sidebar";
import { TopBar } from "@/components/shell/top-bar";
import { MAIN_CONTENT_ID, SkipLink } from "@/components/site-header";
import { getCurrentUser } from "@/server/auth/current-user";
import { loadDeskEmails, loadLabels, loadPresence } from "@/server/desk/load";
import "./globals.css";

// Plus Jakarta Sans for every word on the desk, DM Mono for identifiers (DESIGN.md, "Type").
const sans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
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
    { media: "(prefers-color-scheme: light)", color: "#fbf6ee" },
    { media: "(prefers-color-scheme: dark)", color: "#151726" },
  ],
};

// Run all, the selected-email runs and Reset are server actions posted from any page; the agent
// reads on after they answer (ADR 0004), within a function's 300 s.
export const maxDuration = 300;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();

  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <SkipLink />
        <InboxRunProvider>{user ? <AppShell user={user}>{children}</AppShell> : <SignedOut>{children}</SignedOut>}</InboxRunProvider>
      </body>
    </html>
  );
}

// The signed-in desk (ADR 0005): the top bar across, the sidebar down the left, the page beside.
async function AppShell({ user, children }: { user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>; children: ReactNode }) {
  const [emails, labels, presence] = await Promise.all([loadDeskEmails(), loadLabels(), loadPresence()]);
  const sidebar = (
    <Sidebar
      counts={folderCounts(emails)}
      labels={labels}
      role={user.role}
      presence={presence.state}
      reading={presence.reading.length}
    />
  );
  return (
    <ShellProvider>
      <TopBar user={user} presence={presence} />
      <div className="app-columns">
        {/* The sidebar marks the folder in the URL's query, read in the browser. */}
        <Suspense fallback={<nav id="sidebar" className="sidebar" aria-label="Main" />}>{sidebar}</Suspense>
        <DrawerScrim />
        <main id={MAIN_CONTENT_ID} className="app-main">
          {children}
        </main>
      </div>
    </ShellProvider>
  );
}

function SignedOut({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="top top--signed-out">
        <span className="wordmark" translate="no">
          Harbor Point <span>Order desk</span>
        </span>
      </header>
      <main id={MAIN_CONTENT_ID} className="page">
        {children}
      </main>
    </>
  );
}
