# Harbor Point

The operating doc for this repository is `AGENTS.md`, imported here in full. It is the single
source of truth; anything about this repository belongs there, not here, so that every agent gets
the same answer.

@AGENTS.md

## Claude-specific

- **You cannot invoke `/to-tickets` or `/wayfinder`; only the user can.** Both carry
  `disable-model-invocation: true` in `.claude/skills/`, so the Skill tool refuses them. That is a
  deliberate gate, not an obstacle to route around. If the skill has not been invoked, never write
  its output under `grilled/<identifier>/tickets/` or `issues/` by hand. Stop and say what the
  tickets would have been, as `AGENTS.md` says.
