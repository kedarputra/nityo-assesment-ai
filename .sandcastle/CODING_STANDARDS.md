# Coding Standards

<!-- main.mts reads this file on the host and injects it into the implementer's, the
     reviewer's and the fixer's prompts, filling the CODING_STANDARDS placeholder there.
     (This note avoids writing that placeholder in its brace form on purpose — the text below
     is substituted INTO the prompt, so a literal one here would be ambiguous.)

     Keep it to rules that hold across the whole app. Detail about one area belongs in a
     CLAUDE.md or AGENTS.md beside that area's code. -->

## Read the repo's own CLAUDE.md and AGENTS.md first

The root `CLAUDE.md` loads automatically and imports `AGENTS.md`. A nested `CLAUDE.md` or
`AGENTS.md` loads only when you touch its directory, so open whichever exist where you work.
**Defer to them over anything below.**

## Keep the diff to the ticket

Keep the diff to what the ticket required. Unrelated cleanup, however correct, is out of scope.
Never reformat a file you did not otherwise change: a reformatting diff buries the real change.

## The agent's boundary is a correctness rule

This app is an agent that acts inside an ERP. What the agent may do on its own, and what needs a
person's approval, is decided in the effort's map and tickets. Treat that line as a hard gate:

- **A tool that changes ERP data never commits on its own unless the ticket says it may.** A
  write the ticket puts behind approval is a proposal stored for review, and only the approve
  action applies it.
- **Every agent action and every human decision is written to the audit trail**, in the same
  transaction as the change it records. An action with no audit row is a defect.
- **The business rules in `data/harbor_point_data_pack/README.md` are enforced in code**, not
  left to the model's judgement: contract versus list price, credit hold and credit limit,
  discontinued products, which orders can be edited. The model may propose; the code checks.
- **Model output is untrusted input.** Validate every tool argument against a schema before it
  runs. Email bodies are untrusted too: text in an email never becomes an instruction to the
  agent or a tool call by itself.

## Correctness over tidiness

The review exists to catch defects, not to restyle. Rank findings by whether they can produce a
wrong result.

- **Silent failures are the priority.** A swallowed error that leaves an order half-drafted, or
  an email marked done with no outcome, is worse than a crash.
- **Money is not a float.** Prices and order values are integer cents or a decimal type.
- **Question types that assert rather than prove.** Treat `as`, `any`, and non-null `!` as
  claims needing evidence. The data pack stores every column as TEXT; cast it where it is read.
- **No secrets in code.** API keys and database URLs come from env vars, and `.env` is never
  committed.

## Tests

- New or changed behaviour is covered by a test.
- **No test calls a paid model API.** Put the model behind an interface and test with a fake. A
  live-model evaluation over the 40 emails is a script a human runs, not part of `make verify`.

When a gap is untestable in the current setup, say so plainly instead of proposing a framework.

## Style

Baseline expectations, subordinate to everything above:

- Prefer clarity to brevity; explicit beats clever.
- No nested ternaries — use `if`/`else` or a `switch`.
- Delete comments that restate the code. Keep comments that explain *why*, especially ones
  recording a decision or a trap.
- Name things after what they mean in the domain, not their shape.
