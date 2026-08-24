import { describe, expect, it } from "vitest";
import { RISK_LEVELS } from "./risk.ts";

describe("the risk vocabulary is ordered most severe first", () => {
  it("pins the exact order, not just the membership", () => {
    // Membership alone is not enough. This list existed twice with the SAME
    // four members in OPPOSITE orders — approvals descending, evidence
    // ascending — and unifying them reversed one side. Nothing read it
    // positionally at the time, so nothing broke. A test that only checked
    // membership would have permitted that reversal silently, and permitted the
    // next one too.
    expect([...RISK_LEVELS]).toEqual(["critical", "high", "medium", "low"]);
  });

  it("orders by descending severity, so a lower index is more severe", () => {
    // Stated as the property rather than the literal, so the intent survives a
    // future member being added in the right place.
    const severity = (level: string) => RISK_LEVELS.indexOf(level as never);
    expect(severity("critical")).toBeLessThan(severity("high"));
    expect(severity("high")).toBeLessThan(severity("medium"));
    expect(severity("medium")).toBeLessThan(severity("low"));
  });

  it("has no duplicate members", () => {
    expect(new Set(RISK_LEVELS).size).toBe(RISK_LEVELS.length);
  });
});
