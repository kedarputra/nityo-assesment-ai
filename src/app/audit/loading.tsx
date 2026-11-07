// The audit log is read from the database on every visit; its skeleton shows at once meanwhile.
export default function AuditLogLoading() {
  return (
    <div className="narrow" aria-busy="true" role="status">
      <h1 className="title">Audit log</h1>
      <p className="meta">Everything the agent did and every call a person made, newest first.</p>
      <span className="visually-hidden">Loading the audit log…</span>
      <div className="card audit-loading">
        {[0, 1, 2, 3, 4, 5].map((row) => (
          <span key={row} className="sk sk-line sk-line--row" />
        ))}
      </div>
    </div>
  );
}
