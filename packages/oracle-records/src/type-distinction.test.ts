import { canonicalize } from "@getsimpledirect/vinci-contracts";
import { describe, expect, it } from "vitest";
import {
  parseOracleRecordJson,
  researchRequestDigest,
  sourceRecordDigest,
  validateAttestedEnvelope,
  validateResearchRequest,
  validateSourceRecord,
} from "./index.ts";
import {
  validFailedReadSource,
  validResearchRequest,
  validSourceRecord,
} from "./fixtures.test-helpers.ts";

/**
 * T06 — valid `0`, `false`, `null` and not-applicable retain distinct meaning,
 * while boolean-as-number, non-finite cost, negative cost, duplicate-key
 * ambiguity and an unknown discriminator are refused.
 *
 * Each refusal below is a valid fixture with ONE field changed, and each
 * asserts the exact code. The pairing matters more here than anywhere else in
 * this package: the claim is that these values MEAN different things, and a
 * schema that refused all of them would satisfy every negative and none of the
 * positives.
 */

const requestIssues = (input: unknown): { path: string; code: string }[] => {
  const result = validateResearchRequest(input);
  return result.ok ? [] : result.issues.map((i) => ({ path: i.path, code: i.code }));
};
const sourceIssues = (input: unknown): { path: string; code: string }[] => {
  const result = validateSourceRecord(input);
  return result.ok ? [] : result.issues.map((i) => ({ path: i.path, code: i.code }));
};

describe("T06 positive control: zero, false, null and not-applicable each keep their meaning", () => {
  it("a budget of zero is a value, and reaches the canonical bytes as one", () => {
    const request = validResearchRequest();
    const free = {
      ...request,
      hostResolved: {
        ...request.hostResolved,
        effort: { ...request.hostResolved.effort, budgetMicrousd: 0 },
      },
    };
    expect(requestIssues(free)).toEqual([]);
    expect(canonicalize(free)).toContain('"budgetMicrousd":0');
    // And it is a DIFFERENT record from the same request with a budget of one.
    const one = {
      ...free,
      hostResolved: {
        ...free.hostResolved,
        effort: { ...free.hostResolved.effort, budgetMicrousd: 1 },
      },
    };
    expect(researchRequestDigest(free)).not.toBe(researchRequestDigest(one));
  });

  it("an attention budget of zero means this request may not spend human attention", () => {
    const request = validResearchRequest();
    const silent = {
      ...request,
      hostResolved: {
        ...request.hostResolved,
        effort: {
          ...request.hostResolved.effort,
          attentionBudget: { interruptions: 0, decisions: 0 },
        },
      },
    };
    expect(requestIssues(silent)).toEqual([]);
    expect(canonicalize(silent)).toContain('"decisions":0,"interruptions":0');
  });

  it("false and null are different answers on the same field", () => {
    // `false`: the requested range was not the whole document. `null`: nothing
    // was obtained, so the question has no answer. Each is valid in exactly one
    // of the two records, and refused in the other.
    expect(sourceIssues(validSourceRecord())).toEqual([]);
    expect(validSourceRecord().coversEntireDocument).toBe(false);
    expect(sourceIssues(validFailedReadSource())).toEqual([]);
    expect(validFailedReadSource().coversEntireDocument).toBeNull();
    expect(sourceIssues({ ...validSourceRecord(), coversEntireDocument: null }).map((i) => i.code))
      .toEqual(["required_field"]);
    expect(sourceIssues({ ...validFailedReadSource(), coversEntireDocument: false }).map((i) => i.code))
      .toEqual(["document_coverage_claimed_without_content"]);
  });

  it("null and absent are different on a nullable reference", () => {
    const request = validResearchRequest();
    // null: the host considered the budget and there is none.
    expect(validateAttestedEnvelope({ ...request, budgetReservationRef: null }).ok).toBe(true);
    // absent: the host never considered it. Refused.
    const { budgetReservationRef: _dropped, ...without } = request;
    const missing = validateAttestedEnvelope(without);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.issues.map((i) => i.code)).toEqual(["required_field"]);
    // And the two are not the same record either.
    expect(canonicalize({ ...request, budgetReservationRef: null })).toContain(
      '"budgetReservationRef":null',
    );
  });

  it("not-applicable is a third state on a rights field, distinct from permitted and prohibited", () => {
    const record = validSourceRecord();
    const digests = new Set<string>();
    for (const trainingUse of ["permitted", "prohibited", "unknown"] as const) {
      const variant = { ...record, policy: { ...record.policy, trainingUse } };
      expect(sourceIssues(variant)).toEqual([]);
      digests.add(sourceRecordDigest(variant));
    }
    // INV-03: three records, three identities. If "unknown" collapsed into one
    // of the others, two of these would be the same bytes.
    expect(digests.size).toBe(3);
  });
});

