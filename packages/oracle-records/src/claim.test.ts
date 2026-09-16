import { describe, expect, it } from "vitest";
import { canonicalize } from "@getsimpledirect/vinci-contracts";
import {
  CLAIM_TYPES,
  claimRecordDigest,
  validateClaimRecord,
  type ClaimRecord,
} from "./index.ts";
import {
  reversed,
  validClaimRecord,
  validHypothesisClaim,
  validInferredClaim,
} from "./fixtures.test-helpers.ts";

/**
 * §5.5's claim record: CLM-03 and CLM-04.
 *
 * Every negative below changes exactly ONE field of a record that validates
 * without it, and asserts the exact path and code. A hand-written "invalid"
 * claim typically fails for three reasons at once, of which the intended one
 * may never be reached — and a test that only checks `ok === false` cannot tell
 * which of the three answered.
 */

function issuesOf(result: ReturnType<typeof validateClaimRecord>) {
  return result.ok ? [] : result.issues.map((i) => ({ path: i.path, code: i.code }));
}

describe("a claim record round-trips and identifies itself", () => {
  it("the three fixtures validate, and key order does not change their identity", () => {
    for (const build of [validClaimRecord, validHypothesisClaim, validInferredClaim]) {
      const parsed = validateClaimRecord(build());
      expect(issuesOf(parsed)).toEqual([]);
      if (!parsed.ok) continue;
      const shuffled = validateClaimRecord(reversed(build()));
      expect(shuffled.ok).toBe(true);
      if (shuffled.ok) expect(claimRecordDigest(shuffled.value)).toBe(claimRecordDigest(parsed.value));
      const reparsed = validateClaimRecord(JSON.parse(canonicalize(parsed.value)) as unknown);
      expect(reparsed.ok).toBe(true);
    }
  });

  it("every claim type in the vocabulary can be written as a valid record", () => {
    // A type nobody can construct is a type that does not exist. RECOMMENDATION
    // and HYPOTHESIS are the two a validator built around observations tends to
    // make unwritable.
    const built: Record<string, ClaimRecord> = {
      OBSERVED: validClaimRecord(),
      EXTERNALLY_REPORTED: { ...validClaimRecord(), claimId: "oracle-claim-4", claimType: "EXTERNALLY_REPORTED" },
      INFERRED: validInferredClaim(),
      HYPOTHESIS: validHypothesisClaim(),
      RECOMMENDATION: {
        ...validClaimRecord(),
        claimId: "oracle-claim-5",
        claimType: "RECOMMENDATION",
        sourceSpans: [],
        proposition: "The installed reader should be probed before the release.",
      },
    };
    expect(Object.keys(built).sort()).toEqual([...CLAIM_TYPES].sort());
    for (const [type, record] of Object.entries(built)) {
      expect(issuesOf(validateClaimRecord(record)), type).toEqual([]);
    }
  });
});

describe("CLM-03: an inference is not relabelled as a direct observation", () => {
  it("an OBSERVED claim carrying premises and reasoning is refused at /derivation", () => {
    const result = validateClaimRecord({
      ...validClaimRecord(),
      derivation: validInferredClaim().derivation,
    });
    expect(issuesOf(result)).toEqual([
      { path: "/derivation", code: "inference_labeled_as_observed" },
    ]);
  });

  it("POSITIVE CONTROL: the SAME derivation on an INFERRED claim is accepted", () => {
    // This is what makes the refusal above a rule about the TYPE rather than a
    // rule about the field: the identical subtree is admissible one label over.
    const result = validateClaimRecord({
      ...validClaimRecord(),
      claimType: "INFERRED",
      derivation: validInferredClaim().derivation,
    });
    expect(issuesOf(result)).toEqual([]);
  });

  it("an INFERRED claim with no derivation is refused at the same field", () => {
    const result = validateClaimRecord({ ...validInferredClaim(), derivation: null });
    expect(issuesOf(result)).toEqual([
      { path: "/derivation", code: "inference_without_derivation" },
    ]);
  });

  it("a derivation from no premises at all is refused", () => {
    const base = validInferredClaim();
    const derivation = base.derivation;
    if (derivation === null) throw new Error("the inferred fixture must carry a derivation");
    const result = validateClaimRecord({
      ...base,
      derivation: { ...derivation, premises: [] },
    });
    expect(issuesOf(result)).toEqual([
      { path: "/derivation/premises", code: "derivation_without_premises" },
    ]);
  });

  it("an OBSERVED claim with no source span is refused at /sourceSpans", () => {
    const result = validateClaimRecord({ ...validClaimRecord(), sourceSpans: [] });
    expect(issuesOf(result)).toEqual([
      { path: "/sourceSpans", code: "observation_without_source_span" },
    ]);
  });
});

describe("CLM-04: a hypothesis is not required to be true before it is investigated", () => {
  it("a HYPOTHESIS with NO source spans is VALID", () => {
    // The bug this guards against is a validator demanding source support for
    // the future outcome of a proposed experiment. Nothing has observed it yet;
    // that is what makes it a hypothesis.
    const record = validHypothesisClaim();
    expect(record.sourceSpans).toEqual([]);
    expect(issuesOf(validateClaimRecord(record))).toEqual([]);
  });

  it("but it must carry the test that would tell it apart", () => {
    const result = validateClaimRecord({ ...validHypothesisClaim(), discriminatingTest: null });
    expect(issuesOf(result)).toEqual([
      { path: "/discriminatingTest", code: "hypothesis_without_discriminating_test" },
    ]);
  });

  it("and the test names both arms: what would support it AND what would refute it", () => {
    const base = validHypothesisClaim();
    const test = base.discriminatingTest;
    if (test === null) throw new Error("the hypothesis fixture must carry a discriminating test");
    const result = validateClaimRecord({
      ...base,
      discriminatingTest: { ...test, wouldRefute: "   " },
    });
    expect(issuesOf(result)).toEqual([
      { path: "/discriminatingTest/wouldRefute", code: "required_field" },
    ]);
  });

  it("POSITIVE CONTROL: a HYPOTHESIS with spans is also valid, so the rule is not about emptiness", () => {
    const result = validateClaimRecord({
      ...validHypothesisClaim(),
      sourceSpans: [{ sourceId: "oracle-source-1", span: null }],
    });
    expect(issuesOf(result)).toEqual([]);
  });
});

describe("the scoping fields a claim cannot be read without", () => {
  it("an unknown claim type is refused, and refused alone", () => {
    const result = validateClaimRecord({ ...validClaimRecord(), claimType: "PROBABLY_TRUE" });
    expect(issuesOf(result)).toEqual([{ path: "/claimType", code: "unknown_claim_type" }]);
  });

  it("an applicability window that ends before it begins is refused", () => {
    const base = validClaimRecord();
    const result = validateClaimRecord({
      ...base,
      applicability: {
        ...base.applicability,
        applicableFrom: "2026-09-06T12:00:00.000Z",
        applicableUntil: "2026-09-06T11:00:00.000Z",
      },
    });
    expect(issuesOf(result)).toEqual([
      { path: "/applicability/applicableUntil", code: "inverted_window" },
    ]);
  });

  it("a span that ends before it starts is refused at the span, not at the claim", () => {
    const result = validateClaimRecord({
      ...validClaimRecord(),
      sourceSpans: [{ sourceId: "oracle-source-1", span: { startOffset: 480, endOffset: 120 } }],
    });
    expect(issuesOf(result)).toEqual([
      { path: "/sourceSpans/0/span/endOffset", code: "inverted_range" },
    ]);
  });
});
