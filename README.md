# Harbor Point: agent-native order-to-cash

An AI agent that works Harbor Point Supply Co.'s order inbox inside its ERP, through tools, with the
operations team approving anything risky. Built for the AI Engineer assessment
([the brief](docs/brief/assessment.md)) on the
[data pack](data/harbor_point_data_pack/README.md) as delivered.

> **Status: scaffold.** The agent tooling is in place; the app is not built yet. The sections
> marked *to do* fill in as it is.

## Live

*To do:* the production URL, and any login.

## Run it locally

*To do*, once the stack is chosen. The contract is already fixed: `make setup` installs, `make
check` runs every test and the build ([`Makefile`](Makefile)).

## How it is deployed

Vercel, through its Git integration: a merge to `main` deploys production, and each pushed branch
gets a preview URL. Nothing is deployed by hand. The details go in `docs/deployment.md`.

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
