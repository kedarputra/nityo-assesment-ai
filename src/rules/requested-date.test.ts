import { describe, expect, it } from "vitest";
import { resolveRequestedDate } from "./requested-date";

// The business clock: Mon 2 Nov 2026 (policy 1).
const today = "2026-11-02";

describe("resolveRequestedDate (U11)", () => {
  it.each([
    ["Thursday", "2026-11-05"],
    ["Wednesday", "2026-11-04"],
    ["for Friday", "2026-11-06"],
    ["this Saturday", "2026-11-07"],
    // A bare weekday is its next occurrence after today, so Monday is a week away.
    ["Monday", "2026-11-09"],
    ["TODAY", "2026-11-02"],
    ["tomorrow", "2026-11-03"],
    ["by Friday Nov 6 at the latest", "2026-11-06"],
    ["11/7", "2026-11-07"],
    ["7 November", "2026-11-07"],
    ["2026-11-12", "2026-11-12"],
  ])("reads %j as %s", (words, date) => {
    expect(resolveRequestedDate(words, today)).toEqual({ kind: "on", date, past: false });
  });

  it("records both dates for “next Tuesday”, which could be tomorrow or a week later", () => {
    expect(resolveRequestedDate("Delivery next Tuesday please", today)).toEqual({
      kind: "ambiguous",
      dates: ["2026-11-03", "2026-11-10"],
      reason: "“next Tuesday” could be Tue 3 Nov or Tue 10 Nov",
    });
  });

  it("marks a date before today as past (E032)", () => {
    expect(resolveRequestedDate("by Friday October 30", today)).toEqual({ kind: "on", date: "2026-10-30", past: true });
  });

  it("is ambiguous when the weekday and the date disagree", () => {
    expect(resolveRequestedDate("Thursday Nov 6", today)).toEqual({
      kind: "ambiguous",
      dates: ["2026-11-05", "2026-11-06"],
      reason: "“Thursday Nov 6”: 6 Nov is a Friday",
    });
  });

  it("does not guess at words it cannot read", () => {
    expect(resolveRequestedDate("whenever suits", today)).toEqual({ kind: "unreadable" });
    expect(resolveRequestedDate("February 30", today)).toEqual({ kind: "unreadable" });
    expect(resolveRequestedDate("when you're satisfied", today)).toEqual({ kind: "unreadable" });
  });
});
