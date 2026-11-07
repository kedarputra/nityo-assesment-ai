// The audit log's page is read from the database on every visit; this shows at once while it comes.
export default function AuditLogLoading() {
  return (
    <div className="narrow" aria-busy="true">
      <h1 className="title">Audit log</h1>
      <p className="meta">Everything the agent did and every call a person made, newest first.</p>
      <div className="card audit-loading" role="status">
        <span className="spinner" aria-hidden="true" />
        <span>Loading the audit log…</span>
      </div>
    </div>
  );
}
