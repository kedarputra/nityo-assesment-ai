import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Database } from "@/db/database";
import { agentFlags, agentRuns, emails, proposals, type AgentRunOutcome, type GateVerdict, type ProposalStatus } from "@/db/schema";
import { businessDateOf } from "@/lib/business-clock";
import { errorClassOf, logError, logToolCall } from "@/lib/log";
import { toolCallsIn, type Model, type ModelMessage, type ModelResponse, type ToolCall, type ToolResult } from "@/model/model";
import { BusinessRuleError } from "@/rules/business-rules";
import { recordAudit } from "./audit";
import { emailMessage, SYSTEM_PROMPT } from "./prompt";
import { ToolError } from "./tool-error";
import { findTool, toolDefinitions, type RunState, type ToolContext } from "./tools";

// One Agent run: a tool-use loop over one Email (the agent's shape). Security 5 bounds it: at
// most 15 model calls, and every tool result capped in size.
export const MAX_MODEL_CALLS = 15;
export const MAX_TOOL_RESULT_CHARS = 8_000;

// Dollars per million tokens, in and out; the run record's cost is an estimate from these.
const PRICES_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
const DEFAULT_PRICES = { input: 4, output: 20 };

// The email cannot be run: it does not exist, or it has run already (re-running is ticket 13's).
export class AgentRunRefused extends Error {
  override name = "AgentRunRefused";
}

export interface AgentRunSummary {
  runId: string;
  emailId: string;
  outcome: AgentRunOutcome;
  gateVerdict: GateVerdict | null;
  errorClass: string | null;
}

export interface RunAgentOptions {
  emailId: string;
  modelId: string;
  // The person who pressed "Run the agent", recorded on the run's first audit event.
  startedBy?: number;
  now?: () => Date;
}

interface Usage {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
}

// Agent runs on one email are serialised; the second number keeps this lock apart from others.
const EMAIL_LOCK_SPACE = 0x48500602;

export async function runAgent(db: Database, model: Model, options: RunAgentOptions): Promise<AgentRunSummary> {
  const now = options.now ?? (() => new Date());
  const [email] = await db.select().from(emails).where(eq(emails.emailId, options.emailId));
  if (!email) throw new AgentRunRefused(`There is no email ${options.emailId}.`);

  const runId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${EMAIL_LOCK_SPACE}, hashtext(${email.emailId}))`);
    const [earlier] = await tx
      .select({ runId: agentRuns.runId })
      .from(agentRuns)
      .where(eq(agentRuns.emailId, email.emailId))
      .limit(1);
    if (earlier) throw new AgentRunRefused(`The agent has already run on ${email.emailId}.`);
    const startedAt = now();
    await tx.insert(agentRuns).values({ runId, emailId: email.emailId, modelId: options.modelId, startedAt });
    await recordAudit(tx, {
      at: startedAt,
      actor: "agent",
      userId: options.startedBy ?? null,
      action: "run.started",
      emailId: email.emailId,
      runId,
      detail: { modelId: options.modelId },
    });
  });

  const context: ToolContext = {
    runId,
    emailId: email.emailId,
    senderEmail: email.fromEmail,
    orderDate: businessDateOf(email.receivedAt),
    now,
  };
  const state: RunState = { closedNoAction: null };
  const usage: Usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0 };
  const tools = toolDefinitions();
  const messages: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: emailMessage(email) }] }];

  let errorClass: string | null = null;
  try {
    for (;;) {
      if (usage.modelCalls >= MAX_MODEL_CALLS) {
        errorClass = "call-cap";
        break;
      }
      const response = await model.send({ system: SYSTEM_PROMPT, messages, tools });
      countUsage(usage, response);
      messages.push(response.message);

      const calls = toolCallsIn(response.message);
      if (calls.length === 0) {
        errorClass = stopErrorClass(response);
        break;
      }
      const results: ToolResult[] = [];
      for (const call of calls) results.push(await callTool(db, context, state, call));
      messages.push({ role: "user", content: results });
    }
  } catch (error) {
    // The run is recorded as failed with its error class, never left looking finished.
    errorClass = errorClassOf(error);
  }

  const summary = await finishRun(db, { context, state, usage, errorClass, modelId: options.modelId });
  if (summary.errorClass !== null) {
    logError({ event: "run_failed", runId: summary.runId, emailId: summary.emailId, errorClass: summary.errorClass });
  }
  return summary;
}

function countUsage(usage: Usage, response: ModelResponse): void {
  usage.modelCalls += 1;
  usage.inputTokens += response.usage?.inputTokens ?? 0;
  usage.outputTokens += response.usage?.outputTokens ?? 0;
}

function stopErrorClass(response: ModelResponse): string | null {
  switch (response.stopReason) {
    case "max_tokens":
      return "max-tokens";
    case "refusal":
      return "refusal";
    default:
      return null;
  }
}

// Each call is one line in the structured log, timed from the moment the model's call arrives.
async function callTool(db: Database, context: ToolContext, state: RunState, call: ToolCall): Promise<ToolResult> {
  const startedAt = performance.now();
  // The model names the tool, so a made-up name could carry anything; only a real tool is logged.
  const tool = findTool(call.name) ? call.name : "unknown";
  const log = (errorClass: string | null) =>
    logToolCall({ runId: context.runId, emailId: context.emailId, tool, durationMs: performance.now() - startedAt, errorClass });
  try {
    const result = await applyToolCall(db, context, state, call);
    log(result.refusal);
    return result.toolResult;
  } catch (error) {
    log(errorClassOf(error));
    throw error;
  }
}

interface AppliedCall {
  toolResult: ToolResult;
  // Why the call was refused, as an error class, or null when it ran.
  refusal: string | null;
}

// Each tool call runs in its own transaction with its audit event. A call that fails its schema
// or the tool's own checks writes nothing but the audit event, and the model gets the error.
async function applyToolCall(db: Database, context: ToolContext, state: RunState, call: ToolCall): Promise<AppliedCall> {
  const audit = (tx: Database, action: string, detail: Record<string, unknown>) =>
    recordAudit(tx, {
      at: context.now(),
      actor: "agent",
      action,
      emailId: context.emailId,
      runId: context.runId,
      detail: { tool: call.name, input: call.input, ...detail },
    });
  const refuse = async (refusal: string, problem: string): Promise<AppliedCall> => {
    await audit(db, "tool.refused", { problem });
    return { toolResult: { type: "tool_result", toolCallId: call.id, content: problem, isError: true }, refusal };
  };

  const tool = findTool(call.name);
  if (!tool) return refuse("UnknownTool", `There is no tool called ${call.name}.`);
  const validated = tool.validate(call.input);
  if (!validated.valid) return refuse("SchemaMismatch", `The arguments do not fit ${call.name}'s schema:\n${validated.problems}`);

  try {
    const content = await db.transaction(async (tx) => {
      const result = await validated.run(tx, context, state);
      const capped = capResult(JSON.stringify(result));
      await audit(tx, "tool.called", { result: capped });
      return capped;
    });
    return { toolResult: { type: "tool_result", toolCallId: call.id, content }, refusal: null };
  } catch (error) {
    if (error instanceof ToolError || error instanceof BusinessRuleError) return refuse(errorClassOf(error), error.message);
    throw error;
  }
}

