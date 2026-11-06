import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentRuns, auditEvents, proposals, salesOrders, users } from "@/db/schema";
import { SpendLimitReached, type ModelResponse } from "@/model/model";
import { ScriptedModel, callsTool } from "@/model/scripted-model";
import { setProposalAside } from "@/server/review/review";
import { ingestSnapshot } from "@/snapshot/snapshot";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import { e001Script } from "@/test/e001-script";
import { e019Script } from "@/test/review-scripts";
import { lockReleases, releaseOrder } from "./release-gate";
import { AgentRunRefused, DEADLINE_MARGIN_MS, RUN_ABANDONED_AFTER_MS, runAgent } from "./run-agent";

const MODEL_ID = "claude-opus-5-5";

// The turns of a script up to and including its `propose_new_order` call; the scripted model then
// has no next turn and fails, so the run ends failed with its Proposal stored.
function upToProposal(script: ModelResponse[]): ModelResponse[] {
  const proposeAt = script.findIndex((turn) =>
    turn.message.content.some((block) => block.type === "tool_call" && block.name === "propose_new_order"),
  );
  return script.slice(0, proposeAt + 1);
}

describe("re-running an email", () => {
  let testDatabase: TestDatabase;

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    await ingestSnapshot(testDatabase.db);
  });

  afterEach(async () => {
    await testDatabase.close();
  });

  async function proposalsOf(emailId: string) {
    return testDatabase.db.select().from(proposals).where(eq(proposals.emailId, emailId)).orderBy(asc(proposals.id));
  }

  it("withdraws the failed run's open Proposal as superseded, keeps it, and audits it", async () => {
    const db = testDatabase.db;
    const first = await runAgent(db, new ScriptedModel(upToProposal(e019Script())), { emailId: "E019", modelId: MODEL_ID });
    expect(first).toMatchObject({ outcome: "failed" });
    const [stranded] = await proposalsOf("E019");
    expect(stranded?.status).toBe("open");

    const second = await runAgent(db, new ScriptedModel(e019Script()), { emailId: "E019", modelId: MODEL_ID });

    expect(second).toMatchObject({ outcome: "proposal" });
    const after = await proposalsOf("E019");
    expect(after.map((proposal) => [proposal.runId, proposal.status])).toEqual([
      [first.runId, "superseded"],
      [second.runId, "open"],
    ]);
    const superseded = await db.select().from(auditEvents).where(eq(auditEvents.action, "proposal.superseded"));
    expect(superseded).toHaveLength(1);
    expect(superseded[0]).toMatchObject({ runId: second.runId, emailId: "E019", detail: { proposalId: stranded?.id, supersededRunId: first.runId } });
  });

  it("never touches a Proposal a person decided", async () => {
    const db = testDatabase.db;
    const [person] = await db.insert(users).values({ username: "ops.reviewer", passwordHash: "x", role: "reviewer" }).returning();
    await runAgent(db, new ScriptedModel(upToProposal(e019Script())), { emailId: "E019", modelId: MODEL_ID });
    const [held] = await proposalsOf("E019");
    if (!held || !person) throw new Error("no Proposal");
    await setProposalAside(db, { proposalId: held.id, userId: person.id, kind: "hold", reason: "Asking James", at: new Date() });

    await runAgent(db, new ScriptedModel(e019Script()), { emailId: "E019", modelId: MODEL_ID });

    const [still] = await proposalsOf("E019");
    expect(still).toMatchObject({ id: held.id, status: "held", decidedBy: person.id });
  });

  it("never touches work the gate released, and releases nothing twice", async () => {
    const db = testDatabase.db;
    await runAgent(db, new ScriptedModel(upToProposal(e001Script())), { emailId: "E001", modelId: MODEL_ID });
    const [released] = await proposalsOf("E001");
    expect(released).toMatchObject({ status: "released", soNumber: "SO-24059" });

    await runAgent(db, new ScriptedModel(e001Script()), { emailId: "E001", modelId: MODEL_ID });

    const [first] = await proposalsOf("E001");
    expect(first).toMatchObject({ id: released?.id, status: "released", soNumber: "SO-24059" });
  });

  it("refuses to release one Proposal twice", async () => {
    const db = testDatabase.db;
    await runAgent(db, new ScriptedModel(upToProposal(e001Script())), { emailId: "E001", modelId: MODEL_ID });
    const [released] = await proposalsOf("E001");
    if (!released) throw new Error("no Proposal");
    const ordersBefore = await db.$count(salesOrders);

    await expect(
      db.transaction(async (tx) => {
        await lockReleases(tx);
        await releaseOrder(tx, {
          proposalId: released.id,
          customerId: released.customerId,
          shipToId: released.shipToId,
          customerPo: null,
          requestedDate: released.requestedDate,
          orderDate: "2026-11-02",
          lines: [{ sku: "HPS-1408", quantity: 1, unitPriceCents: 4500 }],
        });
      }),
    ).rejects.toThrow(/already released/);
    expect(await db.$count(salesOrders)).toBe(ordersBefore);
  });

  it("refuses a second run while one is still reading the email", async () => {
    const db = testDatabase.db;
    await db.insert(agentRuns).values({ runId: "reading", emailId: "E001", modelId: MODEL_ID, startedAt: new Date() });

    await expect(runAgent(db, new ScriptedModel(e001Script()), { emailId: "E001", modelId: MODEL_ID })).rejects.toThrow(
      new AgentRunRefused("The agent is already reading E001."),
    );
  });

  it("does not let a run that was cut off hold the email for ever", async () => {
    const db = testDatabase.db;
    const longAgo = new Date(Date.now() - RUN_ABANDONED_AFTER_MS - 1_000);
    await db.insert(agentRuns).values({ runId: "cut-off", emailId: "E001", modelId: MODEL_ID, startedAt: longAgo });

    const summary = await runAgent(db, new ScriptedModel(e001Script()), { emailId: "E001", modelId: MODEL_ID });

    expect(summary).toMatchObject({ outcome: "released" });
  });
});

