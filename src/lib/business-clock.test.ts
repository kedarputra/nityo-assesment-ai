import { describe, expect, it } from "vitest";
import { businessDateOf, formatBusinessDay, formatBusinessTime } from "./business-clock";

describe("the business clock", () => {
  // E005's received_at in the data pack.
  const receivedAt = new Date("2026-11-02T07:26:00-05:00");

  it("shows a time as Harbor Point's own 24-hour clock", () => {
    expect(formatBusinessTime(receivedAt)).toBe("07:26");
  });

  it("shows a day as weekday, date and month", () => {
    expect(formatBusinessDay(receivedAt)).toBe("Mon 2 Nov");
  });

  it("gives the ISO calendar day at Harbor Point, even late in the evening there", () => {
    expect(businessDateOf(receivedAt)).toBe("2026-11-02");
    expect(businessDateOf(new Date("2026-11-02T23:30:00-05:00"))).toBe("2026-11-02");
  });
});
