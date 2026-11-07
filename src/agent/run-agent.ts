import { randomUUID } from "node:crypto";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { Database } from "@/db/database";
import {
  agentRuns,
  emails,
  proposals,
  requestKinds,
  routedRequests,
  type AgentRunOutcome,
  type GateVerdict,
  type ProposalStatus,
  type RequestKind,
} from "@/db/schema";
import { businessDateOf } from "@/lib/business-clock";
import { errorClassOf, logError, logToolCall } from "@/lib/log";
import { SpendLimitReached, toolCallsIn, type Model, type ModelMessage, type ModelResponse, type ToolCall, type ToolResult } from "@/model/model";
import { BusinessRuleError } from "@/rules/business-rules";
import { recordAudit } from "./audit";
import { lockReleases } from "./release-gate";
import { SPEND_LIMIT_ERROR_CLASS } from "./run-errors";
import { emailMessage, SYSTEM_PROMPT } from "./prompt";
import { ToolError } from "./tool-error";
import { findTool, toolDefinitions, type ToolContext } from "./tools";

// One Agent run: a tool-use loop over one Email (the agent's shape). Security 5 bounds it: at
// most 15 model calls, and every tool result capped in size.
export const MAX_MODEL_CALLS = 15;
export const MAX_TOOL_RESULT_CHARS = 8_000;

// The route's function stops at 300 s (`maxDuration`). A run asks the model for nothing once less
// than this is left before the deadline, since one call can take most of a minute, and ends as
// timed out rather than being cut off half-way.
export const DEADLINE_MARGIN_MS = 60_000;
// A run that has not finished this long after it started was cut off with its function, so it no
// longer holds its email or blocks a Reset.
export const RUN_ABANDONED_AFTER_MS = 360_000;

// Dollars per million tokens, in and out; the run record's cost is an estimate from these.
const PRICES_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
const DEFAULT_PRICES = { input: 4, output: 20 };

// The email cannot be run: it does not exist, the agent is reading it now, or its latest run
// finished. Only an email that has not run, or whose latest run failed, can run again.
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
  // The Inbox run this run is part of.
  inboxRunId?: number;
  // When the function will be stopped (Vercel's `getDeadline()`); none in a script or a test.
  deadline?: Date;
  // Runs in the transaction that starts the run, once the email is locked and free, so a refusal
  // (a rate limit, say) leaves no run behind.
  admit?: (tx: Database) => Promise<void>;
  now?: () => Date;
}

interface Usage {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
}

// Agent runs on one email are serialised; the second number keeps this lock apart from others.
const EMAIL_LOCK_SPACE = 0x48500602;
// Every run starts under this lock shared, and a Reset takes it alone, so a Reset never empties
// the tables under a run that is starting.
const SNAPSHOT_LOCK = 0x48500603;

export async function shareSnapshotLock(tx: Database): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(${SNAPSHOT_LOCK})`);
}

export async function takeSnapshotLock(tx: Database): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${SNAPSHOT_LOCK})`);
}

// A run still reading: not finished, and not so old that its function was cut off.
export function isReading(run: { startedAt: Date; endedAt: Date | null }, now: Date): boolean {
  return run.endedAt === null && now.getTime() - run.startedAt.getTime() < RUN_ABANDONED_AFTER_MS;
}

export async function runAgent(db: Database, model: Model, options: RunAgentOptions): Promise<AgentRunSummary> {
  const now = options.now ?? (() => new Date());
  const [email] = await db.select().from(emails).where(eq(emails.emailId, options.emailId));
  if (!email) throw new AgentRunRefused(`There is no email ${options.emailId}.`);

  const runId = randomUUID();
  await db.transaction(async (tx) => {
    await shareSnapshotLock(tx);
    await tx.execute(sql`select pg_advisory_xact_lock(${EMAIL_LOCK_SPACE}, hashtext(${email.emailId}))`);
    const startedAt = now();
    const [latest] = await tx
      .select({ startedAt: agentRuns.startedAt, endedAt: agentRuns.endedAt, outcome: agentRuns.outcome })
      .from(agentRuns)
      .where(eq(agentRuns.emailId, email.emailId))
      .orderBy(desc(agentRuns.startedAt))
      .limit(1);
    if (latest && isReading(latest, startedAt)) throw new AgentRunRefused(`The agent is already reading ${email.emailId}.`);
    if (latest && latest.endedAt !== null && latest.outcome !== "failed") {
      throw new AgentRunRefused(`The agent has already run on ${email.emailId}.`);
    }
    await options.admit?.(tx);
    await tx.insert(agentRuns).values({
      runId,
      emailId: email.emailId,
      modelId: options.modelId,
      startedAt,
      inboxRunId: options.inboxRunId ?? null,
    });
    await recordAudit(tx, {
      at: startedAt,
      actor: "agent",
      userId: options.startedBy ?? null,
      action: "run.started",
      emailId: email.emailId,
      runId,
      detail: { modelId: options.modelId, ...(options.inboxRunId === undefined ? {} : { inboxRunId: options.inboxRunId }) },
    });
    await supersedeOpenProposals(tx, { emailId: email.emailId, runId, at: startedAt });
  });

  const context: ToolContext = {
    runId,
    emailId: email.emailId,
    senderEmail: email.fromEmail,
    orderDate: businessDateOf(email.receivedAt),
    now,
  };
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
      if (options.deadline && options.deadline.getTime() - now().getTime() < DEADLINE_MARGIN_MS) {
        errorClass = "deadline";
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
      for (const call of calls) results.push(await callTool(db, context, call));
      messages.push({ role: "user", content: results });
    }
  } catch (error) {
    // The run is recorded as failed with its error class, never left looking finished.
    errorClass = error instanceof SpendLimitReached ? SPEND_LIMIT_ERROR_CLASS : errorClassOf(error);
  }

  const summary = await finishRun(db, { context, usage, errorClass, modelId: options.modelId });
  if (summary.errorClass !== null) {
    logError({ event: "run_failed", runId: summary.runId, emailId: summary.emailId, errorClass: summary.errorClass });
  }
  return summary;
}

