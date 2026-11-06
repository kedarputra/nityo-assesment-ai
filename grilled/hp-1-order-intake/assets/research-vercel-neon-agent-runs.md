# Research: Vercel, Neon and Anthropic limits for agent runs

Answers [issue 04](../issues/04-vercel-neon-agent-run-limits.md). Researched 2026-11-06 against
first-party docs only (vercel.com, nextjs.org, workflow-sdk.dev — Vercel's own SDK docs that
vercel.com/docs links to for the Workflow API — neon.com, platform.claude.com). The Vercel pages
cited carry `last_updated` dates of 2026-08 to 2026-09. Where a page is silent or ambiguous, this
note says so instead of guessing.

The workload being sized: 40 emails in `received_at` order, each a Claude tool-use loop of about
5-15 model calls. At roughly 5-15 s per call, one email is about 25 s to 225 s and the whole inbox
about 15 to 150 minutes. Those per-call times are an assumption, not a doc fact; measure them.

## 1. Function duration on Vercel

**With Fluid compute (on by default for new projects since 2025-04-23):**

| Plan | Default | Maximum | Extended maximum |
| --- | --- | --- | --- |
| Hobby | 300 s | 300 s | none |
| Pro | 300 s | 800 s | 1800 s (beta) |
| Enterprise | 300 s | 800 s | 1800 s (beta) |

- Table and "enabled by default" date:
  https://vercel.com/docs/functions/configuring-functions/duration ,
  https://vercel.com/docs/functions/limitations#max-duration ,
  https://vercel.com/docs/fluid-compute#enabling-fluid-compute
- The 1800 s beta is Pro/Enterprise only, supported Node.js (22/24/26), Bun and Python runtimes,
  and must be set per function in code or `vercel.json`, not as a project default.
  https://vercel.com/docs/functions/configuring-functions/duration#extended-max-duration-beta
- In the App Router, set it per route with `export const maxDuration = <seconds>`.
  https://vercel.com/docs/functions/configuring-functions/duration . Next.js lists `maxDuration`
  as a route segment option for pages, layouts and route handlers, defaulting to whatever the
  platform sets: https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config .
  A server action runs inside the function of the page that defines it, so it gets that page's
  `maxDuration`. The Next.js page does not say this in so many words; the `after()` notes on
  Vercel's page point to the same `maxDuration` setting.
- Exceeding it returns 504 `FUNCTION_INVOCATION_TIMEOUT`.
  https://vercel.com/docs/functions/limitations#max-duration

**Without Fluid compute:** the current docs no longer publish a non-Fluid table. The 2025-06-25
changelog says the Fluid defaults "increased" from Hobby 60 s default / 60 s max and Pro 90 s
default to the 300 s figures above, but does not explicitly call the old values the non-Fluid
baseline. https://vercel.com/changelog/higher-defaults-and-limits-for-vercel-functions-running-fluid-compute
**Ambiguous; treat Fluid as the only supported configuration** and leave it on.

**Streaming, `waitUntil` and `after()` do not buy time:**

- "For request handlers, this includes time spent processing the request and sending the
  response, including streamed responses." https://vercel.com/docs/functions/limitations#max-duration
- `waitUntil`: "Promises passed to `waitUntil()` will have the same timeout as the function
  itself. If the function times out, the promises will be cancelled."
  https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#waituntil
- For Next.js 15.1+ Vercel recommends `after()` from `next/server` instead of `waitUntil`, and
  says to extend its time with `maxDuration`, i.e. the same budget.
  https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#usage-with-next.js
- `getDeadline()` from `@vercel/functions` returns the invocation deadline, covering request
  processing and `waitUntil` tasks, so a handler can stop cleanly before the cut.
  https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#getdeadline
- Long open connections: Vercel sends HTTP/2 PINGs while idle, but HTTP/1.1 clients and proxies
  may drop idle connections, so stream heartbeat/progress data during work.
  https://vercel.com/docs/functions/configuring-functions/duration#extended-max-duration-beta

So streaming or `after()` makes the UI responsive; it does not make a 40-email run fit in one
invocation. Even Pro's 1800 s beta ceiling sits inside the 15-150 minute estimate.

**Billing that matters on Hobby:** Hobby includes 4 Active CPU hours, 360 GB-hrs of provisioned
memory and 1M invocations a month, is for non-commercial personal use only, and pauses the feature
for up to 30 days once a limit is exceeded. https://vercel.com/docs/plans/hobby . Time spent waiting
on the model API does not count as Active CPU. https://vercel.com/docs/functions/limitations#cost-and-usage
Default function memory is 2 GB, so provisioned memory is the bigger draw for long agent runs.
https://vercel.com/docs/functions/limitations#memory-size-limits

## 2. Built-in options for a long sequential job

