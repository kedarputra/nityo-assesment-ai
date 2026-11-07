"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useTransition,
  type ReactNode,
  type RefObject,
} from "react";
import type { InboxFilter, InboxView } from "@/server/inbox/inbox";
import { undoReleaseAction, type ReviewActionResult } from "@/server/review/actions";

// The desk around every decision (DESIGN.md, "Interaction"): the toast with its 10-second Undo,
// moving to the next email that needs you, and the keys on a desk.

const UNDO_SECONDS = 10;

export interface DecisionKeys {
  approve?: () => void;
  reject: () => void;
  hold?: () => void;
}

interface ReviewDesk {
  // A decision succeeded: show its toast and move on if the email is decided.
  decided: (result: Extract<ReviewActionResult, { ok: true }>) => void;
  // The selected email's first undecided Proposal takes `a`, `r` and `h`.
  setDecisionKeys: (keys: DecisionKeys | null) => void;
}

const ReviewDeskContext = createContext<ReviewDesk | null>(null);

export function useReviewDesk(): ReviewDesk | null {
  return useContext(ReviewDeskContext);
}

interface Toast {
  message: string;
  undoProposalId: number | null;
}

export interface ReviewDeskProviderProps {
  filter: InboxFilter;
  view: InboxView;
  // The emails the list shows, in order, and the one selected: `j` and `k` move between them.
  shownIds: string[];
  selectedId: string | null;
  children: ReactNode;
}

export function ReviewDeskProvider({ filter, view, shownIds, selectedId, children }: ReviewDeskProviderProps) {
  const router = useRouter();
  const [toast, setToast] = useState<Toast | null>(null);
  const [undoing, startUndo] = useTransition();
  const keysRef = useRef<DecisionKeys | null>(null);
  const keyListRef = useRef<HTMLDialogElement | null>(null);

  // The list follows the selection, so `j`, `k`, a deep link or coming back from an email on a
  // phone always shows the selected row ("nearest" leaves a row that is already visible alone).
  // A phone opening an email starts at the top of it, with "← All emails" in view.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const phone = window.matchMedia("(max-width: 767px)").matches;
      if (view === "detail" && phone) {
        window.scrollTo({ top: 0 });
        return;
      }
      if (selectedId !== null) {
        // Back on a phone's list, the email you came from sits in the middle, not on the edge.
        document.querySelector('.row[aria-current="true"]')?.scrollIntoView({ block: phone ? "center" : "nearest" });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedId, view]);

  const go = useCallback(
    (emailId: string | null) => {
      const params = new URLSearchParams({ filter });
      if (emailId) params.set("email", emailId);
      // On a phone, nothing left to decide goes back to the list.
      params.set("view", emailId ? view : "list");
      router.push(`/?${params.toString()}`);
    },
    [filter, view, router],
  );

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), UNDO_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [toast]);

  const decided = useCallback<ReviewDesk["decided"]>(
    (result) => {
      setToast(result.toast === null ? null : { message: result.toast, undoProposalId: result.undoProposalId });
      if (result.moveOn) go(result.moveOn.nextEmailId);
    },
    [go],
  );

  const setDecisionKeys = useCallback<ReviewDesk["setDecisionKeys"]>((keys) => {
    keysRef.current = keys;
  }, []);

  function undo(proposalId: number) {
    startUndo(async () => {
      const result = await undoReleaseAction({ proposalId });
      if (result.ok) decided(result);
      else setToast({ message: result.message, undoProposalId: null });
    });
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!onDesk() || isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      const keys = keysRef.current;
      switch (event.key) {
        case "j":
        case "k": {
          const position = selectedId === null ? -1 : shownIds.indexOf(selectedId);
          const step = event.key === "j" ? 1 : -1;
          const next = shownIds[(position + step + shownIds.length) % shownIds.length];
          if (next) go(next);
          return;
        }
        case "a":
          keys?.approve?.();
          return;
        case "r":
          keys?.reject();
          return;
        case "h":
          keys?.hold?.();
          return;
        case "?": {
          const keyList = keyListRef.current;
          if (keyList?.open) keyList.close();
          else keyList?.showModal();
          return;
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [go, selectedId, shownIds]);

  return (
    <ReviewDeskContext.Provider value={{ decided, setDecisionKeys }}>
      {children}
      <KeyList dialogRef={keyListRef} />
      <div className="toast-region" aria-live="polite">
        {toast ? (
          <div className="toast">
            <span>{toast.message}</span>
            {toast.undoProposalId !== null ? (
              <button
                type="button"
                className="btn btn--toast"
                aria-busy={undoing}
                disabled={undoing}
                onClick={() => toast.undoProposalId !== null && undo(toast.undoProposalId)}
              >
                {undoing ? <span className="spinner" aria-hidden="true" /> : null}
                Undo
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </ReviewDeskContext.Provider>
  );
}

const KEYS: [string, string][] = [
  ["j", "Next email"],
  ["k", "Previous email"],
  ["a", "Approve the open Proposal"],
  ["r", "Reject it, with a reason"],
  ["h", "Hold it, with a reason"],
  ["?", "Show or hide these keys"],
];

// `?` opens the list of keys (DESIGN.md, "Interaction"); a native dialog keeps focus inside it
// and closes on Esc.
function KeyList({ dialogRef }: { dialogRef: RefObject<HTMLDialogElement | null> }) {
  return (
    <dialog ref={dialogRef} className="key-list" aria-labelledby="key-list-title">
      <h2 id="key-list-title" className="headline">
        Keyboard keys
      </h2>
      <dl>
        {KEYS.map(([key, action]) => (
          <div key={key}>
            <dt>
              <kbd>{key}</kbd>
            </dt>
            <dd>{action}</dd>
          </div>
        ))}
      </dl>
      <p className="meta">Keys work on a wide screen, and never while you’re typing.</p>
      <form method="dialog">
        <button type="submit" className="btn">
          Close
        </button>
      </form>
    </dialog>
  );
}

// Keys are a desk's (DESIGN.md: phones and tablets get visible buttons for every action).
function onDesk(): boolean {
  return window.matchMedia("(min-width: 1200px)").matches;
}

// Keys are never intercepted while typing.
function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable]") !== null;
}
