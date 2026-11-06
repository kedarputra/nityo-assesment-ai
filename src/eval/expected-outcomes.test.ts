import { describe, expect, it } from "vitest";
import { parseExpectedOutcomes, readExpectedOutcomes } from "./expected-outcomes";

describe("the expected outcomes, read from the walkthrough", () => {
  const expected = readExpectedOutcomes();

  it("has one row per email, in run order, with each primary outcome", () => {
    expect(expected.emails).toHaveLength(40);
    expect(expected.emails.slice(0, 3).map((email) => email.emailId)).toEqual(["E001", "E002", "E003"]);
    expect(expected.emails[15]?.emailId).toBe("E033");

    const counts = new Map<string, number>();
    for (const email of expected.emails) counts.set(email.outcome, (counts.get(email.outcome) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toEqual({ released: 9, proposal: 22, routed: 6, no_action: 3 });
  });

  it("reads the also-acceptable outcome and the review-reason codes", () => {
    const byId = new Map(expected.emails.map((email) => [email.emailId, email]));
    expect(byId.get("E002")).toMatchObject({ outcome: "released", alsoAcceptable: ["proposal"], reviewReasons: [] });
    expect(byId.get("E005")).toMatchObject({ outcome: "proposal", alsoAcceptable: ["released"] });
    expect(byId.get("E007")?.reviewReasons).toEqual(["HARD-credit-hold", "HARD-credit-limit"]);
    expect(byId.get("E027")).toMatchObject({
      outcome: "proposal",
      alsoAcceptable: [],
      reviewReasons: ["HARD-credit-hold", "HARD-credit-limit", "ROUTE-inquiry"],
    });
    expect(byId.get("E016")).toMatchObject({ outcome: "no_action", reviewReasons: ["P6-duplicate"] });
  });

  it("reads the Eval lines CSV, with prices in cents and alternatives split", () => {
    expect(expected.lines).toHaveLength(77);
    expect(expected.lines[0]).toEqual({
      emailId: "E001",
      request: "new_order",
      shipToId: "S001",
      skus: ["HPS-1408"],
      quantity: 4,
      unitPriceCents: 4500,
      outcome: "released",
    });
    const e010Napkins = expected.lines.find((line) => line.emailId === "E010" && line.skus[0] === "HPS-1409");
    expect(e010Napkins?.quantity).toBe(1);
    const e017 = expected.lines.find((line) => line.emailId === "E017");
    expect(e017).toMatchObject({ quantity: -20, unitPriceCents: 3900 });
    const e035 = expected.lines.find((line) => line.emailId === "E035");
    expect(e035?.skus).toEqual(["HPS-1001", "HPS-1002", "HPS-1003"]);
  });

  it("refuses a file whose summary table it cannot read, rather than score against nothing", () => {
    expect(() => parseExpectedOutcomes("# no tables here\n")).toThrow(/summary table/);
  });
});
