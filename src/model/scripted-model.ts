import type { Model, ModelRequest, ModelResponse } from "./model";

// A turn is either a fixed response or one computed from the request the agent sent.
export type ScriptedTurn = ModelResponse | ((request: ModelRequest) => ModelResponse);

// The fake model every test uses: it plays its turns in order and records what it was sent.
export class ScriptedModel implements Model {
  readonly requests: ModelRequest[] = [];
  private readonly turns: ScriptedTurn[];

  constructor(turns: ScriptedTurn[]) {
    this.turns = [...turns];
  }

  async send(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    const turnNumber = this.requests.length;
    const turn = this.turns[turnNumber - 1];
    if (turn === undefined) {
      throw new Error(`ScriptedModel: the script has no turn ${turnNumber}.`);
    }
    return typeof turn === "function" ? turn(request) : structuredClone(turn);
  }
}

export function repliesWith(text: string): ModelResponse {
  return { message: { role: "assistant", content: [{ type: "text", text }] }, stopReason: "end_turn" };
}

// The id defaults to one derived from the tool's name; pass one when a test needs two calls of
// the same tool told apart.
export function callsTool(name: string, input: unknown, id = `call_${name}`): ModelResponse {
  return {
    message: { role: "assistant", content: [{ type: "tool_call", id, name, input }] },
    stopReason: "tool_use",
  };
}
