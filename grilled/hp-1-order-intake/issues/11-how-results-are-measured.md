# 11 — How the agent's results are measured, in the eval and in production

**Type:** grilling

**Blocked by:** 03, 07, 08, 09, 10 — [the walkthrough](03-per-email-walkthrough.md) and the four tickets that settled its open cases

**Status:** closed — resolved by Kedar Putra (recommended options, standing instruction), 2026-11-06 21:25 WIB

## Question

How is a live run over the 40 emails scored against
[the expected outcomes](../assets/per-email-expected-outcomes.md) for `docs/results.md` (brief
item 5: "how your system handled the 40 emails, where it gets things wrong")? And how would success
be measured in production (brief item 1)?

## Answer

Each decision is the recommended option, taken under the developer's standing instruction.

**The eval.**
- **How it runs:** `make eval` is a script a human runs, never part of `make check`, because it
  calls the paid model (`AGENTS.md`). It resets a local database to the Snapshot, does an Inbox
  run with the real model, and writes a report.
- **The metrics, in order of importance:**
  1. **Unsafe releases: the target is 0.** Any email whose expected outcome is a Proposal, routed or
     no action, but which the run released. This is the metric the release gate exists for; one
     unsafe release is reported first, with the email and the reason.
  2. **Outcome accuracy.** The outcome per email (released, proposal, routed, no action) matches,
     where an "also acceptable" outcome counts as a match. Missed releases (expected released, but
     sent to review) are counted separately as lost automation, not as errors.
  3. **Line accuracy.** On orders, the SKU, quantity and ship-to per line are matched against the
     "Eval lines" CSV, as precision and recall. Price and credit come from code, so they must match
     exactly; any difference is a bug, not a model error.
  4. **Review reasons.** For each expected Proposal, the share of its expected flags the run raised
     (recall), and any extra flags.
  5. **Draft replies are not auto-scored.** A person reads the replies for 10 emails (every routed
     one plus a sample) against a three-point check: correct facts, the right question asked, and
     the voice from `DESIGN.md`.
- **Cost and time:** the model calls, tokens, cost and seconds per email, from the Agent run
  records.
- **Repeats:** the run is done three times, and `docs/results.md` reports the spread, not the best
  run.

**Production success metrics, for the product brief:**
- **Safety:** releases later corrected because the agent was wrong (edited, cancelled or credited),
  with a target near 0.
- **Automation:** the share of emails handled without a person (released, or no action), tracked
  per week. The gate is loosened only where corrections stay near 0.
- **Review quality:**
  - the share of Proposals approved without any edit;
  - the override rate per soft check (a check that is always overridden is miscalibrated);
  - the median time a person spends per email.
- **Speed for the customer:** the time from an email's receipt to the order in the ERP, at the
  median and p90.
- **Cost:** the model cost per email.
