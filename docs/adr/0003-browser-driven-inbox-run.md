# The browser drives a whole-inbox run, one email per request

A run over the whole inbox (40 emails in `received_at` order, each a multi-step Claude tool-use
loop) cannot fit in one Vercel function invocation: Hobby allows 300 s, and the whole inbox is
estimated at 15 to 150 minutes. We drive it from the browser instead. "Run all" calls the "run one
email" endpoint once per unprocessed email, in order, and progress is written to Postgres, so a
closed tab resumes from the first unprocessed email. A lock allows one run per email and one inbox
run at a time.

## Considered options

- **A Vercel Workflow with one step per email.** It survives a closed tab. But a retried step
  replays the email's tool calls, the agent code would couple to the Workflow SDK (harder to test
  behind the fake model), and it adds a dependency and billing for a 40-email demo.
- **A Workflow with one step per model call.** No timeout risk at all, but about 1,800 events per
  run and a deterministic-replay constraint on the agent loop.

## Consequences

If the inbox grows past what a person will leave a tab open for, move to the Workflow option. The
"run one email" endpoint stays the same, because the Workflow step would call the same code.
