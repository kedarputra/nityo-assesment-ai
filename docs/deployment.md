# Deployment

Vercel builds and hosts the app through its Git integration; Neon, added through the Vercel
marketplace, is its Postgres; Claude is reached with an API key from a capped Anthropic workspace.
Nothing is deployed by hand: never run `vercel deploy` or `vercel --prod`.

Why these services, and the limits behind each choice:
[ADR 0002](adr/0002-nextjs-postgres-claude-on-vercel.md) and
[the research](../grilled/hp-1-order-intake/assets/research-vercel-neon-agent-runs.md). The
decisions this page carries out:
[how the snapshot is reset and how previews share a database](../grilled/hp-1-order-intake/issues/05-inbox-run-and-reset.md#answer).

## What a push does

| Push | Deploys | Database | Anthropic workspace |
| --- | --- | --- | --- |
| to `main` (a merged PR) | production, at the live URL | Neon `main` branch | `harbor-point-production` |
| to any other branch | a preview, at its own URL | Neon `preview` branch, shared by every preview | `harbor-point-preview` |

Every build runs [`vercel.json`](../vercel.json)'s build command:

```sh
npm run db:prepare && npm run build
```

`db:prepare` ([`scripts/prepare-database.ts`](../scripts/prepare-database.ts)) connects on
`DATABASE_URL_UNPOOLED` and:

1. takes a Postgres advisory lock, so two builds on the shared preview database never migrate or
   seed it at the same time;
2. runs the Drizzle migrations in `drizzle/`;
3. seeds the Snapshot (the data pack, through the same ingest as the Reset) if the ERP tables are
   empty, and the three logins from the `SEED_*` variables if there are no users. Both seeds are
   one transaction.

**A deploy never reseeds a database that has data.** The second and later builds only migrate, so
whatever the agent and the reviewers did survives a deploy. To return a database to the Snapshot,
reset it (below). If a seed is needed and a `SEED_*` variable is missing or too short, the build
fails with the variable's name and writes nothing.

A failed `db:prepare` fails the build, so Vercel keeps serving the previous deployment.

## The Vercel project

- Created from the GitHub repository with the Git integration. Production branch: `main`.
  Framework preset: Next.js (also pinned in `vercel.json`). Node 22 (`.nvmrc`).
- **Fluid compute on.** The agent's run-one-email route is to set `maxDuration = 300`, Hobby's
  limit; one email's run fits in it, and the whole-inbox run is driven by the browser one email at
  a time ([ADR 0003](adr/0003-browser-driven-inbox-run.md)).
- **Hobby plan.** Pro is the fallback if real runs prove slower.

## The Neon databases

One Neon project, on the Free plan, provisioned through the Vercel marketplace integration, with
two branches:

- **`main`**, the root branch: production's database.
- **`preview`**, a child of `main`, created by hand in the Neon console: the one database every
  preview deployment uses. Previews do **not** get a branch each. Leave the integration's "Create
  database branch for deployment: Preview" **off**: the Free plan has 10 branches and Vercel keeps
  preview deployments for 6 months, so a branch per preview runs out. Create it before the first
  production deploy, so it starts empty and the first preview build seeds it; a branch made later
  copies production's data, and wants a reset.

The integration injects `DATABASE_URL` and `DATABASE_URL_UNPOOLED` for production. For Preview,
set both by hand to the `preview` branch's pooled and direct connection strings (Neon console >
the `preview` branch > Connect).

The app uses the **pooled** `DATABASE_URL`, through one `pg` pool per function instance
([`src/db/client.ts`](../src/db/client.ts)); it holds no session state, so PgBouncer's
transaction mode is safe. Migrations, the seeds and the Reset use the **direct**
`DATABASE_URL_UNPOOLED`.

## Environment variables

Set each in Vercel > Settings > Environment Variables, once for **Production** and once for
**Preview**, with different values. [`.env.example`](../.env.example) lists the same variables for
a local run. None is committed.

| Variable | Read by | Production | Preview |
| --- | --- | --- | --- |
| `DATABASE_URL` | the app | Neon `main`, pooled (injected by the integration) | Neon `preview`, pooled |
| `DATABASE_URL_UNPOOLED` | `db:prepare`, `db:migrate`, `db:reset` | Neon `main`, direct (injected) | Neon `preview`, direct |
| `ANTHROPIC_API_KEY` | the agent | key from `harbor-point-production` | key from `harbor-point-preview` |
| `ANTHROPIC_MODEL` | the agent | optional; `claude-opus-5-5` when unset | same |
| `SEED_REVIEWER_PASSWORD` | the user seed | `ops.reviewer`'s password, 12+ characters | its own value |
| `SEED_ADMIN_PASSWORD` | the user seed | `admin`'s password, 12+ characters | its own value |
| `SEED_ASSESSOR_USERNAME` | the user seed | the assessors' username | same or its own |
| `SEED_ASSESSOR_PASSWORD` | the user seed | the assessors' password, 12+ characters | its own value |
| `SEED_ASSESSOR_ROLE` | the user seed | `reviewer` (default) or `admin` | same |

The `SEED_*` values are read only when a database has no users (the first build) and by
`npm run db:seed-users`. Changing them in Vercel changes no password by itself; rotate one with
`db:seed-users` (below).

## The API keys and their caps

Anthropic has no spend limit on a single key; the **workspace** is the unit, and the Default
Workspace cannot have one. So the keys live in two dedicated workspaces:

| Workspace | Key used by | Monthly spend limit |
| --- | --- | --- |
| `harbor-point-production` | Production | **$50**: room for repeated whole-inbox runs between resets |
| `harbor-point-preview` | Preview | **$10**: enough to try a run on a branch; a preview can never spend production's budget |

Lower or raise them once `docs/results.md` records what a real 40-email run costs.

Set each in the Console: Workspaces > the workspace > Spend limits, with an email alert. When a
limit is reached Anthropic answers 400 ("usage limits") or 429 `enforced_spend_limit_reached`, and
the agent is to stop the run with the calm message from `DESIGN.md`, never retrying.

No test, `make verify` or `make check` calls the model, so CI needs no key.

## Resetting production

The admin's "Reset to 07:00", in the account menu once that screen is built, returns the ERP, the
inbox and the audit log to the Snapshot from inside the app. From a terminal, with production's
`DATABASE_URL`, `DATABASE_URL_UNPOOLED` and `SEED_*` values (from the Neon console and wherever the
passwords are kept) in a gitignored file such as `.env.production.local`:

```sh
set -a && . ./.env.production.local && set +a
npm run db:reset        # on DATABASE_URL_UNPOOLED
npm run db:seed-users   # on DATABASE_URL
```

`db:reset` empties every app table and reloads the Snapshot in one transaction. That includes
the users and their sessions, which is why `db:seed-users` follows it straight away: until it
runs, nobody can sign in.

The same two commands reset the shared preview database with the Preview values. To start a database from nothing instead (drop and recreate the Neon branch), redeploy: the
build migrates and seeds the empty database.

**Rotating a password:** export the new `SEED_*` values and `DATABASE_URL`, and run
`npm run db:seed-users`; it updates existing users in place. Update the values in Vercel too, so
the next empty database is seeded with them.
