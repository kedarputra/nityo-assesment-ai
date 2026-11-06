import { describe, expect, it } from "vitest";
import { textIn, toolCallsIn, type ModelRequest } from "./model";
import { ScriptedModel, callsTool, repliesWith } from "./scripted-model";

const lookupCustomer = {
  name: "lookup_customer",
  description: "Find a customer by email address.",
  inputSchema: { type: "object" as const, properties: { email: { type: "string" } } },
};

function requestSaying(text: string): ModelRequest {
  return {
    system: "You work the order inbox.",
    messages: [{ role: "user", content: [{ type: "text", text }] }],
    tools: [lookupCustomer],
  };
}

describe("ScriptedModel", () => {
  it("answers with its scripted turns in order", async () => {
    const model = new ScriptedModel([
      callsTool("lookup_customer", { email: "jenna@example.com" }),
      repliesWith("C005 is Jenna's company."),
    ]);

    const first = await model.send(requestSaying("Who sent E001?"));
    expect(first.stopReason).toBe("tool_use");
    expect(toolCallsIn(first.message)).toEqual([
      { type: "tool_call", id: "call_lookup_customer", name: "lookup_customer", input: { email: "jenna@example.com" } },
    ]);

    const second = await model.send(requestSaying("Who sent E001?"));
    expect(second.stopReason).toBe("end_turn");
    expect(textIn(second.message)).toBe("C005 is Jenna's company.");
  });

  it("records each request as it was sent", async () => {
    const model = new ScriptedModel([repliesWith("Done.")]);
    const request = requestSaying("Read E001.");

    await model.send(request);
    request.messages.push({ role: "user", content: [{ type: "text", text: "changed later" }] });

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.messages).toHaveLength(1);
    expect(model.requests[0]?.tools).toEqual([lookupCustomer]);
  });

  it("lets a turn depend on the request", async () => {
    const model = new ScriptedModel([
      (request) => repliesWith(`I can use ${request.tools.map((tool) => tool.name).join(", ")}.`),
    ]);

    const response = await model.send(requestSaying("What can you do?"));

    expect(textIn(response.message)).toBe("I can use lookup_customer.");
  });

  it("fails loudly when the script runs out", async () => {
    const model = new ScriptedModel([repliesWith("Only one turn.")]);
    await model.send(requestSaying("First."));

    await expect(model.send(requestSaying("Second."))).rejects.toThrow(/script has no turn 2/);
  });
});