describe("a run's own limits", () => {
  let testDatabase: TestDatabase;

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    await ingestSnapshot(testDatabase.db);
  });

  afterEach(async () => {
    await testDatabase.close();
  });

  it("stops cleanly before the function's deadline, as timed out", async () => {
    let clock = new Date("2026-11-02T12:00:00Z").getTime();
    const deadline = new Date(clock + DEADLINE_MARGIN_MS + 30_000);
    // Each model call takes 20 seconds, so the third would start inside the margin.
    const turn = (): ModelResponse => {
      clock += 20_000;
      return callsTool("get_product", { sku: "HPS-1408" });
    };
    const model = new ScriptedModel([turn, turn, turn, turn]);

    const summary = await runAgent(testDatabase.db, model, {
      emailId: "E001",
      modelId: MODEL_ID,
      deadline,
      now: () => new Date(clock),
    });

    expect(model.requests).toHaveLength(2);
    expect(summary).toMatchObject({ outcome: "failed", errorClass: "deadline" });
    const [run] = await testDatabase.db.select().from(agentRuns).where(eq(agentRuns.runId, summary.runId));
    expect(run?.endedAt).not.toBeNull();
  });

  it("stops at a spend limit without retrying, and records the run as finished", async () => {
    let calls = 0;
    const model = {
      async send(): Promise<ModelResponse> {
        calls += 1;
        if (calls === 2) throw new SpendLimitReached();
        return callsTool("get_product", { sku: "HPS-1408" });
      },
    };

    const summary = await runAgent(testDatabase.db, model, { emailId: "E001", modelId: MODEL_ID });

    expect(calls).toBe(2);
    expect(summary).toMatchObject({ outcome: "failed", errorClass: "spend-limit" });
    const [run] = await testDatabase.db.select().from(agentRuns).where(eq(agentRuns.runId, summary.runId));
    expect(run?.endedAt).not.toBeNull();
  });
});
