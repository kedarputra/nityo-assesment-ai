// The audit log (DESIGN.md, "Audit log"). Nothing writes to it yet: no Agent run or decision
// exists, so it shows only its empty state.
export function AuditLog() {
  return (
    <div className="narrow">
      <h1 className="title">Audit log</h1>
      <p className="meta">Everything the agent did and every call a person made, newest first.</p>
      <div className="card audit-empty">
        <h2 className="headline">Nothing has happened yet</h2>
        <p>
          The agent hasn’t read any emails today, and no one has made a decision. Each step and each call will be
          listed here as it happens.
        </p>
      </div>
    </div>
  );
}
