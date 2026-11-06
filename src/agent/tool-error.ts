// A call the model can correct: the result goes back to it as an error and nothing is written.
export class ToolError extends Error {
  override name = "ToolError";
}
