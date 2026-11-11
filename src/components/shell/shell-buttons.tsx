"use client";

import { Menu, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { useShell } from "./shell-state";

// On a phone: opens the sidebar as a drawer.
export function DrawerButton() {
  const { drawerOpen, setDrawerOpen } = useShell();
  return (
    <button
      type="button"
      className="icon-btn drawer-btn"
      aria-label={drawerOpen ? "Close the menu" : "Open the menu"}
      aria-expanded={drawerOpen}
      aria-controls="sidebar"
      onClick={() => setDrawerOpen(!drawerOpen)}
    >
      {drawerOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
    </button>
  );
}

// On a desk: folds the sidebar to its icons, or opens it again.
export function CollapseButton() {
  const { collapsed, toggleCollapsed } = useShell();
  return (
    <button
      type="button"
      className="icon-btn collapse-btn"
      aria-label={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
      aria-expanded={!collapsed}
      aria-controls="sidebar"
      onClick={toggleCollapsed}
    >
      {collapsed ? <PanelLeftOpen size={18} aria-hidden="true" /> : <PanelLeftClose size={18} aria-hidden="true" />}
    </button>
  );
}

// The dimmed page behind an open drawer; a tap closes it.
export function DrawerScrim() {
  const { drawerOpen, setDrawerOpen } = useShell();
  if (!drawerOpen) return null;
  return <button type="button" className="drawer-scrim" aria-label="Close the menu" onClick={() => setDrawerOpen(false)} />;
}
