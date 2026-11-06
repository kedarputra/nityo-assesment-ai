"use client";

import { useEffect, useRef, useState, useTransition, type KeyboardEvent } from "react";
import { isHardRule } from "@/agent/release-checks";
import { formatUsd } from "@/lib/money";
import type { DraftReplyView, ProposalLineView, ProposalView } from "@/server/inbox/email-work";
import {
  approveProposalAction,
  editProposalAction,
  markReplyReadyAction,
  searchProductsAction,
  setProposalAsideAction,
  type ReviewActionResult,
} from "@/server/review/actions";
import type { ProductMatch, ProposalEdit, SetAsideKind } from "@/server/review/review";
import { checkName, CheckList, lockedBecause, PassingChecks } from "./checks";
import { useReviewDesk } from "./review-desk";

// The review controls for an undecided Proposal (DESIGN.md, "Components" and "Interaction"): a
// note for each soft check, edits that re-run the checks at once, and the decision bar. The
// server re-checks everything; what is offered here is only what it would allow.

export function ProposalReview({ proposal, takesKeys }: { proposal: ProposalView; takesKeys: boolean }) {
  const desk = useReviewDesk();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [setAside, setSetAside] = useState<SetAsideKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();
  const noteFields = useRef(new Map<string, HTMLInputElement>());

  const failing = proposal.checks.filter((check) => !check.passes);
  const hardRules = failing.filter((check) => isHardRule(check.check));
  const softChecks = failing.filter((check) => !isHardRule(check.check));
  const hardBlocked = hardRules.length > 0;
  const canHold = proposal.status !== "held";

  function focusNote(check: string | undefined) {
    if (check) requestAnimationFrame(() => noteFields.current.get(check)?.focus());
  }

  function settle(result: ReviewActionResult) {
    if (result.ok) {
      setError(null);
      desk?.decided(result);
      return;
    }
    if (result.missingNotes.length > 0) {
      setError(
        `Add a quick note about why it’s OK: ${result.missingNotes.map((check) => checkName(check).toLowerCase()).join(", ")}.`,
      );
      focusNote(result.missingNotes[0]);
      return;
    }
    setError(result.message);
  }

  function approve() {
    if (hardBlocked || busy) return;
    const missing = softChecks.filter((check) => (notes[check.check] ?? "").trim() === "").map((check) => check.check);
    if (missing.length > 0) {
      settle({ ok: false, message: "", missingNotes: missing, hardRules: [] });
      return;
    }
    startTransition(async () => settle(await approveProposalAction({ proposalId: proposal.id, notes })));
  }

  function confirmSetAside(kind: SetAsideKind, reason: string) {
    if (reason.trim() === "") {
      setError("Add a short note so the team knows why.");
      return;
    }
    startTransition(async () => {
      const result = await setProposalAsideAction({ proposalId: proposal.id, kind, reason });
      if (result.ok) setSetAside(null);
      settle(result);
    });
  }

  function edit(change: ProposalEdit) {
    startTransition(async () => {
      const result = await editProposalAction({ proposalId: proposal.id, edit: change });
      setError(result.ok ? null : result.message);
    });
  }

  function askReason(kind: SetAsideKind) {
    setError(null);
    setSetAside(kind);
  }

  const setDecisionKeys = desk?.setDecisionKeys;
  const keysRef = useRef({ approve, askReason });
  useEffect(() => {
    keysRef.current = { approve, askReason };
  });
  useEffect(() => {
    if (!takesKeys || !setDecisionKeys) return;
    setDecisionKeys({
      approve: hardBlocked ? undefined : () => keysRef.current.approve(),
      reject: () => keysRef.current.askReason("reject"),
      hold: canHold ? () => keysRef.current.askReason("hold") : undefined,
    });
    return () => setDecisionKeys(null);
  }, [takesKeys, setDecisionKeys, hardBlocked, canHold]);

  return (
    <>
      {failing.length > 0 ? (
        <section
          className={hardBlocked ? "why-waiting why-waiting--hard" : "why-waiting"}
          aria-label="Why it’s waiting for you"
        >
          <h3 className="section-name">Why it’s waiting for you</h3>
          <CheckList
            checks={failing}
            extra={(check) =>
              isHardRule(check.check) ? (
                <span className="lock">{lockedBecause(check.check)}</span>
              ) : (
                <input
                  ref={(field) => {
                    if (field) noteFields.current.set(check.check, field);
                    else noteFields.current.delete(check.check);
                  }}
                  className="override-note"
                  aria-label={`Why “${checkName(check.check).toLowerCase()}” is OK`}
                  placeholder="Add a quick note about why it’s OK…"
                  maxLength={500}
                  value={notes[check.check] ?? ""}
                  onChange={(event) => setNotes((current) => ({ ...current, [check.check]: event.target.value }))}
                />
              )
            }
          />
        </section>
      ) : null}
      <PassingChecks checks={proposal.checks} />
      <EditableLines proposal={proposal} busy={busy} onEdit={edit} />
      <ShipToChoice proposal={proposal} busy={busy} onEdit={edit} />
      <div className="decision-bar">
        <p className="inline-error" role="alert" hidden={error === null}>
          {error}
        </p>
        {setAside ? (
          <InlineReason
            kind={setAside}
            busy={busy}
            onConfirm={(reason) => confirmSetAside(setAside, reason)}
            onCancel={() => {
              setSetAside(null);
              setError(null);
            }}
          />
        ) : (
          <div className="actions">
            {hardBlocked ? null : (
              <button type="button" className="btn btn--primary" aria-busy={busy} disabled={busy} onClick={approve}>
                {busy ? <span className="spinner" aria-hidden="true" /> : null}
                Approve &amp; release <kbd className="desk-only">a</kbd>
              </button>
            )}
            {canHold ? (
              <button
                type="button"
                className={hardBlocked ? "btn btn--primary" : "btn"}
                disabled={busy}
                onClick={() => askReason("hold")}
              >
                Put on hold… <kbd className="desk-only">h</kbd>
              </button>
            ) : null}
            <button type="button" className="btn btn--danger" disabled={busy} onClick={() => askReason("reject")}>
              Reject… <kbd className="desk-only">r</kbd>
            </button>
          </div>
        )}
        {!hardBlocked && softChecks.length > 0 && !setAside ? (
          <p className="meta">Approving keeps your {softChecks.length === 1 ? "note" : "notes"} in the audit log.</p>
        ) : null}
      </div>
    </>
  );
}