// A re-run replaces the email's undecided work: the open Proposals of earlier runs are withdrawn,
// kept and audited. A held, rejected or released Proposal is a decision and is never touched.
async function supersedeOpenProposals(tx: Database, run: { emailId: string; runId: string; at: Date }): Promise<void> {
  await lockReleases(tx);
  const withdrawn = await tx
    .update(proposals)
    .set({ status: "superseded" })
    .where(and(eq(proposals.emailId, run.emailId), eq(proposals.status, "open"), ne(proposals.runId, run.runId)))
    .returning({ id: proposals.id, runId: proposals.runId });
  for (const proposal of withdrawn) {
    await recordAudit(tx, {
      at: run.at,
      actor: "agent",
      action: "proposal.superseded",
      emailId: run.emailId,
      runId: run.runId,
      detail: { proposalId: proposal.id, supersededRunId: proposal.runId },
    });
  }
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
async function callTool(db: Database, context: ToolContext, call: ToolCall): Promise<ToolResult> {
  const startedAt = performance.now();
  // The model names the tool, so a made-up name could carry anything; only a real tool is logged.
  const tool = findTool(call.name) ? call.name : "unknown";
  const log = (errorClass: string | null) =>
    logToolCall({ runId: context.runId, emailId: context.emailId, tool, durationMs: performance.now() - startedAt, errorClass });
  try {
    const result = await applyToolCall(db, context, call);
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
async function applyToolCall(db: Database, context: ToolContext, call: ToolCall): Promise<AppliedCall> {
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
      const result = await validated.run(tx, context);
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
  usage: Usage;
  errorClass: string | null;
  modelId: string;
}

async function finishRun(db: Database, { context, usage, errorClass, modelId }: Finish): Promise<AgentRunSummary> {
  return db.transaction(async (tx) => {
    const proposed = await tx
      .select({ status: proposals.status, kind: proposals.kind })
      .from(proposals)
      .where(eq(proposals.runId, context.runId));
    const routed = await tx
      .select({ kind: routedRequests.kind })
      .from(routedRequests)
      .where(eq(routedRequests.runId, context.runId));
    const [run] = await tx
      .select({ noActionReason: agentRuns.noActionReason })
      .from(agentRuns)
      .where(eq(agentRuns.runId, context.runId));
    const noActionReason = run?.noActionReason ?? null;
    const closedNoAction = noActionReason !== null;
    const gateVerdict = gateVerdictOf(proposed.map((proposal) => proposal.status));
    const settled = outcomeOf({ gateVerdict, routed: routed.length > 0, closedNoAction });
    // A run that ends without an outcome is a failure a person sees, never a quiet "done".
    const finalErrorClass = errorClass ?? (settled === null ? "no-outcome" : null);
    const outcome: AgentRunOutcome = finalErrorClass === null && settled !== null ? settled : "failed";
    const kinds = requestKindsOf([
      ...proposed.map((proposal) => proposal.kind),
      ...routed.map((request) => request.kind),
      ...(closedNoAction ? (["no action"] as const) : []),
    ]);

    const endedAt = context.now();
    const prices = PRICES_PER_MILLION_TOKENS[modelId] ?? DEFAULT_PRICES;
    // Dollars per million tokens are micro-dollars per token.
    const estimatedCostMicroUsd = usage.inputTokens * prices.input + usage.outputTokens * prices.output;
    await tx
      .update(agentRuns)
      .set({ endedAt, ...usage, estimatedCostMicroUsd, outcome, gateVerdict, errorClass: finalErrorClass, requestKinds: kinds })
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
        requestKinds: kinds,
        noActionReason,
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

// A routed Request needs a person even beside a released order, so it outranks the release.
function outcomeOf(run: { gateVerdict: GateVerdict | null; routed: boolean; closedNoAction: boolean }): AgentRunOutcome | null {
  if (run.gateVerdict === "review") return "proposal";
  if (run.routed) return "routed";
  if (run.gateVerdict === "released") return "released";
  if (run.closedNoAction) return "no_action";
  return null;
}

// Each kind once, in CONTEXT.md's order.
function requestKindsOf(found: RequestKind[]): RequestKind[] {
  return requestKinds.filter((kind) => found.includes(kind));
}
