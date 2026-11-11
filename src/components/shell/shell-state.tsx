"use client";

import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// The shell's own state: the sidebar collapsed to icons on a desk, or opened as a drawer on a
// phone. A collapsed sidebar is remembered in this browser only.

interface ShellState {
  collapsed: boolean;
  toggleCollapsed: () => void;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
}

const ShellContext = createContext<ShellState | null>(null);
const COLLAPSED_KEY = "hp.sidebar.collapsed";

export function ShellProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSED_KEY) === "1");
    } catch {
      // Storage can be blocked; the sidebar then simply starts open.
    }
  }, []);

  // Choosing a page in the drawer takes you there and closes it.
  useEffect(() => setDrawerOpen(false), [pathname]);

  function toggleCollapsed() {
    setCollapsed((current) => {
      try {
        window.localStorage.setItem(COLLAPSED_KEY, current ? "0" : "1");
      } catch {
        // Not remembered; it still toggles.
      }
      return !current;
    });
  }

  return (
    <ShellContext.Provider value={{ collapsed, toggleCollapsed, drawerOpen, setDrawerOpen }}>
      <div
        className="app-body"
        data-collapsed={collapsed ? "true" : undefined}
        data-drawer={drawerOpen ? "open" : undefined}
        // A link chosen in the drawer closes it, a folder change included (same page, new query).
        onClick={(event) => {
          if (drawerOpen && event.target instanceof Element && event.target.closest("#sidebar a")) setDrawerOpen(false);
        }}
      >
        {children}
      </div>
    </ShellContext.Provider>
  );
}

export function useShell(): ShellState {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useShell outside ShellProvider");
  return shell;
}
