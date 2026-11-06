import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { draftReplies, emails } from "@/db/schema";
import { ScriptedModel, callsTool, repliesWith } from "@/model/scripted-model";
import { ingestSnapshot } from "@/snapshot/snapshot";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import { e001Script } from "@/test/e001-script";
import { SYSTEM_PROMPT } from "./prompt";
import { runAgent } from "./run-agent";

const MODEL_ID = "claude-opus-5-5";
const SECRET = "sk-ant-test-0123456789-never-logged";

// What the agent's logs say (security 8): ids, tool names, timings and error classes, and
// nothing a person wrote, the model was told or the deploy keeps secret.
describe("an Agent run's log", () => {
  let testDatabase: TestDatabase;
  let written: MockInstance<typeof console.log>;
  let erred: MockInstance<typeof console.error>;

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    await ingestSnapshot(testDatabase.db);
    vi.stubEnv("ANTHROPIC_API_KEY", SECRET);
    written = vi.spyOn(console, "log").mockImplementation(() => {});
    erred = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await testDatabase.close();
  });

  function logLines(): string[] {
    return [...written.mock.calls, ...erred.mock.calls].map((call) => call.map(String).join(" "));
  }

  async function bodyOf(emailId: string): Promise<string> {
    const [email] = await testDatabase.db.select({ body: emails.body }).from(emails).where(eq(emails.emailId, emailId));
    if (!email) throw new Error(`no email ${emailId}`);
    return email.body;
  }

  function expectNothingSensitive(lines: string[], sensitive: string[]): void {
    const output = lines.join("\n");
    for (const text of sensitive) {
      expect(text.length).toBeGreaterThan(10);
      // A distinctive slice is enough: a log that quoted any of it would contain this.
      expect(output).not.toContain(text.slice(0, 40));
    }
  }

  it("is one JSON line per tool call, with the run, email, tool, duration and error class", async () => {
    const summary = await runAgent(testDatabase.db, new ScriptedModel(e001Script()), { emailId: "E001", modelId: MODEL_ID });

    const entries = logLines().map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.map((entry) => entry.tool)).toEqual([
      "find_customer",
      "list_ship_tos",
      "get_product",
      "price_line",
      "check_stock",
      "check_credit",
      "propose_new_order",
      "draft_reply",
    ]);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(["durationMs", "emailId", "errorClass", "event", "runId", "tool"]);
      expect(entry).toMatchObject({ event: "tool_call", runId: summary.runId, emailId: "E001", errorClass: null });
      expect(entry.durationMs).toEqual(expect.any(Number));
    }
  });

  it("never holds the email body, the prompt, the reply or an env secret", async () => {
    const summary = await runAgent(testDatabase.db, new ScriptedModel(e001Script()), { emailId: "E001", modelId: MODEL_ID });
    const [reply] = await testDatabase.db.select().from(draftReplies).where(eq(draftReplies.runId, summary.runId));

    expectNothingSensitive(logLines(), [await bodyOf("E001"), SYSTEM_PROMPT, reply?.body ?? "", SECRET]);
  });

  it("logs a refused call by its error class, and a tool name the model made up as unknown", async () => {
    const body = await bodyOf("E001");
    const model = new ScriptedModel([
      callsTool(body, {}),
      callsTool("check_stock", { sku: body, quantity: -1 }),
      callsTool("close_no_action", { reason: "nothing to do" }),
      repliesWith("Closed."),
    ]);

    await runAgent(testDatabase.db, model, { emailId: "E001", modelId: MODEL_ID });

    const entries = logLines().map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.slice(0, 2)).toMatchObject([
      { event: "tool_call", tool: "unknown", errorClass: "UnknownTool" },
      { event: "tool_call", tool: "check_stock", errorClass: "SchemaMismatch" },
    ]);
    expectNothingSensitive(logLines(), [body]);
  });

  it("logs a run that fails as one error line with its class, never the error's message", async () => {
    const body = await bodyOf("E001");
    const model = new ScriptedModel([
      () => {
        throw new TypeError(`${body} ${SYSTEM_PROMPT} ${SECRET}`);
      },
    ]);

    const summary = await runAgent(testDatabase.db, model, { emailId: "E001", modelId: MODEL_ID });

    expect(erred).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(erred.mock.calls[0]?.[0]))).toEqual({
      event: "run_failed",
      runId: summary.runId,
      emailId: "E001",
      errorClass: "TypeError",
    });
    expectNothingSensitive(logLines(), [body, SYSTEM_PROMPT, SECRET]);
  });
});
