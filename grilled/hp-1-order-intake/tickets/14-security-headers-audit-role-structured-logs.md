# 14 — Security headers, an append-only audit role, and structured logs

**What to build:** The deployed app sends strict security headers, the database itself refuses to change or delete audit history, and logs say what happened without ever containing an email, a prompt or a secret.

**Repo:** harbor-point

**Blocked by:** 06 — [Tracer: run the agent on one email, and a clean order releases](06-tracer-run-the-agent-on-e001.md)

**Label:** sandcastle

**Status:** closed — resolved 2026-11-06 23:36 WIB by sandcastle

## Context

The map is [`map.md`](../map.md); words are defined in [`CONTEXT.md`](../../../CONTEXT.md); every screen follows [`DESIGN.md`](../../../DESIGN.md), whose living example is Variant A of [the prototype](../assets/prototype-review-ui.html). The business rules are in the [data pack README](../../../data/harbor_point_data_pack/README.md); the data pack is read-only.

- [Security 4, 6 and 8](../issues/06-security-controls.md#answer): CSP with no inline scripts beyond
  Next.js's nonce, `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors 'none'`, HSTS; the
  app's database role has INSERT and SELECT on the audit table but no UPDATE or DELETE (the Reset
  runs as the migration role); logs carry run ids, email ids, tool names, timings and errors only.
- [Speed and observability targets](../issues/12-speed-and-observability.md#answer): one JSON log line
  per tool call and per error; no third-party monitoring service.

## Acceptance criteria

- [ ] Every response carries the CSP and the other headers; a test asserts them.
- [ ] A migration creates the app role without UPDATE or DELETE on the audit table; a test proves an UPDATE and a DELETE as the app role fail; the Reset still works as the migration role.
- [ ] A small logger emits one JSON line per tool call and per error with run id, email id, tool name, duration and error class; a test proves an email body, a prompt, a reply and an env secret never appear in log output.
- [ ] `DESIGN.md`'s calm error states are used for any error shown to a person.
