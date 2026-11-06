# 15 — The eval script

**What to build:** A person runs `make eval` and gets a report scoring a live run of the real model over all 40 emails against the expected outcomes, with unsafe releases first, ready for `docs/results.md`.

**Repo:** harbor-point

**Blocked by:** 06 — [Tracer: run the agent on one email, and a clean order releases](06-tracer-run-the-agent-on-e001.md)

**Label:** sandcastle

**Status:** closed — resolved 2026-11-06 23:36 WIB by sandcastle

## Context

The map is [`map.md`](../map.md); words are defined in [`CONTEXT.md`](../../../CONTEXT.md); every screen follows [`DESIGN.md`](../../../DESIGN.md), whose living example is Variant A of [the prototype](../assets/prototype-review-ui.html). The business rules are in the [data pack README](../../../data/harbor_point_data_pack/README.md); the data pack is read-only.

- Decided in [How the agent's results are measured](../issues/11-how-results-are-measured.md#answer):
  `make eval` is never part of `make check` (it calls the paid model); it resets a local database to
  the Snapshot, does an Inbox run with the real model, and scores: unsafe releases first (target 0),
  outcome accuracy with "also acceptable" counted as a match and missed releases counted
  separately, line precision and recall against the CSV, exact price and credit, review-reason
  recall; Draft replies are read by a person, not scored; three runs, report the spread; cost and
  time per email from the Agent run records.
- The expected outcomes and the "Eval lines" CSV are in
  [`per-email-expected-outcomes.md`](../assets/per-email-expected-outcomes.md); read them from there
  (the scorer must not hard-code them).

## Acceptance criteria

- [ ] `make eval` runs the full flow against a local database and the real model (key from env), and refuses to run without a key; it is not called by `make verify` or `make check`.
- [ ] The scorer parses the summary table and the CSV from the walkthrough file and scores outcomes, lines, prices, credit and review reasons as decided; unsafe releases are listed first with email ids and reasons.
- [ ] The report is written as Markdown (counts, accuracy, every mismatch with its email, cost and time per email) and can be run three times with the spread reported.
- [ ] The scorer itself is unit-tested with a canned run (no model) in `make check`, including an unsafe release, an also-acceptable match and a missed release.