describe("T06 negatives: each reaches its own mechanism", () => {
  it("refuses a boolean where a number belongs", () => {
    expect(requestIssues({ ...validResearchRequest(), policyVersion: true })).toEqual([
      { path: "/policyVersion", code: "invalid_type" },
    ]);
    // The reachability control: the same field with a real number is admitted,
    // and `1` is not simply "truthy" being accepted.
    expect(requestIssues({ ...validResearchRequest(), policyVersion: 1 })).toEqual([]);
  });

  it("refuses a non-finite cost BEFORE the canonicalizer is ever reached", () => {
    // NaN and Infinity cannot appear in JSON, so they arrive only through a
    // runtime object. `canonicalize` THROWS on them by design, and a throw from
    // an encoder is a worse answer than a refusal — so validation must refuse
    // them first. That ordering is what these assertions pin.
    //
    // The refusal comes from `toPlainRecord`, the shared inert-snapshot
    // boundary every validator in this repository enters through, which
    // rejects the whole record with `unsupported_value` at path "" and a
    // message naming the non-finite number. It is therefore EARLIER and less
    // specific than this package's own field rules: it names the record, not
    // the field. Asserting the message here is what keeps the test
    // discriminating — a record refused for some other reason would not carry
    // it. See DEVIATIONS in the work order: naming the field would mean
    // changing a frozen layer-0 boundary that five packages depend on.
    const request = validResearchRequest();
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const broken = {
        ...request,
        hostResolved: {
          ...request.hostResolved,
          effort: { ...request.hostResolved.effort, budgetMicrousd: value },
        },
      };
      const result = validateResearchRequest(broken);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.map((i) => ({ path: i.path, code: i.code }))).toEqual([
        { path: "", code: "unsupported_value" },
      ]);
      expect(result.issues[0]?.message).toContain("non-finite number");
      // The canonicalizer would have thrown on this same record, so the refusal
      // above is genuinely earlier and not merely a differently-worded throw.
      expect(() => canonicalize(broken)).toThrow();
      // And the digest function refuses from validation rather than throwing
      // out of the encoder.
      expect(() => researchRequestDigest(broken)).toThrow(/unsupported_value/);
    }
    // Positive control on the same field: a finite value is admitted.
    expect(requestIssues(request)).toEqual([]);
  });

  it("refuses a negative cost with a code of its own", () => {
    const request = validResearchRequest();
    const negative = {
      ...request,
      hostResolved: {
        ...request.hostResolved,
        effort: { ...request.hostResolved.effort, budgetMicrousd: -1 },
      },
    };
    // Not `invalid_type`: a negative integer is well-formed data that means
    // something impossible, and a consumer should be able to say so.
    expect(requestIssues(negative)).toEqual([
      { path: "/hostResolved/effort/budgetMicrousd", code: "negative_cost" },
    ]);
    // Negative zero does NOT reach that rule, and should not: the shared
    // snapshot boundary normalizes `-0` to `0` before any validator body runs,
    // which is what `canonicalize` would encode anyway. Pinned here because the
    // opposite behaviour — refusing it, or carrying it through — would give one
    // value two identities, and because a reader of `readCost` would otherwise
    // reasonably expect its negative branch to fire.
    const negativeZero = {
      ...request,
      hostResolved: {
        ...request.hostResolved,
        effort: { ...request.hostResolved.effort, budgetMicrousd: -0 },
      },
    };
    expect(requestIssues(negativeZero)).toEqual([]);
    expect(researchRequestDigest(negativeZero)).toBe(
      researchRequestDigest({
        ...request,
        hostResolved: {
          ...request.hostResolved,
          effort: { ...request.hostResolved.effort, budgetMicrousd: 0 },
        },
      }),
    );
  });

  it("refuses a duplicate JSON name rather than reading one of the two values", () => {
    const text = JSON.stringify(validSourceRecord());
    // Positive control FIRST: the unmodified document parses and validates, so
    // the refusal below is the duplicate and not a broken scanner.
    const clean = parseOracleRecordJson(text);
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(validateSourceRecord(clean.value).ok).toBe(true);

    const ambiguous = text.replace(
      '"completeness":"FULL_REQUESTED_RANGE"',
      '"completeness":"FULL_REQUESTED_RANGE","completeness":"NOT_OBTAINED"',
    );
    // JSON.parse reads this as NOT_OBTAINED; a decoder that keeps the first
    // name reads FULL_REQUESTED_RANGE. Both are "the record", and they are not
    // the same record.
    expect((JSON.parse(ambiguous) as Record<string, unknown>).completeness).toBe("NOT_OBTAINED");
    const result = parseOracleRecordJson(ambiguous);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => ({ path: i.path, code: i.code }))).toEqual([
      { path: "/completeness", code: "duplicate_json_key" },
    ]);
  });

  it("finds a duplicate name nested inside an object and inside an array", () => {
    const nested = JSON.stringify(validSourceRecord()).replace(
      '"encoding":"utf-8"',
      '"encoding":"utf-8","encoding":"latin-1"',
    );
    const result = parseOracleRecordJson(nested);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => ({ path: i.path, code: i.code }))).toEqual([
        { path: "/observation/encoding", code: "duplicate_json_key" },
      ]);
    }

    const inArray = JSON.stringify({
      ...validSourceRecord(),
      relationships: [
        { kind: "same_origin", sourceId: "oracle-source-2", sourceId2: 0 },
      ],
    }).replace('"sourceId2":0', '"kind":"derivative"');
    const arrayResult = parseOracleRecordJson(inArray);
    expect(arrayResult.ok).toBe(false);
    if (!arrayResult.ok) {
      expect(arrayResult.issues.map((i) => ({ path: i.path, code: i.code }))).toEqual([
        { path: "/relationships/0/kind", code: "duplicate_json_key" },
      ]);
    }
  });

  it("compares names after escape decoding, not byte for byte", () => {
    // `"a"` and `"a"` are the same name. A byte comparison would miss the
    // one spelling somebody with something to hide would actually use.
    const escaped = JSON.stringify(validSourceRecord()).replace(
      '"matchState":"MATCHED"',
      '"matchState":"MATCHED","\\u006datchState":"NO_MATCH"',
    );
    const result = parseOracleRecordJson(escaped);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe("duplicate_json_key");
  });

  it("does not mistake a string VALUE containing a colon for a name", () => {
    // The scanner's own reachability control. A locator like
    // `repo:vinci-contracts/...` is a value, and treating it as a name would
    // make this checker refuse every valid record in the package.
    expect(validSourceRecord().origin.locator).toContain(":");
    expect(parseOracleRecordJson(JSON.stringify(validSourceRecord())).ok).toBe(true);
    // Two array elements carrying the same key are not duplicates of each other.
    expect(
      parseOracleRecordJson(
        JSON.stringify({
          ...validSourceRecord(),
          relationships: [
            { kind: "same_origin", sourceId: "oracle-source-2" },
            { kind: "derivative", sourceId: "oracle-source-3" },
          ],
        }),
      ).ok,
    ).toBe(true);
  });

  it("distinguishes text that is not JSON from JSON that says two things", () => {
    expect(parseOracleRecordJson("{not json").ok).toBe(false);
    const notJson = parseOracleRecordJson("{not json");
    if (!notJson.ok) expect(notJson.issues.map((i) => i.code)).toEqual(["invalid_json"]);
    expect(parseOracleRecordJson(7).ok).toBe(false);
    const notText = parseOracleRecordJson(7);
    if (!notText.ok) expect(notText.issues.map((i) => i.code)).toEqual(["invalid_type"]);
  });

  it("refuses an unknown discriminator rather than matching it approximately", () => {
    // Three discriminators, three records, three dedicated codes. An unknown
    // value that fell through to the nearest known one is how a
    // CHECK_UNAVAILABLE becomes a SUPPORTED.
    expect(sourceIssues({ ...validSourceRecord(), readOutcome: "READ_MOSTLY" })).toEqual([
      { path: "/readOutcome", code: "unknown_read_outcome" },
    ]);
    const record = validSourceRecord();
    expect(
      sourceIssues({ ...record, observation: { ...record.observation, mode: "SORT_OF" } }),
    ).toEqual([{ path: "/observation/mode", code: "unknown_observation_mode" }]);
    expect(
      requestIssues({ ...validResearchRequest(), envelopeKind: "oracle_research_report" }),
    ).toEqual([{ path: "/envelopeKind", code: "unknown_envelope_kind" }]);
  });
});