function capResult(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content;
  return `${content.slice(0, MAX_TOOL_RESULT_CHARS)}… [cut at ${MAX_TOOL_RESULT_CHARS} characters]`;
}

interface Finish {
  context: ToolContext;
  state: RunState;
  usage: Usage;
  errorClass: string | null;
  modelId: string;
}

async function finishRun(db: Database, { context, state, usage, errorClass, modelId }: Finish): Promise<AgentRunSummary> {
  return db.transaction(async (tx) => {
    const proposed = await tx.select({ status: proposals.status }).from(proposals).where(eq(proposals.runId, context.runId));
    const flags = await tx.select({ id: agentFlags.id }).from(agentFlags).where(eq(agentFlags.runId, context.runId));
    const gateVerdict = gateVerdictOf(proposed.map((proposal) => proposal.status));
    const settled = outcomeOf({ gateVerdict, flagged: flags.length > 0, closedNoAction: state.closedNoAction !== null });
    // A run that ends without an outcome is a failure a person sees, never a quiet "done".
    const finalErrorClass = errorClass ?? (settled === null ? "no-outcome" : null);
    const outcome: AgentRunOutcome = finalErrorClass === null && settled !== null ? settled : "failed";

    const endedAt = context.now();
    const prices = PRICES_PER_MILLION_TOKENS[modelId] ?? DEFAULT_PRICES;
    // Dollars per million tokens are micro-dollars per token.
    const estimatedCostMicroUsd = usage.inputTokens * prices.input + usage.outputTokens * prices.output;
    await tx
      .update(agentRuns)
      .set({ endedAt, ...usage, estimatedCostMicroUsd, outcome, gateVerdict, errorClass: finalErrorClass })
      .where(eq(agentRuns.runId, context.runId));
    await recordAudit(tx, {
      at: endedAt,
      actor: "agent",
      action: "run.finished",
      emailId: context.emailId,
      runId: context.runId,
      detail: {
        outcome,
        gateVerdict,
        errorClass: finalErrorClass,
        noActionReason: state.closedNoAction,
        ...usage,
        estimatedCostMicroUsd,
      },
    });
    return { runId: context.runId, emailId: context.emailId, outcome, gateVerdict, errorClass: finalErrorClass };
  });
}

// One open Proposal is enough for the run to need a person.
function gateVerdictOf(statuses: ProposalStatus[]): GateVerdict | null {
  if (statuses.includes("open")) return "review";
  if (statuses.includes("released")) return "released";
  return null;
}

function outcomeOf(run: { gateVerdict: GateVerdict | null; flagged: boolean; closedNoAction: boolean }): AgentRunOutcome | null {
  if (run.gateVerdict === "review") return "proposal";
  if (run.gateVerdict === "released") return "released";
  if (run.flagged) return "routed";
  if (run.closedNoAction) return "no_action";
  return null;
}
