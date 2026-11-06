# 01 — Scaffold the app and its checks

**What to build:** A TypeScript Next.js (App Router) app that builds, with a database harness, a fake-able model interface, the design shell, and real checks behind `make verify` and `make check`, so every later ticket lands on a gate that proves something.

**Repo:** harbor-point

**Blocked by:** None (can start immediately)

**Label:** sandcastle

**Status:** ready-for-agent

## Context

The map is [`map.md`](../map.md); words are defined in [`CONTEXT.md`](../../../CONTEXT.md); every screen follows [`DESIGN.md`](../../../DESIGN.md), whose living example is Variant A of [the prototype](../assets/prototype-review-ui.html). The business rules are in the [data pack README](../../../data/harbor_point_data_pack/README.md); the data pack is read-only.

- Stack: [ADR 0002](../../../docs/adr/0002-nextjs-postgres-claude-on-vercel.md). Next.js App Router, Drizzle on
  Postgres, `pg` with a module-scope pool (`drizzle-orm/node-postgres` + `attachDatabasePool`) in
  production, PGlite (or an equivalent in-process Postgres) in tests, so no check needs a database
  server or Docker.
- `AGENTS.md`, "Checks: the Makefile contract": this is the scaffold ticket that fills `make verify`
  and `make check` with real targets. No other ticket should merge before it. No check calls a paid
  model API.
- [Security 8](../issues/06-security-controls.md#answer): `make check` runs a dependency audit that fails
  on a high finding.
- Fonts and tokens: `DESIGN.md` front matter (Plus Jakarta Sans and DM Mono through `next/font`,
  light and dark tokens as CSS custom properties).

## Acceptance criteria

- [ ] `make setup` installs dependencies; `make verify BASE=<branch> CHANGED=<file>` runs lint, the type check and the tests relevant to the changed files; `make check` runs lint, the type check, every test, the production build and the dependency audit (high and above fails). The Makefile header's "NOT SET UP YET" note is replaced by what the targets now do.
- [ ] A Drizzle setup with migrations, a test helper that gives each test a fresh migrated database in process, and one passing example test that proves it.
- [ ] A model interface (send messages and tool definitions, get back text or tool calls) with a scripted fake used by tests, and an Anthropic implementation that reads the model id from an env var defaulting to `claude-opus-5-5`. No test touches the Anthropic implementation's network path.
- [ ] `/api/health` answers 200 with no sign-in, touches the database, and returns nothing sensitive.
- [ ] A root layout that applies the `DESIGN.md` tokens (light and dark via `prefers-color-scheme`), loads both fonts through `next/font`, and renders the header wordmark "Harbor Point Order desk". A skip link exists.
- [ ] An `.env.example` listing every env var the app reads (no values); `.env*` stays git-ignored.
- [ ] `make check` passes on a clean clone after `make setup`.