// Reasons are typed inline, never in a browser prompt; Enter confirms, Esc cancels.
function InlineReason({
  kind,
  busy,
  onConfirm,
  onCancel,
}: {
  kind: SetAsideKind;
  busy: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      onConfirm(reason);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  }

  const rejecting = kind === "reject";
  return (
    <div className="inline-reason">
      <label className="field-label" htmlFor="decision-reason">
        {rejecting ? "Why are we rejecting this?" : "Why are we holding this?"}
      </label>
      <input
        id="decision-reason"
        ref={field}
        value={reason}
        maxLength={500}
        placeholder={rejecting ? "e.g. The customer cancelled by phone…" : "e.g. Waiting for accounts to call back…"}
        onChange={(event) => setReason(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="actions">
        <button
          type="button"
          className={rejecting ? "btn btn--danger" : "btn btn--primary"}
          aria-busy={busy}
          disabled={busy}
          onClick={() => onConfirm(reason)}
        >
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          {rejecting ? "Reject" : "Put on hold"}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

interface EditProps {
  proposal: ProposalView;
  busy: boolean;
  onEdit: (change: ProposalEdit) => void;
}

// Quantities, products and lines can change while the Proposal is undecided; the price cannot.
function EditableLines({ proposal, busy, onEdit }: EditProps) {
  const [choosingFor, setChoosingFor] = useState<number | "new" | null>(null);

  return (
    <div className="lines-edit">
      <table className="lines">
        <thead>
          <tr>
            <th scope="col">Product</th>
            <th scope="col" className="num">
              Qty
            </th>
            <th scope="col" className="num">
              Price
            </th>
            <th scope="col" className="num">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {proposal.lines.map((line) => (
            <tr key={line.lineNo}>
              <td data-label="Product">
                {line.productName ?? "Not in the catalog"}
                <br />
                <span className="id">{line.sku}</span>
                {line.customerWords ? <span className="meta"> They wrote: “{line.customerWords}”</span> : null}
                {choosingFor === line.lineNo ? (
                  <ProductPicker
                    label={`Swap ${line.sku} for`}
                    onPick={(sku) => {
                      setChoosingFor(null);
                      onEdit({ kind: "sku", lineNo: line.lineNo, sku });
                    }}
                    onCancel={() => setChoosingFor(null)}
                  />
                ) : (
                  <span className="line-actions">
                    <button
                      type="button"
                      className="btn btn--ghost"
                      disabled={busy}
                      onClick={() => setChoosingFor(line.lineNo)}
                    >
                      Change product
                    </button>
                    {proposal.lines.length > 1 ? (
                      <button
                        type="button"
                        className="btn btn--ghost"
                        disabled={busy}
                        onClick={() => onEdit({ kind: "remove-line", lineNo: line.lineNo })}
                      >
                        Remove
                      </button>
                    ) : null}
                  </span>
                )}
              </td>
              <td className="num" data-label="Quantity">
                <QuantityField line={line} busy={busy} onEdit={onEdit} />
                {line.available !== null ? <span className="meta">{line.available} on the shelf</span> : null}
              </td>
              <td className="num" data-label="Price">
                {line.unitPriceCents === null ? "–" : formatUsd(line.unitPriceCents)}
                {line.priceSource ? <span className="meta"> {line.priceSource}</span> : null}
              </td>
              <td className="num" data-label="Total">
                {line.lineTotalCents === null ? "–" : formatUsd(line.lineTotalCents)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={3}>
              Order total
            </th>
            <td className="num">{formatUsd(proposal.totalCents)}</td>
          </tr>
        </tfoot>
      </table>
      {choosingFor === "new" ? (
        <ProductPicker
          label="Add a line"
          onPick={(sku) => {
            setChoosingFor(null);
            onEdit({ kind: "add-line", sku, quantity: 1 });
          }}
          onCancel={() => setChoosingFor(null)}
        />
      ) : (
        <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => setChoosingFor("new")}>
          + Add a line
        </button>
      )}
    </div>
  );
}

// A quantity is sent when the field is left or Enter is pressed, and only when it changed.
function QuantityField({
  line,
  busy,
  onEdit,
}: {
  line: ProposalLineView;
  busy: boolean;
  onEdit: (change: ProposalEdit) => void;
}) {
  function commit(value: string) {
    const quantity = Number(value);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity === line.quantity) return;
    onEdit({ kind: "quantity", lineNo: line.lineNo, quantity });
  }

  return (
    <input
      // A fresh field once the server's quantity changes, so it never shows a stale number.
      key={`${line.lineNo}-${line.sku}-${line.quantity}`}
      className="qty"
      type="number"
      min={1}
      step={1}
      inputMode="numeric"
      aria-label={`Quantity of ${line.sku}`}
      defaultValue={line.quantity}
      disabled={busy}
      onBlur={(event) => commit(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit(event.currentTarget.value);
      }}
    />
  );
}

function ProductPicker({
  label,
  onPick,
  onCancel,
}: {
  label: string;
  onPick: (sku: string) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<ProductMatch[]>([]);
  const [, startSearch] = useTransition();
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);

  function search(words: string) {
    setQuery(words);
    startSearch(async () => setMatches(await searchProductsAction(words)));
  }

  return (
    <div className="product-picker">
      <input
        ref={field}
        type="search"
        aria-label={label}
        placeholder="Search by SKU or name…"
        value={query}
        maxLength={100}
        onChange={(event) => search(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
      />
      {matches.length > 0 ? (
        <ul className="product-matches">
          {matches.map((match) => (
            <li key={match.sku}>
              <button type="button" className="btn btn--ghost" onClick={() => onPick(match.sku)}>
                <span className="id">{match.sku}</span> {match.name} · {formatUsd(match.listPriceCents)} list
                {match.status === "DISCONTINUED" ? <span className="meta"> (discontinued)</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <button type="button" className="btn btn--ghost" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

// Only the customer's own ship-tos are offered; the server refuses any other.
function ShipToChoice({ proposal, busy, onEdit }: EditProps) {
  if (proposal.shipToChoices.length < 2) return null;
  const fieldId = `ship-to-${proposal.id}`;
  return (
    <div className="field">
      <label className="field-label" htmlFor={fieldId}>
        Ship to
      </label>
      <select
        id={fieldId}
        value={proposal.shipToId}
        disabled={busy}
        onChange={(event) => onEdit({ kind: "ship-to", shipToId: event.target.value })}
      >
        {proposal.shipToChoices.some((choice) => choice.shipToId === proposal.shipToId) ? null : (
          <option value={proposal.shipToId}>{proposal.shipToId} (not this customer’s)</option>
        )}
        {proposal.shipToChoices.map((choice) => (
          <option key={choice.shipToId} value={choice.shipToId}>
            {choice.name}
          </option>
        ))}
      </select>
    </div>
  );
}

// The Draft reply is the person's to edit until they mark it ready; then it is locked. It is
// never sent from here.
export function DraftReplyEditor({ emailId, reply }: { emailId: string; reply: DraftReplyView }) {
  const [body, setBody] = useState(reply.body);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();
  const ready = reply.readyBy !== null;

  function markReady() {
    startTransition(async () => {
      const result = await markReplyReadyAction({ emailId, body });
      setError(result.ok ? null : result.message);
    });
  }

  return (
    <section className="reply">
      <h3 className="section-name">
        <label htmlFor="draft-reply">Reply to customer</label>
      </h3>
      <textarea
        id="draft-reply"
        className="reading"
        readOnly={ready}
        value={ready ? reply.body : body}
        rows={8}
        maxLength={5000}
        onChange={(event) => setBody(event.target.value)}
      />
      <p className="meta">We never send email from here; this is what would go out.</p>
      <p className="inline-error" role="alert" hidden={error === null}>
        {error}
      </p>
      <div className="actions">
        {ready ? (
          <>
            <span className="pill pill--approved">
              <span aria-hidden="true">✓</span>Reply ready
            </span>
            <span className="meta">by {reply.readyBy}</span>
          </>
        ) : (
          <button type="button" className="btn" aria-busy={busy} disabled={busy} onClick={markReady}>
            {busy ? <span className="spinner" aria-hidden="true" /> : null}
            Mark reply ready
          </button>
        )}
      </div>
    </section>
  );
}
