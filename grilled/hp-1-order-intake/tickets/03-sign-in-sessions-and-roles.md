# 03 — Sign-in, sessions and roles

**What to build:** People sign in with a seeded named account; everything else requires a session; reviewer and admin roles are checked on the server for every action.

**Repo:** harbor-point

**Blocked by:** 01 — [Scaffold the app and its checks](01-scaffold-app-and-checks.md)

**Label:** sandcastle

**Status:** ready-for-agent

## Context

The map is [`map.md`](../map.md); words are defined in [`CONTEXT.md`](../../../CONTEXT.md); every screen follows [`DESIGN.md`](../../../DESIGN.md), whose living example is Variant A of [the prototype](../assets/prototype-review-ui.html). The business rules are in the [data pack README](../../../data/harbor_point_data_pack/README.md); the data pack is read-only.

- Decided in [Which security controls the build must meet](../issues/06-security-controls.md#answer),
  items 1, 2, 3 and 7: password login, no SSO; argon2id; opaque server-side sessions in an `HttpOnly`,
  `Secure`, `SameSite=Lax` cookie lasting 12 hours, rotated at sign-in, deleted at sign-out; five
  failed sign-ins in 15 minutes lock the account for 15 minutes with one generic message; seeded
  users `ops.reviewer`, `admin` and one assessor login come from env vars at seed time.
- Every approval and decision later records its user (the audit trail), so the session must expose
  the signed-in user and role to server code.

## Acceptance criteria

- [ ] A users table with argon2id password hashes and a role (`reviewer` or `admin`); a seed step creates the three users from env vars and never stores a plain password; no credential is in the repo.
- [ ] A sign-in page styled per `DESIGN.md` (one primary button, inline error, 16px inputs on phones); a sign-out action that deletes the session server-side.
- [ ] Every page and every server action or POST route requires a valid session, except the sign-in page and `/api/health`; an unauthenticated request is redirected or answered 401.
- [ ] A server-side helper that requires a role, used by every state-changing action; tests prove a reviewer is refused an admin-only action even when calling it directly.
- [ ] State-changing POST routes check the `Origin` header (server actions already do); a test proves a cross-origin POST is refused.
- [ ] Tests cover: correct sign-in, wrong password, the generic message for an unknown user, the lock after five failures, session expiry, and sign-out.
