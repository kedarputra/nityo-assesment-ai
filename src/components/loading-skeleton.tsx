"use client";

import { useLinkStatus } from "next/link";
import { createPortal } from "react-dom";

// The pages are rendered on a server far from the desk, so a click can take a moment to land.
// Inside a <Link>, this puts a skeleton of what is coming into the part of the page that will
// change, the moment the link is clicked (Next.js `useLinkStatus`), and takes it away when the
// page arrives. CSS hides the old content beside it (`:has(> .skeleton-overlay)`).

const PLACES = {
  // An email row: the email and its Proposal.
  email: ".reading-message",
  proposal: ".reading-agent",
  // A filter chip: the list of emails.
  rows: ".rows-wrap",
  // A header tab: the whole page.
  page: ".app-main",
} as const;

export type SkeletonPlace = keyof typeof PLACES;

export function LoadingSkeleton({ into }: { into: SkeletonPlace[] }) {
  const { pending } = useLinkStatus();
  // Never pending while the server renders, so `document` is only read in the browser.
  if (!pending || typeof document === "undefined") return null;

  return into.map((place) => {
    const target = document.querySelector(PLACES[place]);
    return target ? createPortal(<Skeleton place={place} />, target, place) : null;
  });
}

function Skeleton({ place }: { place: SkeletonPlace }) {
  return (
    <div className={`skeleton-overlay skeleton-overlay--${place}`} aria-busy="true" role="status">
      <span className="visually-hidden">Loading…</span>
      {place === "email" ? <EmailSkeleton /> : null}
      {place === "proposal" ? <ProposalSkeleton /> : null}
      {place === "rows" ? <RowsSkeleton /> : null}
      {place === "page" ? <PageSkeleton /> : null}
    </div>
  );
}

function EmailSkeleton() {
  return (
    <>
      <div className="sk-head">
        <span className="sk sk-avatar" />
        <span className="sk-lines">
          <span className="sk sk-line sk-line--title" />
          <span className="sk sk-line sk-line--meta" />
        </span>
      </div>
      <span className="sk sk-block" />
    </>
  );
}

function ProposalSkeleton() {
  return (
    <>
      <span className="sk sk-pill" />
      <span className="sk sk-line sk-line--title" />
      <span className="sk sk-line sk-line--meta" />
      <span className="sk sk-card" />
      {[0, 1, 2].map((row) => (
        <span key={row} className="sk sk-line sk-line--row" />
      ))}
    </>
  );
}

function RowsSkeleton() {
  return (
    <>
      {[0, 1, 2, 3, 4, 5].map((row) => (
        <div key={row} className="sk-row">
          <span className="sk sk-avatar" />
          <span className="sk-lines">
            <span className="sk sk-line sk-line--name" />
            <span className="sk sk-line sk-line--meta" />
            <span className="sk sk-pill" />
          </span>
        </div>
      ))}
    </>
  );
}

function PageSkeleton() {
  return (
    <>
      <span className="sk sk-line sk-line--title" />
      <span className="sk sk-line sk-line--meta" />
      <span className="sk sk-card" />
      <span className="sk sk-card" />
    </>
  );
}