Vercel's own comparison guide: https://vercel.com/kb/guide/background-workers-on-vercel ; overview
at https://vercel.com/docs/background-workers .

| Option | Status | Fits "40 emails in order"? | Why |
| --- | --- | --- | --- |
| `waitUntil` / `after()` | GA | No | Same `maxDuration` as the request (see 1). |
| Cron Jobs | GA, now "legacy", moving to Schedules | No | Each run must finish within the function's max duration; Hobby crons run at most once a day with ±59 min precision. https://vercel.com/docs/schedules/cron-jobs/usage-and-pricing |
| Queues | Public beta, all plans | Per email yes, in order **no** | "No FIFO guarantee. Even with a single consumer and max concurrency set to 1, message order is not strictly first-in-first-out." Retried messages drop behind new ones. Delivery is at-least-once, so consumers must be idempotent. https://vercel.com/docs/queues/concepts#ordering , https://vercel.com/docs/queues |
| **Workflows** (Workflow SDK) | GA (since April 2026 per the KB guide) | **Yes** | Durable `'use workflow'` function calling `'use step'` functions; awaiting steps one after another in a `for` loop gives strict order. No run-duration limit; each step is bounded by the function max duration. https://vercel.com/docs/workflows , https://vercel.com/docs/workflows/concepts |
| Daemons | Public beta, production only | Yes, but heavy | Always-on container worker; Hobby gets 5 Active CPU-hrs and 420 GB-hrs/month across all projects and stops all daemons when either runs out. https://vercel.com/kb/guide/background-workers-on-vercel |
| Sandbox | GA | Possible, wrong tool | Built for untrusted code; Hobby sessions cap at 45 min. Same guide. |

**Workflows in detail**, since it is the one that fits without outside infrastructure:

- Limits: run duration and `sleep` unlimited; 10,000 steps and 25,000 events per run; 50 MB max
  step input/output; "max runtime of individual step: see Vercel Functions limits" (so 300 s on
  Hobby, up to 800 s on Pro). Workflow replay must finish within 240 s.
  https://vercel.com/docs/workflows/pricing#workflow-run-limits
- Pricing: Hobby includes 50,000 Workflow Events and 1 GB Data Written a month; on-demand is
  $0.02 per 1K events. A normal step costs 3 events (`step_created`, `step_started`,
  `step_completed`), plus 1 per retry. Steps also bill as normal function compute and Queues
  operations. https://vercel.com/docs/workflows/pricing . One step per email is about 120 events
  per inbox run; one step per model call (40 x 15) is about 1,800, i.e. ~27 whole-inbox runs on
  the Hobby allowance (arithmetic, not a doc figure).
- Retries: a step retries up to 3 times by default (`fn.maxRetries = n` to change, throw
  `FatalError` to stop). https://workflow-sdk.dev/docs/foundations/errors-and-retries . **A retried
  agent step re-runs its tool calls**, so ERP writes inside a step must be idempotent or the step
  set to `maxRetries = 0`.
- Starting and observing: `start(workflow, [args])` from `workflow/api` in a route handler or
  server action returns a `Run` immediately with `runId`; `getRun(runId)` later gives `status`
  (`running` / `completed` / `failed`) and `returnValue`; steps can write progress to
  `getWritable()` and a route can return `run.readable` as a stream.
  https://workflow-sdk.dev/docs/foundations/starting-workflows
- Next.js setup: `npm i workflow`, wrap `next.config.ts` with `withWorkflow()` from
  `workflow/next`; "work best when deployed to Vercel and need no special configuration".
  https://workflow-sdk.dev/docs/getting-started/next
- Hobby run-data retention is 1 day after the run finishes (Pro 7 days), so the app's own run log
  in Postgres must be the record, not the Workflows dashboard.
  https://vercel.com/docs/workflows/retention
- Runs stay pinned to the deployment that started them, including across a rollback; cancel
  stale runs from Observability or the CLI. https://vercel.com/docs/workflows/concepts#skew-protection
- Local dev and `make check`: workflows run under `next dev` and can be inspected with
  `npx workflow web`; the docs do not describe how to unit-test a workflow without the runtime,
  so tests should target the step functions directly. (Inference; the docs are silent.)

## 3. Neon through the Vercel Marketplace

**Driver.** Both vendors now recommend plain TCP `pg` with a pool on Fluid compute, not the HTTP
serverless driver:

- Neon: on Vercel Fluid, "a standard Postgres TCP driver (like node-postgres) with a connection
  pool is recommended"; Fluid "keeps functions warm long enough to reuse TCP connections".
  https://neon.com/docs/connect/choose-connection , https://neon.com/docs/guides/vercel-connection-methods
- Neon's Drizzle example on that page:
  `drizzle-orm/node-postgres` + `new Pool({ connectionString: process.env.DATABASE_URL })` +
  `attachDatabasePool(pool)` from `@vercel/functions`, with the pool at module scope.
  https://neon.com/docs/guides/vercel-connection-methods
