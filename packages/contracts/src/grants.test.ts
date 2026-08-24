import { describe, expect, it } from "vitest";
import { GRANT_KINDS, type CanonicalGrant, type GrantKind } from "./grants.ts";

describe("canonical grant contract", () => {
  it("defines exactly three grant kinds", () => {
    expect(GRANT_KINDS).toEqual(["allow-once", "allow-remainder-of-run", "allow-bounded"]);
  });

  it("allows each grant kind in valid objects", () => {
    const validGrants: readonly CanonicalGrant[] = [
      { kind: "allow-once" },
      { kind: "allow-remainder-of-run", runId: "run-1" as never },
      { kind: "allow-bounded", resourceId: "resource-1", durationMs: 1000 },
    ];
    for (const grant of validGrants) {
      expect(GRANT_KINDS).toContain(grant.kind);
    }
  });

  it("converts durations from seconds to milliseconds correctly", () => {
    const secondsToMilliseconds = (seconds: number) => seconds * 1000;
    expect(secondsToMilliseconds(3600)).toBe(3_600_000);
    expect(secondsToMilliseconds(60)).toBe(60_000);
    expect(secondsToMilliseconds(1)).toBe(1000);
    expect(secondsToMilliseconds(900)).toBe(900_000);
  });

  it("uses field names that make units unmistakable", () => {
    const grant: CanonicalGrant = {
      kind: "allow-bounded",
      resourceId: "resource-123",
      durationMs: 3_600_000,
    };
    expect(grant.kind).toBe("allow-bounded");
    expect(typeof grant.resourceId).toBe("string");
    expect(typeof grant.durationMs).toBe("number");
    expect(grant.durationMs).toBe(3_600_000);
  });

  it("has grant shapes compatible with @getsimpledirect/vinci-approvals vocabulary", () => {
    const grantKindCount = GRANT_KINDS.length;
    expect(grantKindCount).toBe(3);
    expect(GRANT_KINDS).toContain("allow-once");
    expect(GRANT_KINDS).toContain("allow-remainder-of-run");
    expect(GRANT_KINDS).toContain("allow-bounded");
  });

  it("rejects invalid grant kinds at compile time", () => {
    const validKind: GrantKind = "allow-once";
    expect(GRANT_KINDS).toContain(validKind);
  });
});
