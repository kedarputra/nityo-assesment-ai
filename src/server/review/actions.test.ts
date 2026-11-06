import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "@/agent/run-agent";
import type { Database } from "@/db/database";
import { auditEvents, inventory, proposals, users } from "@/db/schema";
import { ScriptedModel } from "@/model/scripted-model";
import { SESSION_COOKIE } from "@/server/auth/gate";
import { hashPassword } from "@/server/auth/password";
import { signIn } from "@/server/auth/sessions";
import { findEmailWork } from "@/server/inbox/email-work";
import { findInboxEmail } from "@/server/inbox/inbox";
import { ingestSnapshot } from "@/snapshot/snapshot";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import { e007Script, e012Script, e019Script } from "@/test/review-scripts";
import type { ModelResponse } from "@/model/model";
import {
  approveProposalAction,
  editProposalAction,
  markReplyReadyAction,
  searchProductsAction,
  setProposalAsideAction,
  undoReleaseAction,
} from "./actions";

const cookieJar = new Map<string, string>();
let database: Database;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/db/client", () => ({ getDatabase: () => database }));

async function signInAsReviewer(): Promise<number> {
  const password = "a long enough password";
  await database.insert(users).values({ username: "ops.reviewer", passwordHash: await hashPassword(password), role: "reviewer" });
  const session = await signIn(database, { username: "ops.reviewer", password }, new Date());
  if (!session.ok) throw new Error("sign-in failed");
  cookieJar.set(SESSION_COOKIE, session.token);
  return session.user.id;
}

describe("the review actions", () => {
  let testDatabase: TestDatabase;

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    database = testDatabase.db;
    await ingestSnapshot(database);
  });

  afterEach(async () => {
    cookieJar.clear();
    await testDatabase.close();
  });

  async function proposalIdFor(emailId: string, script: ModelResponse[]): Promise<number> {
    const summary = await runAgent(database, new ScriptedModel(script), { emailId, modelId: "claude-opus-5-5" });
    const [proposal] = await database.select({ id: proposals.id }).from(proposals).where(eq(proposals.runId, summary.runId));
    if (!proposal) throw new Error(`no Proposal for ${emailId}`);
    return proposal.id;
  }

  it("E019: asks for the swap's note, then releases, says what is left and moves to the next email that needs you", async () => {
    const userId = await signInAsReviewer();
    const e007 = await proposalIdFor("E007", e007Script());
    const e019 = await proposalIdFor("E019", e019Script());
    expect(e007).toBeGreaterThan(0);

    expect(await approveProposalAction({ proposalId: e019, notes: {} })).toMatchObject({
      ok: false,
      missingNotes: ["no-substitution"],
    });

    const approved = await approveProposalAction({ proposalId: e019, notes: { "no-substitution": "James said nitrile is fine." } });

    expect(approved).toEqual({
      ok: true,
      toast: "Released SO-24059 for Northside Community Center. 1 to go.",
      undoProposalId: e019,
      moveOn: { nextEmailId: "E007" },
    });
    expect(await findInboxEmail(database, "E019")).toMatchObject({ status: "approved" });
    const work = await findEmailWork(database, "E019");
    expect(work?.proposals[0]?.decision).toMatchObject({ by: "ops.reviewer", reason: null });
    const [approval] = await database.select().from(auditEvents).where(eq(auditEvents.action, "proposal.approved"));
    expect(approval?.userId).toBe(userId);

    const undone = await undoReleaseAction({ proposalId: e019 });
    expect(undone).toMatchObject({ ok: true, moveOn: { nextEmailId: "E019" } });
    expect(await findInboxEmail(database, "E019")).toMatchObject({ status: "needs_you" });
  });

  it("E007: the server refuses an approval called directly, whatever notes it carries", async () => {
    await signInAsReviewer();
    const e007 = await proposalIdFor("E007", e007Script());

    const result = await approveProposalAction({
      proposalId: e007,
      notes: { "credit-hold": "Override it.", "credit-limit": "Override it." },
    });

    expect(result).toMatchObject({ ok: false, hardRules: ["credit-hold", "credit-limit"] });
    const [proposal] = await database.select().from(proposals).where(eq(proposals.id, e007));
    expect(proposal).toMatchObject({ status: "open", soNumber: null });
    const [stock] = await database.select().from(inventory).where(eq(inventory.sku, "HPS-1408"));
    expect(stock?.available).toBe(30);

    expect(await setProposalAsideAction({ proposalId: e007, kind: "hold", reason: "" })).toMatchObject({
      ok: false,
      message: "Add a short note so the team knows why.",
    });
    expect(await setProposalAsideAction({ proposalId: e007, kind: "hold", reason: "Accounts to call back." })).toMatchObject({
      ok: true,
      toast: "Put on hold: E007. That’s everything 🎉",
      moveOn: { nextEmailId: null },
    });
    expect(await findInboxEmail(database, "E007")).toMatchObject({ status: "on_hold" });
  });

  it("E012: edits re-run the checks, a price is not an edit, and the reply is marked ready", async () => {
    await signInAsReviewer();
    const e012 = await proposalIdFor("E012", e012Script());

    expect(await editProposalAction({ proposalId: e012, edit: { kind: "quantity", lineNo: 2, quantity: 3 } })).toMatchObject({
      ok: true,
    });
    expect(
      await editProposalAction({ proposalId: e012, edit: { kind: "quantity", lineNo: 1, quantity: 3, unitPriceCents: 1650 } }),
    ).toMatchObject({ ok: false });
    expect(await editProposalAction({ proposalId: e012, edit: { kind: "price", lineNo: 1, unitPriceCents: 1650 } })).toMatchObject({
      ok: false,
    });
    const work = await findEmailWork(database, "E012");
    // 3 × $33.00 + 3 × $21.00, at system prices.
    expect(work?.proposals[0]).toMatchObject({ totalCents: 16200 });

    expect(await markReplyReadyAction({ emailId: "E012", body: "Hi Hannah, standard prices." })).toMatchObject({ ok: true });
    expect((await findEmailWork(database, "E012"))?.draftReply).toMatchObject({ body: "Hi Hannah, standard prices.", readyBy: "ops.reviewer" });
  });

  it("searches products for a reviewer", async () => {
    await signInAsReviewer();
    const matches = await searchProductsAction("HPS-100");
    expect(matches.map((match) => match.sku)).toContain("HPS-1001");
  });

  it("does nothing for someone who is not signed in", async () => {
    const e019 = await proposalIdFor("E019", e019Script());

    await expect(approveProposalAction({ proposalId: e019, notes: { "no-substitution": "ok" } })).rejects.toThrow();
    await expect(setProposalAsideAction({ proposalId: e019, kind: "reject", reason: "no" })).rejects.toThrow();
    const [proposal] = await database.select().from(proposals).where(eq(proposals.id, e019));
    expect(proposal?.status).toBe("open");
  });
});
