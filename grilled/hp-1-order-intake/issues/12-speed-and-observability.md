# 12 — Speed and observability targets

**Type:** grilling

**Blocked by:** 05, 06 — [the inbox run and reset](05-inbox-run-and-reset.md) and [the security controls](06-security-controls.md)

**Status:** closed — resolved by Kedar Putra (recommended options, standing instruction), 2026-11-06 21:25 WIB

## Question

How fast must the desk feel, and what does the app record about itself in production, without
breaking security 8 (no email bodies, prompts, replies or secrets in logs)?

## Answer

Each decision is the recommended option, taken under the developer's standing instruction.

**Speed targets.** These are acceptance criteria where a ticket touches them.
- **A person's action:** approve, edit, reject or hold answers in under 500 ms at p95 on the
  server, and the UI updates optimistically.
- **The inbox:** shows the email list in under 1.5 s on a desk with broadband, with the database
  awake.
- **An Agent run:** usually under 60 s per email; the hard cap is the 300 s function limit, with
  the clean deadline stop ([the inbox run and reset](05-inbox-run-and-reset.md)). The UI shows
  "Reading…" throughout.
- **Neon's cold start** (a few hundred ms after 5 minutes idle) is accepted. No keep-warm pings.

**Observability, kept lean:**
- **Agent run records in Postgres:** the run id, email id, start and end, model calls,
  tokens in and out, estimated cost, outcome, gate verdict and error class. The audit log
  links to them, and the eval reads them.
- **Structured logs:** one JSON line per tool call and per error, in Vercel's function logs, with
  the run id, email id, tool name, duration and error class. They never contain an email body, a
  prompt, a reply or a secret (security 8).
- **A `/api/health` check:** it touches the database, needs no sign-in, and returns nothing
  sensitive.
- **No third-party monitoring service** (APM or error tracker) for this take-home. Vercel's logs and
  the Agent run records are enough, and adding a service means another secret and another data
  processor.
