# 04 — Vercel and Neon limits for agent runs

**Type:** research

**Blocked by:** none

**Status:** open — research subagent dispatched, 2026-11-06 19:56 WIB

## Question

Under which platform limits will the agent run on the live deploy? The decision it feeds is how a
whole-inbox run (40 emails processed in `received_at` order, each a multi-step Claude tool-use loop)
is orchestrated from the UI, and how the 07:00 snapshot is reset. See
[the charting decisions](01-charting-decisions.md#how-the-agent-runs-live).

Find, from Vercel's, Neon's and Anthropic's own docs:

1. The maximum function duration for a Next.js route or server action on Vercel today (Hobby vs Pro,
   with and without Fluid compute), and whether streaming or `waitUntil`/`after` extends useful work
   past the response.
2. Vercel's built-in options for running a long sequential job (Queues, Workflow, cron, background
   functions), and whether one fits "process 40 emails in order" without outside infrastructure.
3. Neon through the Vercel marketplace: the connection driver to use from serverless functions
   (`@neondatabase/serverless` vs pooled `pg`), the free tier's limits, and whether preview deploys
   can get their own database branch automatically.
4. The cheapest correct way to reset the database to a seeded snapshot (a Neon branch reset vs
   truncate and reseed) and how long each takes.
5. How to cap spend on an Anthropic API key (workspace spend limits).
