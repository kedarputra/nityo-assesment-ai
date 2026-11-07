# Harbor Point: agent-native order-to-cash

An AI agent that works Harbor Point Supply Co.'s order inbox inside its ERP, through tools, with the
operations team approving anything risky. Built for the AI Engineer assessment
([the brief](docs/brief/assessment.md)) on the
[data pack](data/harbor_point_data_pack/README.md) as delivered.

> **Status:** every ticket under `grilled/hp-1-order-intake/tickets/` is built and merged. The agent
> runs when a model key is set (Anthropic, or Gemini's free tier; see
> [`docs/deployment.md`](docs/deployment.md)); without one, the desk works with the agent switched off.

## Live

- **URL:** https://nityo-assesment-ai.vercel.app (production, deployed by Vercel on every push to `main`).
- **Assessor login:** username `assessor`; the password is sent separately, never committed.

## Run it locally

From a clone to a working desk with the seeded logins. You need **Node 22** (`.nvmrc`) and a
**Postgres** (16 or later). The app has no in-process database mode: PGlite, the in-process
Postgres, runs only the tests, which need no server at all (`make check`).

1. **Install:** `make setup`.
2. **Start a Postgres**, for example in Docker:

   ```sh
   docker run -d --name harbor-point-db -p 5432:5432 \
     -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=harbor_point postgres:17
   ```

3. **Configure:** `cp .env.example .env.local`, then set
   `DATABASE_URL=postgres://postgres:postgres@localhost:5432/harbor_point`, the three passwords
   (`SEED_REVIEWER_PASSWORD`, `SEED_ADMIN_PASSWORD`, `SEED_ASSESSOR_PASSWORD`, 12 characters or
   more) and `SEED_ASSESSOR_USERNAME`. Leave `DATABASE_URL_UNPOOLED` empty: a local Postgres has
   no pooler. `ANTHROPIC_API_KEY`, or the free `GEMINI_API_KEY`, is needed only to run the agent.
4. **Migrate and seed**, exactly as a deploy does: `set -a && . ./.env.local && set +a`, then
   `npm run db:prepare`. It loads the Snapshot (the data pack at 07:00) and the logins into the
   empty database; run again, it only migrates.
5. **Run:** `npm run dev` and open <http://localhost:3000>. Sign in as `ops.reviewer` (reviewer),
   `admin` (admin) or your assessor username, with the passwords from step 3.

Back to the Snapshot at any time: `npm run db:reset`, then `npm run db:seed-users` (the reset
empties the users too). The checks: `make check` runs lint, the type check, every test, the build
and `npm audit` ([`Makefile`](Makefile)).

## How it is deployed

Vercel, through its Git integration: a merge to `main` deploys production, and each pushed branch
gets a preview URL. Nothing is deployed by hand. Every build migrates its database over Neon's
direct URL and seeds it only if it is empty, so a deploy never overwrites the data; production uses
the Neon `main` branch and every preview shares one `preview` branch, each with its own capped
Anthropic API key. The Vercel project, the databases, every env var, the key caps and how to reset
production: [`docs/deployment.md`](docs/deployment.md).

## Repository layout

| Path | What it is |
| --- | --- |
| `data/harbor_point_data_pack/` | the data pack, unchanged: ERP snapshot (SQLite and CSV), 40 emails, business rules |
| `docs/brief/` | the assessment brief |
| `docs/agents/` | how agents use the tracker, the labels and the domain docs |
| `grilled/` | the maps, decision tickets and implementation tickets: the task breakdown |
| `.sandcastle/` | the runner that implements `sandcastle`-labelled tickets in Docker sandboxes |
| `.agents/skills/`, `.claude/skills/` | the agent skills (`/wayfinder`, `/to-tickets`, `/grill-with-docs`, …) |
| `AGENTS.md`, `CLAUDE.md` | the operating doc every agent reads |

## Building with sandcastle

### Once per machine

1. **Node 22** (`.nvmrc`), **pnpm**, and **Docker Desktop**.
2. Install the tooling: `npm install`.
3. Give the sandboxes a Claude login. Copy [`.sandcastle/.env.example`](.sandcastle/.env.example) to
   `.sandcastle/.env` and set `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`). The file is
   gitignored.
4. Build the sandbox image: `npm run sandcastle:build-image`. Build it again after a change to
   [`.sandcastle/Dockerfile`](.sandcastle/Dockerfile).
5. Give the repo a remote, and push `main`. The runner cuts each effort's branch from
   `origin/main` and pushes its work there, so it needs `origin`.

### Once per effort

1. **Chart it.** `/wayfinder` (or `/grill-with-docs`) writes the map and the decision tickets under
   `grilled/hp-<n>-<slug>/`.
2. **Slice it.** `/to-tickets` writes the implementation tickets under `grilled/hp-<n>-<slug>/tickets/`,
   each labelled `sandcastle`. Only you can invoke these two skills.
3. **Commit the tickets on the effort's branch**, `feat/hp-<n>-<slug>`. The runner reads the tickets
   from the checkout and closes each one there.
4. **Look first:** `npm run sandcastle:dry-run -- --map hp-<n>-<slug>`.
5. **Run:** `npm run sandcastle -- --map hp-<n>-<slug> [--parallel 2] [--rounds 1]`.
6. Open a PR from `feat/hp-<n>-<slug>` to `main`.

**The first effort sets the checks up.** `make verify` and `make check` pass with a warning until a
ticket fills them in, so its first ticket must, and no other ticket should merge before it.

How a run works, how it resumes, and what it pushes: [`.sandcastle/README.md`](.sandcastle/README.md).
Clean up after runs: `npm run sandcastle:clean`.
