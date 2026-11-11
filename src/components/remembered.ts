"use client";

import { useCallback, useSyncExternalStore } from "react";

// A choice this browser remembers between visits (a sort order, a folded sidebar), read without
// an effect: the server and the first render use the default, then the stored value takes over.
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Storage can be blocked; the default stands.
    return null;
  }
}

export function useRemembered<T extends string>(key: string, initial: T): [T, (value: T) => void] {
  const stored = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => null,
  );
  const set = useCallback(
    (value: T) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Not remembered; the listeners still hear it below only if stored.
      }
      for (const listener of listeners) listener();
    },
    [key],
  );
  return [(stored as T | null) ?? initial, set];
}
