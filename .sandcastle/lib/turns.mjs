// When the implementer gets another turn.
//
// A turn is one Claude Code session that ended. It either signed off, or it did
// not, and then it either moved the branch (a commit, or a change to what is
// uncommitted) or it did not. A turn that moves nothing buys the same work again,
// so two in a row end the ticket for this run; the branch keeps what it has.

/**
 * The decision after a turn: `done` when it signed off, `stop` with a reason when
 * the ticket should wait for a later run, else `continue`. `idle` carries the count
 * of turns in a row without progress into the next call.
 */
export function afterTurn({ turn, idle, completed, progressed }, { maxTurns, maxIdle }) {
  if (completed) return { action: "done", idle: 0 };
  const nextIdle = progressed ? 0 : idle + 1;
  if (nextIdle >= maxIdle) {
    return { action: "stop", idle: nextIdle, reason: `no progress in ${maxIdle} turns` };
  }
  if (turn >= maxTurns) {
    return { action: "stop", idle: nextIdle, reason: `no completion after ${maxTurns} turns` };
  }
  return { action: "continue", idle: nextIdle };
}
