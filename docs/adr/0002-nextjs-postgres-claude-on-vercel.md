# Next.js, Postgres and Claude on Vercel

The app is one TypeScript Next.js (App Router) project deployed to Vercel through its Git
integration, with Postgres (Neon, through the Vercel marketplace) as the database it controls, and
Claude through the Anthropic SDK as the model. The data pack ships SQLite, but the agent's runs
execute on serverless functions that need a networked database. The ingest loads the pack into
Postgres and casts its all-TEXT columns to real types. Keeping one language for the UI, API, agent
and tools keeps the Makefile contract to a single toolchain.

## Considered options

- **Turso (hosted SQLite).** Closest to the pack's `erp.sqlite`, but less well supported on Vercel.
- **A Python API with a separate frontend.** Two languages and two deploys, with nothing gained for
  this scope.
