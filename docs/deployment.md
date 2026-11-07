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

The tests do not run in Vercel's build. GitHub Actions runs `make check` on every pull request and
every push to `main` ([`.github/workflows/check.yml`](../.github/workflows/check.yml)); require
its `check` job in `main`'s branch protection so a red PR cannot merge, and so cannot deploy.

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

### The app's database role

The audit log is append-only in the database (security 6). Migration
[`0009_app_role.sql`](../drizzle/0009_app_role.sql) creates `harbor_point_app`, a role without a
login that may read and write every table but may only INSERT and SELECT on `audit_events`. The
app must connect as a login that is a member of it, not as the owner the integration injects:

1. In the Neon SQL editor on each branch (`main`, then `preview`), as the owner, create the login
   **in SQL**. A role made in the Neon console joins `neon_superuser`, which can write every
   table, and would undo the point.

   ```sql
   CREATE ROLE harbor_point_web LOGIN PASSWORD '<a generated password>' IN ROLE harbor_point_app;
   ```

2. Set `DATABASE_URL` (pooled) for that environment to the same connection string with
   `harbor_point_web` and its password in place of the owner's.

`DATABASE_URL_UNPOOLED` stays the owner's: the migrations, the seeds and the Reset run as the
owner, which is why the Reset can truncate the audit log and the app cannot. The in-app Reset must
use that URL too.

## Environment variables

Set each in Vercel > Settings > Environment Variables, once for **Production** and once for
**Preview**, with different values. [`.env.example`](../.env.example) lists the same variables for
a local run. None is committed.

| Variable | Read by | Production | Preview |
| --- | --- | --- | --- |
| `DATABASE_URL` | the app | Neon `main`, pooled, as `harbor_point_web` (above) | Neon `preview`, pooled, as `harbor_point_web` |
| `DATABASE_URL_UNPOOLED` | `db:prepare`, `db:migrate`, `db:reset`, the in-app Reset | Neon `main`, direct (injected) | Neon `preview`, direct |
| `ANTHROPIC_API_KEY` | the agent | key from `harbor-point-production`, or unset (below) | key from `harbor-point-preview`, or unset |
| `ANTHROPIC_MODEL` | the agent | optional; `claude-opus-5-5` when unset | same |
| `GEMINI_API_KEY` | the agent, when `ANTHROPIC_API_KEY` is unset | free key from Google AI Studio, or unset | same, or unset |
| `GEMINI_MODEL` | the agent | optional; `gemini-3.8-flash` when unset | same |
| `GEMINI_REASONING_EFFORT` | the agent | optional; `low` when unset | same |
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

**The agent for free: Gemini.** With `ANTHROPIC_API_KEY` unset and `GEMINI_API_KEY` set, the
agent runs on Gemini's free tier through its OpenAI-compatible endpoint
([`src/model/openai-compatible-model.ts`](../src/model/openai-compatible-model.ts)). Create the key
at aistudio.google.com/apikey (no card), add it in Vercel → Settings → Environment Variables for
Production, and redeploy. The free tier is rate-limited: a per-minute limit is waited out and
retried (up to three times, 30 s at most each); a per-day limit stops the run with the spend-limit
message until the quota resets at midnight Pacific. Free-tier prompts may be used by Google to
improve its products; the data pack is fictional. Anthropic wins when both keys are set. Gemini 3
thinks at length by default: on the first production run one tool call took three to five minutes,
so the adapter asks for `reasoning_effort: low` and gives each call 90 s before it fails it.

**Without a key the agent is off, and nothing else changes.** Leave both keys unset (or
empty) in an environment and that deploy serves the full desk (sign-in, the inbox, review, the
audit log) with the agent switched off: the Proposal pane says so in place of "Run the agent", and
the run action refuses before it writes anything, so no failed Agent runs pile up and nothing is
spent. Setting the key and redeploying turns the agent on
([`src/model/agent-switch.ts`](../src/model/agent-switch.ts)).

## Resetting production

The admin's "Reset to 07:00", in the header's account menu, returns the ERP, the inbox and the
audit log to the Snapshot from inside the app, on `DATABASE_URL_UNPOOLED`. It keeps the users,
their sessions and the rate-limit counts, so everyone stays signed in, and the new audit log starts
with "reset by <user>". It is refused while a run holds the lock ("A run is in progress. Stop it
first."), and an admin may reset 3 times an hour. From a terminal, with production's
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

The same two commands reset the shared preview database with the Preview values. To start a
database from nothing instead (drop and recreate the Neon branch), redeploy: the build migrates
and seeds the empty database.

**Rotating a password:** export the new `SEED_*` values and `DATABASE_URL`, and run
`npm run db:seed-users`; it updates existing users in place. Update the values in Vercel too, so
the next empty database is seeded with them.
