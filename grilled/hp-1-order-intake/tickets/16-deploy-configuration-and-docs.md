# 16 — Deploy configuration and docs

**What to build:** Pushing the repository deploys it: a production build migrates and seeds its database, previews share one seeded database, and the README and `docs/deployment.md` explain how to run it locally and how it is deployed.

**Repo:** harbor-point

**Blocked by:** 02, 03 — [Load the data pack into the database as the Snapshot](02-load-the-data-pack.md), [Sign-in, sessions and roles](03-sign-in-sessions-and-roles.md)

**Label:** sandcastle

**Status:** ready-for-agent

## Context

The map is [`map.md`](../map.md); words are defined in [`CONTEXT.md`](../../../CONTEXT.md); every screen follows [`DESIGN.md`](../../../DESIGN.md), whose living example is Variant A of [the prototype](../assets/prototype-review-ui.html). The business rules are in the [data pack README](../../../data/harbor_point_data_pack/README.md); the data pack is read-only.

- `AGENTS.md`, "Deployment": Vercel through its Git integration; never `vercel deploy` by hand; how
  the deploy is set up, its env vars and its database go in `docs/deployment.md`.
- [How a whole-inbox run is driven and how the snapshot is reset](../issues/05-inbox-run-and-reset.md#answer),
  items 4 and 6: one shared `preview` Neon branch seeded by the preview build; separate preview API
  key and cap; the app on the pooled `DATABASE_URL`, migrations and the reset on
  `DATABASE_URL_UNPOOLED`.
- Brief deliverables 3 and 4: a README explaining how to run locally and how it is deployed, and the
  live URL plus login (the URL and login are filled in after ticket 17).

## Acceptance criteria

- [ ] The Vercel build runs migrations (unpooled URL) and, when the database is empty, the Snapshot seed and the user seed; it never reseeds a database that already has data.
- [ ] Preview builds target the shared preview database; production targets production; the env vars for each are listed in `.env.example` and `docs/deployment.md`.
- [ ] `docs/deployment.md` explains the Vercel project, the Neon databases, every env var, the API keys and their caps, and how to reset production.
- [ ] The README has "Run it locally" (from clone to a working desk with the seeded logins, using a local Postgres or the in-process database), "How it is deployed", and a "Live" section with placeholders for the URL and the assessor login.
- [ ] `make check` still passes.
