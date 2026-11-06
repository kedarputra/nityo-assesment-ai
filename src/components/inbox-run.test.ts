import { describe, expect, it, vi } from "vitest";
import type { InboxRunStepResult } from "@/server/inbox/actions";
import { driveInboxRun, endMessage, STOPPED_BY_YOU } from "./inbox-run";

vi.mock("@/server/inbox/actions", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const plan = {
  inboxRunId: 7,
  total: 40,
  emails: [
    { emailId: "E003", position: 3 },
    { emailId: "E004", position: 4 },
    { emailId: "E005", position: 5 },
  ],
};

const SPEND_LIMIT = "The model’s spending limit is reached, so runs are paused. Ask an admin to raise it.";

function driver(results: Record<string, InboxRunStepResult>, stopAfter?: string) {
  const asked: string[] = [];
  const reading: string[] = [];
  let reads = 0;
  return {
    asked,
    reading,
    reads: () => reads,
    driver: {
      runEmail: async (emailId: string) => {
        asked.push(emailId);
        return results[emailId] ?? { ok: true as const, outcome: "done" as const };
      },
      onReading: (email: { emailId: string; position: number }) => reading.push(`${email.position} of ${plan.total}`),
      onRead: () => (reads += 1),
      stopRequested: () => stopAfter !== undefined && asked.includes(stopAfter),
    },
  };
}

describe("driveInboxRun, Run all in the browser", () => {
  it("asks for each email in turn, one request each, saying where it has got to", async () => {
    const run = driver({});

    const end = await driveInboxRun(plan, run.driver);

    expect(run.asked).toEqual(["E003", "E004", "E005"]);
    expect(run.reading).toEqual(["3 of 40", "4 of 40", "5 of 40"]);
    expect(run.reads()).toBe(3);
    expect(end).toEqual({ stoppedBecause: null, timedOut: 0 });
  });

  it("carries on past an email that timed out, and counts it", async () => {
    const run = driver({ E004: { ok: true, outcome: "timed-out" } });

    const end = await driveInboxRun(plan, run.driver);

    expect(run.asked).toEqual(["E003", "E004", "E005"]);
    expect(endMessage(end)).toEqual({ text: "Run all finished. 1 email timed out; run it again to finish them.", problem: false });
  });

  it("stops at once on a spend limit, with the calm words, and asks for nothing more", async () => {
    const run = driver({ E003: { ok: false, stop: true, message: SPEND_LIMIT } });

    const end = await driveInboxRun(plan, run.driver);

    expect(run.asked).toEqual(["E003"]);
    expect(endMessage(end)).toEqual({ text: SPEND_LIMIT, problem: true });
  });

  it("starts no further email once Stop is pressed", async () => {
    const run = driver({}, "E003");

    const end = await driveInboxRun(plan, run.driver);

    expect(run.asked).toEqual(["E003"]);
    expect(endMessage(end)).toEqual({ text: STOPPED_BY_YOU, problem: false });
  });
});