- Vercel: call `attachDatabasePool` right after creating the pool so idle clients are released
  before the function suspends. https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#attachdatabasepool
- `@neondatabase/serverless` remains the choice where TCP pooling is not possible (classic
  serverless, edge, Cloudflare/Netlify). Its HTTP mode supports only non-interactive transactions
  (`sql.transaction([...])`); interactive transactions need its WebSocket `Pool`/`Client`, created
  and closed inside one request. https://neon.com/docs/serverless/serverless-driver
- Which URL: the integration injects `DATABASE_URL` (pooled, PgBouncer) and
  `DATABASE_URL_UNPOOLED` (direct). https://neon.com/docs/guides/vercel-managed-integration .
  Neon's Vercel page uses `DATABASE_URL` in the example but does not say pooled vs unpooled for
  the `pg` pool. **Ambiguous**; migrations and anything needing session state conventionally use
  the unpooled URL.

**Free plan** (the plan the marketplace integration provisions; billing goes through Vercel):
https://neon.com/docs/introduction/plans

| Item | Free |
| --- | --- |
| Projects | 100 |
| Branches | 10 per project, root included |
| Storage | 1 GB per project, 20 GB across the account |
| Compute | 100 CU-hours per project per month, autoscaling up to 2 CU |
| Scale to zero | after 5 min idle, cannot be disabled; wakes "within a few hundred milliseconds" (https://neon.com/docs/introduction/scale-to-zero) |
| History window (instant restore) | up to 6 hours, capped at 1 GB of change history |
| Snapshots | 1 manual snapshot |
| Egress | 5 GB per project per month |

Launch (paid) is usage-based with no monthly minimum: $0.106/CU-hour, $0.35/GB-month, 7-day
history, 100 snapshots. Same page.

**Preview branches: yes, automatically, if enabled.** In the Vercel-managed integration, ticking
**Preview** under "Create database branch for deployment" creates a copy-on-write branch
`preview/<git-branch>` for each preview deployment and injects its connection variables for that
deployment only; migrations can run in the Vercel build command. Branches are deleted when the
deployment is removed, but Vercel keeps preview deployments 6 months by default, so they can pile
up against the 10-branch Free limit. https://neon.com/docs/guides/vercel-managed-integration .
Neon's docs page now titles the product "Lakebase Postgres"; the integration and env vars are
unchanged.

## 4. Resetting to the seeded 07:00 snapshot

| Method | How | Speed (per docs) | Free-plan catch |
| --- | --- | --- | --- |
| **Reset from parent** | App runs on a *child* branch whose parent is a seeded branch. `POST /api/v2/projects/{project}/branches/{child}/restore` with `{"source_branch_id": "<parent>"}`, or `neon branches reset <child> --parent`. | "instant"; connections briefly drop and reconnect, connection string unchanged | Root branches cannot be reset. Blocked if the child has children. Leaves **no backup branch**. https://neon.com/docs/guides/reset-from-parent |
| Instant restore (PITR) of a root branch | Restore the root to its own history at a timestamp, or to another root branch's head. | "a few seconds", connection string unchanged | Free history is 6 h, so restoring "to the seed time" stops working after 6 h. Every restore leaves a backup branch that counts toward the 10-branch limit, and a backup made by restoring a root **from another branch cannot be deleted**. https://neon.com/docs/introduction/branch-restore |
| Snapshot restore | Take the single Free manual snapshot of the seeded root; one-step restore back into the branch. `POST /projects/{p}/snapshots/{s}/restore`. | "instant"; branch name and connection string kept, branch ID changes | Keeps the old branch as `<name> (old)`, another branch to clean up; PITR is unavailable on the restored branch while the restore is "ongoing". https://neon.com/docs/guides/backup-restore |
| Truncate and reseed | A server action runs `TRUNCATE ... RESTART IDENTITY CASCADE` and re-inserts the seed in one transaction. | Not documented; the whole data pack is ~250 KB on disk (40 emails, a 40 KB SQLite ERP), so this is a sub-second job plus a cold start (estimate, not a doc fact) | None from Neon. The seed must be kept in the app (or a seed table) and kept in step with the schema. |

Two practical points the docs raise but do not settle:

- **Pointing production at a child branch.** Any branch can be made the project default
  (`POST /projects/{p}/branches/{b}/set_as_default`, https://neon.com/docs/manage/branches), but
  the integration's `DATABASE_URL` names a specific compute endpoint. The integration page does
  not say whether its managed env vars follow a default-branch change or can be overridden, so
  the reset-from-parent design needs that checked by hand before it is chosen.
- **Calling the Neon API from the app** needs a Neon API key in Vercel env; the Vercel-managed
  integration supports API-key auth (`neon login` does not work there).
  https://neon.com/docs/guides/vercel-managed-integration
- Schema migrations must be applied to the seed parent too, or a reset brings back the old schema.

## 5. Capping Anthropic spend

- **Organization cap.** Each tier has a monthly cap: Start $500, Build $1,000, Scale $200,000.
  You can set your own lower limit on Console > Billing > Spend limits. Hitting a limit *you set*
  returns HTTP 400 `invalid_request_error` ("You have reached your specified API usage limits");
  hitting the *tier* cap returns 429 with `error_code: enforced_spend_limit_reached` and no
  `retry-after`, and SDK retries keep failing until 00:00 UTC on the 1st.
  https://platform.claude.com/docs/en/api/rate-limits#spend-limits
- **Workspace cap (the per-key control).** Create a workspace for the deploy, issue the app's API
  key in it, then Console > Workspaces > select it > **Spend limits** to set a monthly cap and
  email alerts. Limits can only be lower than the org's, and **the Default Workspace cannot have
  a spend limit**, so the key must not live there. Over the limit, requests fail with "You have
  reached your specified workspace API usage limits".
  https://platform.claude.com/docs/en/manage-claude/workspaces#workspace-limits ,
  https://platform.claude.com/docs/en/api/rate-limits#setting-lower-limits-for-workspaces
- There is no spend limit on an individual API key; the workspace is the unit.
  (Same pages; inferred from their silence on per-key limits.)
- Workspace rate limits (RPM/ITPM/OTPM per model) are set separately on Console > Rate limits.
  For scale: Start-tier Sonnet 5.5 is 4,000 RPM / 2M ITPM / 400K OTPM, and cache reads do not
  count toward ITPM, so a sequential 40-email run is nowhere near rate limits.
  https://platform.claude.com/docs/en/api/rate-limits#rate-limits
- The Spend Limits API is for Claude Enterprise member limits only: "It is not available to Claude
  Platform (Claude Console) organizations." Set the workspace cap by hand in the Console.
  https://platform.claude.com/docs/en/manage-claude/spend-limits-api
- The agent should treat both the 400 workspace-limit error and the 429
  `enforced_spend_limit_reached` as "stop the run, report it", not retry.

## Implications for orchestration

These are options for the developer to choose between, not a decision.

**Whole-inbox run**

1. **Vercel Workflow, one step per email.** A `'use workflow'` function loops over the 40 emails in
   `received_at` order and awaits a `'use step'` that runs one email's whole agent loop; the UI
   polls `getRun(runId)` or the app's own run table. *Trade-off:* strict order, survives tab close
   and redeploys, no outside infrastructure, ~120 events per run. But one email's loop must finish
   inside one function budget (300 s on Hobby; the 225 s worst case is tight), and a retried step
   replays that email's tool calls, so ERP writes must be idempotent or retries off. Adds the
   `workflow` package and its compiler to the build.
2. **Vercel Workflow, one step per model call or tool call.** Same as 1 but the agent loop itself
   lives in the workflow function, each Claude call and each ERP tool call a step. *Trade-off:*
   no per-email timeout risk at all and finer retries, but ~1,800 events per inbox run (~27 runs
   on Hobby's free allowance), the loop must be deterministic for replay, and it couples the
   agent code to the Workflow SDK, which makes the "model behind a fake" tests harder.
3. **Browser-driven sequence.** The "run all" button calls the existing "run one email" route 40
   times, awaiting each before the next; each call is its own invocation with a fresh 300-800 s
   budget, and progress lands in Postgres. *Trade-off:* simplest, nothing new to learn, no
   Workflow billing, trivially testable. But the run stops if the tab closes or the network
   drops, so the run table must make it resumable ("continue from the first unprocessed email"),
   and a second tab could start a parallel run unless the server takes a lock.

**Reset to the 07:00 snapshot**

1. **Truncate and reseed in one transaction**, from a server action. *Trade-off:* works on any
   branch including previews, no Neon API key, no branch limits, fast at this data size; the seed
   lives in code and must be maintained with the schema.
2. **Neon reset from parent**: keep a seeded parent branch and run production on a child.
   *Trade-off:* exact byte-for-byte snapshot, "instant", no backup-branch litter; but needs a Neon
   API key in the app, needs production's `DATABASE_URL` to point at the child (unverified with
   the Vercel-managed integration), migrations must hit the parent too, and it does not work for
   preview branches that have no seeded parent of their own.
3. **Neon snapshot restore**: the one Free manual snapshot taken right after seeding.
   *Trade-off:* also "instant" and keeps the connection string, but each restore leaves an
   `(old)` branch to delete against the 10-branch cap, the one Free snapshot must be retaken after
   every schema change, and it too needs the Neon API key.
