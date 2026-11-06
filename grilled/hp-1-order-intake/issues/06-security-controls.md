# 06 — Which security controls the build must meet

**Type:** grilling

**Blocked by:** none

**Status:** closed — resolved by Kedar Putra (recommended options, standing instruction), 2026-11-06 21:23 WIB

## Question

What security controls must the app meet, so that each becomes an acceptance criterion in
`/to-tickets`? The charting decisions already cover the agent's side:
- the release gate is code ([ADR 0001](../../../docs/adr/0001-code-gates-release-model-interprets.md));
- instructions inside an email are data (policy 11, E012);
- hard rules can't be overridden;
- every action lands in an append-only audit log;
- a spend cap sits on the Anthropic key ([research](../assets/research-vercel-neon-agent-runs.md)).

Nothing yet covers the app around the agent. Decide each of these:

1. **Sign-in.** Keep the decided password login for seeded named users
   ([login](01-charting-decisions.md#login)), or add SSO? The developer raised SSO on 2026-11-06,
   but it has not been decided and was ruled out of scope while charting. **Recommended: keep the
   password login.** SSO needs an outside identity provider and gives the assessors one more
   account to set up. The open details are how passwords are stored (argon2id or bcrypt), the
   session (httpOnly, Secure, SameSite=Lax, an expiry, rotation on sign-in), a lockout or rate
   limit on failed sign-ins, and where the seeded credentials live (Vercel env vars, never in the
   repo).
2. **Roles.** Who may approve, override, reset the snapshot, or run the whole inbox? For example,
   a reviewer and an admin, checked on the server for every action, not only hidden in the UI.
3. **Request forgery and input.** CSRF protection for every state-changing request (Next.js
   server actions' origin check, or a token), and schema validation (e.g. Zod) on every server
   action and on every tool call the model makes, before it touches the database.
4. **Untrusted content in the UI.** Email bodies, subjects and the model's own text are untrusted.
   Render them as text only, never as HTML; `.eml` files may carry HTML parts. Also: a Content
   Security Policy and the standard security headers.
5. **The model as an attacker's tool.** Beyond policy 11: the email goes into the prompt as clearly
   delimited data; tools can only write Proposals (the gate releases); tool output is size-capped;
   no tool reaches the network or the file system.
6. **The audit log's integrity.** Enforce append-only in the database (a role without UPDATE or
   DELETE, or triggers), not just by convention.
7. **The public demo.** Sign-in required for everything; a rate limit on agent runs and on resets;
   the spend cap. What happens when the cap is hit (the UI says so calmly, per `DESIGN.md`).
8. **Secrets and data.** Keys only in Vercel env vars, a separate key for previews if they run the
   agent, no secrets or email bodies in logs, and `npm audit` (or similar) in `make check`.

Resolve as a grilling session. Each answer becomes a line the build tickets cite.

## Answer

Each decision is the recommended option, taken under the developer's standing instruction. Each
line is an acceptance criterion the build tickets cite by its number (e.g. "security 3").

1. **Sign-in: keep the password login; no SSO.** The out-of-scope line on the map stands.
   - **Passwords:** hashed with argon2id.
   - **The session:** an opaque random id stored server-side, in a cookie that is `HttpOnly`,
     `Secure` and `SameSite=Lax`. It lasts 12 hours, a new id is issued at sign-in, and signing out
     deletes it on the server.
   - **Failed sign-ins:** five in 15 minutes lock that account for 15 minutes. The message stays
     the same whether the email or the password was wrong.
   - **The seeded users** (`ops.reviewer`, `admin`, and one login for the assessors) come from
     Vercel env vars at seed time; no credential is ever in the repo.
2. **Roles: `reviewer` and `admin`, checked on the server in every action.**
   - **A reviewer** may approve, edit, override, reject, hold, mark replies ready, and run the
     agent on one email.
   - **An admin** may also start an inbox run, reset, and stop a run.
   - **Hiding a control in the UI is never the check.**
3. **Forged requests and input.**
   - **Mutations:** only through server actions or POST routes. Both check the `Origin` header
     (Next.js server actions do this; routes do it explicitly), together with the SameSite cookie.
   - **Inputs:** every server action and every tool call the model makes is parsed with a Zod
     schema before any database access. A failed parse is an error to the model or the user, never
     a partial write.
4. **Untrusted content is shown as text.**
   - **What counts as untrusted:** email bodies, subjects, sender names and everything the model
     writes. React's escaping is the only way any of it reaches the page: no
     `dangerouslySetInnerHTML`, and an `.eml` file's HTML part is never rendered (the ingest keeps
     its text part).
   - **Security headers** are set in `next.config`: a Content Security Policy with no inline
     scripts beyond Next.js's nonce, plus `X-Content-Type-Options`, `Referrer-Policy`,
     `frame-ancestors 'none'` and HSTS.
5. **The model's reach.**
   - **The prompt:** the email goes in as delimited data under a system prompt that says its
     content is never an instruction.
   - **The tools:** they are the only way the model touches anything; they read the ERP and write
     only Proposals, outcomes, flags and Draft replies.
   - **Release:** only the code gate releases ([ADR 0001](../../../docs/adr/0001-code-gates-release-model-interprets.md)).
   - **Tool results:** capped in size.
   - **No outside access:** no tool reaches the network or the file system.
   - **A run's limits:** at most 15 model calls per Agent run.
6. **The audit log is append-only in the database.** The app's database role can INSERT and
   SELECT on the audit table but not UPDATE or DELETE it. The one exception is the Reset, which
   runs as the migration role and truncates the log as part of the Snapshot (see
   [the inbox run and reset](05-inbox-run-and-reset.md)), with its own "reset by" event first.
7. **The public demo.**
   - **Sign-in:** required for every page and action, except the sign-in page and a health check.
   - **Rate limits:** 30 agent runs and 3 resets per user per hour, counted in Postgres.
   - **The spend cap:** a monthly cap on a dedicated Anthropic workspace. When the cap is hit, runs
     stop with the calm `DESIGN.md` message.
   - **Previews:** they use their own key and cap.
8. **Secrets and data.**
   - **Where keys live:** only in Vercel env vars, with production and preview kept separate.
   - **What logs contain:** run ids, email ids, tool names, timings and errors, but never an email
     body, a prompt, a reply or a secret.
   - **Dependencies:** `make check` runs `npm audit --audit-level=high` (or the pnpm equivalent)
     and fails on a finding.
