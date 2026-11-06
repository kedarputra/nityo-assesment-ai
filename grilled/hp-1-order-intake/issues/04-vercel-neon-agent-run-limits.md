# 04 — Vercel and Neon limits for agent runs

**Type:** research

**Blocked by:** none

**Status:** closed — resolved by a research subagent, 2026-11-06 20:04 WIB

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

## Answer

Findings, each fact with its first-party URL:
[`research-vercel-neon-agent-runs.md`](../assets/research-vercel-neon-agent-runs.md).

1. **Duration.** With Fluid compute (the default), a function gets 300 s on Hobby; on Pro, 800 s,
   or 1800 s in beta. Streaming, `waitUntil` and `after()` share that budget and buy no extra time.
   A whole-inbox run (an estimated 15–150 min) cannot fit in one invocation; one email (an estimated
   25–225 s) fits, tightly on Hobby.
2. **Sequential jobs.** Vercel Workflows (GA) is the only built-in option that keeps strict order
   with no outside infrastructure. Queues have no FIFO guarantee, and cron is bound by the same
   duration. A Workflow step retries 3 times by default, so ERP writes inside a step must be
   idempotent, or retries turned off. Hobby keeps run data for 1 day, so the app's own run log in
   Postgres is the record.
3. **Neon.** Use `pg` with a module-scope `Pool`, through `drizzle-orm/node-postgres` and
   `attachDatabasePool`, not `@neondatabase/serverless`. The Free plan gives 10 branches, 1 GB and
   100 CU-hours, and scales to zero after 5 min. The integration can create a `preview/<branch>`
   database branch for each preview deploy, if opted in; those count against the 10-branch limit.
4. **Reset.** Truncate and reseed (sub-second at this size, works on any branch, no Neon API key);
   Neon reset from parent ("instant", but production must run on a child branch, which is
   unverified with the integration); or snapshot restore ("instant", but each restore leaves an
   `(old)` branch to clean up).
5. **Spend cap.** Put the app's key in a non-default Anthropic workspace and set that workspace's
   monthly spend limit by hand in the Console; there is no limit on an individual key. Treat a
   400 "usage limits" response or a 429 `enforced_spend_limit_reached` as "stop the run", never
   retry.

Left open for the decision ticket: whether `pg` should use the pooled `DATABASE_URL` or
`DATABASE_URL_UNPOOLED`, and whether the integration lets production point at a child branch.
Feeds [How a whole-inbox run is driven and how the snapshot is reset](05-inbox-run-and-reset.md).
