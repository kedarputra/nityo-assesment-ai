# An Outlook- and Teams-style desk, with triage the people own

The developer asked for the desk to work like Outlook and Teams (2026-11-11): a sidebar with
menus and sub-menus, a message list with checkboxes, sorting, filtering, grouping and paging,
labels, flags and statuses a person can change, an Outlook-style reply composer with drafts,
global and in-folder search (keyword and by meaning), a Teams-style presence dot for the agent,
a live box for the emails being read, and the agent triggered by hand or every few minutes.

## Decisions

- **Two kinds of status, kept apart.** The agent's outcome (released, needs you, routed, no
  action, reading, didn't finish) still comes from its runs and the release gate, and no person
  edits it. A person's **triage** sits beside it: a status (New, In progress, Waiting on customer,
  Done), a flag (none, Follow up, Complete) and labels. A person can change all three, one email
  at a time or many at once.
- **Needs review is a red flag set by the system.** An email waiting on a person shows a red flag
  icon that no one can clear except by deciding the Proposal. A person's own follow-up flag is
  amber. The two never share a colour.
- **No bulk approve.** Select-all applies labels, flags, statuses and "Run the agent". Approving
  stays one Proposal at a time, as the review UI decision settled: a release spends stock and
  credit, and each one needs its checks read.
- **Replies are composed like Outlook, and still never sent.** To, subject and body, prefilled
  from the agent's draft; "Save draft" and "Approve for sending". An approved reply is logged as
  "would send", as before. The inbox is a fixture of `.example` addresses.
- **Search.** Keyword search matches every word against the sender, subject, body and customer.
  Search by meaning embeds the emails with Gemini's embedding model and ranks them by cosine
  similarity. It falls back to keywords, and says so, when no key or quota is available. Global
  search covers emails, customers, products and sales orders; the folder's own box searches
  only the list on screen.
- **Triggers.** A reviewer runs the agent on one email or on selected emails; an admin runs all.
  An admin can switch on an automatic run every 5 to 60 minutes. A scheduled GitHub Actions
  workflow calls `/api/agent/tick` every 5 minutes with `CRON_SECRET`. The route starts a
  background Run all (ADR 0004) when the schedule is on, its interval has passed, nothing is
  running and an email is waiting. Vercel Hobby crons run once a day, too seldom for this.
- **Live state is shown as objects, not sentences.** The agent's presence is a dot with a word,
  as in Teams: Active, Idle, Paused or Off. The emails being read sit in one box that refreshes
  every few seconds.
