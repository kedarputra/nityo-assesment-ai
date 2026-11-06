# 05 — How a whole-inbox run is driven and how the snapshot is reset

**Type:** grilling

**Blocked by:** 04 — [Vercel and Neon limits for agent runs](04-vercel-neon-agent-run-limits.md)

**Status:** open

## Question

The UI runs the agent on one email or on all 40 in `received_at` order, and an admin resets the ERP
to the 07:00 snapshot ([how the agent runs live](01-charting-decisions.md#how-the-agent-runs-live)).
Under the limits in [the research](../assets/research-vercel-neon-agent-runs.md), how is each done?

1. **The whole-inbox run.** Three options:
   - a Vercel Workflow with one step per email;
   - a Workflow with one step per model call or tool call;
   - the browser calling "run one email" 40 times, resumable from the first unprocessed email,
     with a server-side lock.

   One email's loop must fit in a single function budget (300 s on Hobby). A retried Workflow step
   replays its tool calls.
2. **Idempotency.** Whichever option is picked, what makes a re-run of one email safe? For example,
   one agent run per email at a time, Proposals keyed by email and run, and released orders never
   created twice.
3. **The reset.** Truncate and reseed in one transaction, Neon reset from parent, or Neon snapshot
   restore. What happens to a run in flight when someone resets?
4. **Preview deploys.** Does each preview get its own seeded database branch, given the 10-branch
   Free limit and preview deploys being kept 6 months? If not, which database do previews use?
5. **The Vercel plan.** Is Hobby (300 s, non-commercial use only) enough, or does any option above
   need Pro?
6. **The connection URL.** Pooled `DATABASE_URL` or `DATABASE_URL_UNPOOLED` for the app's `pg` pool,
   and which one migrations use.
