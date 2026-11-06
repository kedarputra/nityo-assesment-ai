# 17 — Connect Vercel, Neon and Anthropic

**What to build:** A human connects the services the repository cannot set up for itself, so the next push to `main` deploys a working desk at a live URL.

**Repo:** n/a — operational

**Blocked by:** 16 — [Deploy configuration and docs](16-deploy-configuration-and-docs.md)

**Label:** sandcastle

**Status:** ◐ ready-for-human

## Context

This is operational: dashboards and secrets outside the repository. Sandcastle holds it; a person
does it, following `docs/deployment.md` from ticket 16 and
[the research](../assets/research-vercel-neon-agent-runs.md).

## Acceptance criteria

- [ ] Vercel project created from the GitHub repository with the Git integration (production = `main`, previews on branches); Fluid compute on.
- [ ] Neon added through the Vercel marketplace; a `preview` branch created and wired to preview deployments.
- [ ] Anthropic: a dedicated workspace for production and one for previews, each with its own API key and a monthly spend limit set in the Console.
- [ ] Every env var from `docs/deployment.md` set for production and preview, including the seeded user credentials; nothing committed.
- [ ] A push to `main` deploys; the live URL serves the sign-in page; the assessor login works; `/api/health` answers 200.
- [ ] The README's "Live" section is updated with the URL and the assessor login (through a normal PR).
