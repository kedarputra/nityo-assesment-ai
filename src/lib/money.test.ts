import { describe, expect, it } from "vitest";
import { formatUsd } from "./money";

describe("formatUsd", () => {
  it("shows integer cents as US dollars", () => {
    expect(formatUsd(67200)).toBe("$672.00");
    expect(formatUsd(318580)).toBe("$3,185.80");
  });
});
