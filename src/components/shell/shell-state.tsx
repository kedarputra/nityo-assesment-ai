"use client";

import { usePathname } from "next/navigation";
import { createContext, useContext, useState, type ReactNode } from "react";
import { useRemembered } from "../remembered";

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
  const [stored, setStored] = useRemembered<"0" | "1">(COLLAPSED_KEY, "0");
  const collapsed = stored === "1";
  // The drawer is open on the page it was opened on; going anywhere else closes it.
  const pathname = usePathname();
  const [openOn, setOpenOn] = useState<string | null>(null);
  const drawerOpen = openOn === pathname;
  const setDrawerOpen = (open: boolean) => setOpenOn(open ? pathname : null);

  function toggleCollapsed() {
    setStored(collapsed ? "0" : "1");
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
