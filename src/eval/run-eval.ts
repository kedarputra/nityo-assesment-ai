import { asc, inArray } from "drizzle-orm";
import { runAgent } from "@/agent/run-agent";
import type { Database } from "@/db/database";
import { agentFlags, agentRuns, emails, proposalLines, proposals } from "@/db/schema";
import type { Model } from "@/model/model";
import { resetToSnapshot } from "@/snapshot/snapshot";
import type { EmailRunResult, RunProposal } from "./score";

// One eval round (issue 11): the Reset, then an Inbox run over all 40 emails in `received_at`
// order, then what each Agent run left behind, read from its records.
export async function evalRound(
  db: Database,
  model: Model,
  modelId: string,
  onEmail: (emailId: string) => void = () => {},
): Promise<EmailRunResult[]> {
  await resetToSnapshot(db);
  const inbox = await db.select({ emailId: emails.emailId }).from(emails).orderBy(asc(emails.receivedAt));
  for (const { emailId } of inbox) {
    onEmail(emailId);
    // A failure inside the run is recorded on its run record, so the round carries on.
    await runAgent(db, model, { emailId, modelId });
  }
  return readRunResults(db, inbox.map((email) => email.emailId));
}

async function readRunResults(db: Database, emailIds: string[]): Promise<EmailRunResult[]> {
  const runs = await db.select().from(agentRuns);
  const flags = await db.select({ runId: agentFlags.runId, code: agentFlags.code }).from(agentFlags).orderBy(asc(agentFlags.id));
  const proposed = await db.select().from(proposals).orderBy(asc(proposals.id));
  const lines =
    proposed.length === 0
      ? []
      : await db
          .select()
          .from(proposalLines)
          .where(
            inArray(
              proposalLines.proposalId,
              proposed.map((proposal) => proposal.id),
            ),
          )
          .orderBy(asc(proposalLines.proposalId), asc(proposalLines.lineNo));

  return emailIds.map((emailId): EmailRunResult => {
    const run = runs.find((candidate) => candidate.emailId === emailId);
    if (!run) return notRun(emailId);
    const runProposals = proposed
      .filter((proposal) => proposal.runId === run.runId)
      .map(
        (proposal): RunProposal => ({
          status: proposal.status,
          shipToId: proposal.shipToId,
          lines: lines
            .filter((line) => line.proposalId === proposal.id)
            .map((line) => ({ sku: line.sku, quantity: line.quantity, unitPriceCents: line.unitPriceCents })),
          failingChecks: proposal.checks.filter((check) => !check.passes).map((check) => check.check),
        }),
      );
    return {
      emailId,
      outcome: run.outcome,
      errorClass: run.errorClass,
      flags: flags.filter((flag) => flag.runId === run.runId).map((flag) => flag.code),
      proposals: runProposals,
      modelCalls: run.modelCalls,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      costMicroUsd: run.estimatedCostMicroUsd,
      seconds: run.endedAt ? (run.endedAt.getTime() - run.startedAt.getTime()) / 1000 : 0,
    };
  });
}

function notRun(emailId: string): EmailRunResult {
  return {
    emailId,
    outcome: null,
    errorClass: null,
    flags: [],
    proposals: [],
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costMicroUsd: 0,
    seconds: 0,
  };
}
