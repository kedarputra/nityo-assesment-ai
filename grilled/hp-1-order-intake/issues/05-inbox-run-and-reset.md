# 05 — How a whole-inbox run is driven and how the snapshot is reset

**Type:** grilling

**Blocked by:** 04 — [Vercel and Neon limits for agent runs](04-vercel-neon-agent-run-limits.md)

**Status:** closed — resolved by Kedar Putra (recommended options, standing instruction), 2026-11-06 21:22 WIB

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

## Answer

Each decision is the recommended option, taken under the developer's standing instruction (choose
the recommendation; overrule later if needed). The facts behind them are in
[the research](../assets/research-vercel-neon-agent-runs.md).

1. **The whole-inbox run is driven by the browser.** "Run all" calls the same "run one email"
   endpoint once per unprocessed email, in `received_at` order, waiting for each before the next.
   Every call is its own function invocation with its own time budget, and progress is written to
   Postgres as it goes, so the list updates live ("Reading…" on the current row).
   - **Why not a Vercel Workflow:** it would couple the agent loop to the Workflow SDK, replay tool
     calls on retry, and add billing for nothing at 40 emails.
   - **Resumable:** if the tab closes or the network drops, "Run all" continues from the first
     unprocessed email.
   - **No parallel runs:** a second "Run all" is refused while one is going.
   - See [ADR 0003](../../../docs/adr/0003-browser-driven-inbox-run.md).
2. **A re-run of one email is safe:**
   - **One run at a time per email:** an agent run takes a row lock on its email; a second run on
     the same email is refused, and so is a second whole-inbox run.
   - **Each run is recorded:** it gets a run id, and its Proposals and audit events carry it.
   - **A re-run replaces only undecided work:** re-running an email withdraws that email's
     undecided Proposals from earlier runs (marked superseded in the audit log, never deleted). It
     never touches anything a person decided or the agent released.
   - **Never released twice:** a release is unique per Proposal and is written in the same
     transaction as its stock allocation.
3. **The reset truncates and reseeds in one transaction.** The seed is the data pack, loaded by
   the same ingest code that builds a fresh database, so the seed always matches the schema; this
   takes under a second. Neon branch tricks were rejected: they need a Neon API key in the app,
   they can't reset a root branch, and they leave backup branches behind.
   - **Who and when:** only an admin may reset. A reset is refused while an agent run holds the
     lock; the admin sees "A run is in progress. Stop it first." and can stop it.
   - **The audit log is part of the snapshot.** The reset clears it too, but first records "reset
     by <user>" as the new log's first event.
4. **Previews share one seeded database.** Every preview deploy points at a single Neon `preview`
   branch, not a branch per preview, because of the 10-branch Free limit and Vercel keeping preview
   deployments for 6 months. The preview build runs migrations and the seed. Agent runs on previews
   use a separate API key with its own small spend cap, so a preview can never spend production's
   budget.
5. **Hobby is enough.** With the browser-driven run, only one email's loop must fit in a function
   (300 s on Hobby):
   - **The route:** `maxDuration = 300`.
   - **The model-call cap:** at most 15 model calls per email (the research estimated 25–225 s for
     one email).
   - **The deadline:** the loop checks `getDeadline()` and stops cleanly with a "timed out, run it
     again" state rather than being cut off.

   A take-home demo fits Hobby's personal-use terms. Pro is the fallback if real runs prove slower.
6. **Database URLs:**
   - **The app:** `pg` with a module-scope `Pool` on the pooled `DATABASE_URL`, through
     `drizzle-orm/node-postgres` and `attachDatabasePool`. It uses no session state or named
     prepared statements, so PgBouncer's transaction mode is safe.
   - **Migrations and the reset:** `DATABASE_URL_UNPOOLED`.
   - **Spend limits:** a 400 "usage limits" or a 429 `enforced_spend_limit_reached` from Anthropic
     stops the run and shows the calm message from `DESIGN.md`. It is never retried.

**Where the controls sit** (left open by
[What the ops review UI looks like](02-review-ui-prototype.md)):
- **The admin's controls** are "Run all" and "Reset to 07:00", in the header's account menu. A
  reset asks for confirmation.
- **"Run the agent"** is a secondary button on an email that hasn't been run yet, or whose run
  failed.
- **Progress** shows in the greeting card ("Reading 12 of 40…") and as the current row's state.

Terms added to [`CONTEXT.md`](../../../CONTEXT.md): Agent run, Inbox run, Snapshot, Reset.
