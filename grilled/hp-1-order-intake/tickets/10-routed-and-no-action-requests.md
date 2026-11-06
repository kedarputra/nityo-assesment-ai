# 10 — Requests that are routed or need no action

**What to build:** Emails that aren't orders the ERP can act on reach the right place: quotes, returns, billing disputes, inquiries, prospects and orders without quantities are routed to a person with a summary and a Draft reply; spam, auto-replies and duplicates are closed with their reason.

**Repo:** harbor-point

**Blocked by:** 06 — [Tracer: run the agent on one email, and a clean order releases](06-tracer-run-the-agent-on-e001.md)

**Label:** sandcastle

**Status:** closed — resolved 2026-11-06 23:33 WIB by sandcastle

## Context

The map is [`map.md`](../map.md); words are defined in [`CONTEXT.md`](../../../CONTEXT.md); every screen follows [`DESIGN.md`](../../../DESIGN.md), whose living example is Variant A of [the prototype](../assets/prototype-review-ui.html). The business rules are in the [data pack README](../../../data/harbor_point_data_pack/README.md); the data pack is read-only.

- [Charting, requests that are not new orders](../issues/01-charting-decisions.md#requests-that-are-not-new-orders);
  Request kinds in `CONTEXT.md`.
- [Ticket 10](../issues/10-replies-when-we-cannot-do-it.md#answer): U3 (no quantities: routed with a
  clarifying reply, never invented quantities), U12 (an inquiry about an order we cannot find: an
  honest reply asking for a date or PO, mentioning the hold), U13 (no reply for a duplicate).
- [Ticket 08](../issues/08-emails-that-belong-together.md#answer): U8 (a duplicate is every line
  identical on the same day, or the same customer PO), U17 (an auto-reply's information is attached
  to the sender's open Requests).
- Policy 5: an unknown company is routed as a prospect.
- Expected ([the walkthrough](../assets/per-email-expected-outcomes.md)): routed E009 (quote), E014
  (prospect), E018 (return), E022 (no quantities), E023 (missing attachment), E030 (billing dispute);
  E027 carries a routed inquiry beside its hard-rule Proposal; no action E016 (duplicate of E015's
  PO SSL-7781), E028 (auto-reply, its note attached to E033 and E017), E029 (spam).

## Acceptance criteria

- [ ] Every Agent run records the Request kind(s) of its email; an email can carry more than one (E027).
- [ ] A `route_to_person` tool records a routed Request with a summary and a Draft reply; routed emails show in the desk as "Needs you" with no lines and no gate.
- [ ] `close_no_action` records the reason (spam, auto-reply, duplicate) and shows "No action needed" with it; a duplicate links to the original email.
- [ ] An auto-reply's information is attached as a note to the same sender's open Requests.
- [ ] An email that refers to an attachment it doesn't have is routed with a reply asking for it to be resent.
- [ ] Tests with the fake model reproduce the expected outcomes for E009, E014, E016, E018, E022, E023, E027 (inquiry part), E028, E029 and E030.
