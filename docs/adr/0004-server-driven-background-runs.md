# The server drives agent runs in the background

Supersedes [ADR 0003](0003-browser-driven-inbox-run.md).

ADR 0003 had the browser drive Run all, one request per email. In production that coupled every
run to a tab. Moving to another page, reloading, or closing the tab stopped Run all. A single "Run
the agent" also held the person's request open for the whole run, up to a minute or more on a
slow model. One run (E002) was cut off with its function and then showed "Reading…" for ever.

Now the server drives both:

- **"Run the agent"** records the run while the person waits, so the email shows as being read at
  once. The model's tool-use loop then goes on after the response (Next.js `after`), inside the
  same function and its 300 s.
- **Run all** starts an Inbox run and stores a random secret for it, kept only as a SHA-256 hash,
  together with the address the admin used. Each step reads one email in its own function, then
  posts the secret to `/api/inbox-run/step` at that address. That route checks the secret,
  answers 202 at once, and reads the next email after answering. Each email therefore gets a full
  function budget. The chain ends when no email is left, on Stop, or on a spend limit.
- **The desk refreshes** every few seconds while any email is being read or Run all is going.
  It shows progress from the database, not from the browser.
- **A run cut off with its function** (unfinished six minutes after it started) shows as "Didn't
  finish", and it can be run again. If a step's function is cut off, the chain stops, and pressing
  Run all again carries on from the first email left.

## Considered options

- **Keep the browser loop** and make it survive navigation inside the app. A reload or a closed
  tab would still stop it, and that is exactly what an assessor will do.
- **A Vercel Workflow.** It is durable, but brings the costs ADR 0003 listed: a new SDK in the agent
  loop, replay semantics, and billing for a 40-email demo. The self-chaining route reuses the same
  "run one email" code and needs no new service.
- **A queue or cron.** Hobby cron runs once a day, and an external queue is a new service to run.

## Consequences

- The step route is open without a session. Its secret is the check: 256 random bits, compared in
  constant time. The gate still refuses a cross-site post to it.
- Run all's emails no longer count against a person's hourly agent-run limit, which 40 emails
  would pass. Run all is an admin's, and bounded by the day's inbox.
- A run's margin before the function's deadline is 100 s, more than one model call's 90 s
  timeout, so a run ends cleanly instead of being cut off mid-call.
