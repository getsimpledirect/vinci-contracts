import { describe, expect, it } from "vitest";
import { assertSchemaMetaComplete } from "@vinci/contracts";
import {
  countsAgainstSubmittedWork,
  isProvenanceConsistent,
  EVIDENCE_RECORD_SCHEMA_META,
  VERDICT_ASSESSMENT_SCHEMA_META,
  FAILURE_OWNERS,
  countsAgainstSubmittedWork,
  validateVerdictRecord,
  isProvenanceConsistent,
  verdictAssessmentFor,
  validateEvidenceRecord,
  validateVerdictAssessment,
} from "./index.ts";

const validEvidenceRecord = () => ({
  schemaVersion: 1,
  id: "evidence-1",
  attestation: {
    provenance: "worker_provided",
    actor: { kind: "worker", workerId: "worker-1" },
  },
  kind: "unit_test",
  mode: "execution",
  reliability: "strong",
  sourceKind: "runner",
  assessment: { outcome: "supports" },
  notTested: [],
  summary: "All unit tests passed",
  recordedAt: "2026-08-23T12:34:56.789Z",
});

function expectIssue(
  result: ReturnType<typeof validateEvidenceRecord> | ReturnType<typeof validateVerdictAssessment>,
  path: string,
  code: string,
): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.issues).toContainEqual(expect.objectContaining({ path, code }));
  }
}

describe("validateEvidenceRecord", () => {
  it("accepts a complete record without changing its value", () => {
    const input = validEvidenceRecord();
    const result = validateEvidenceRecord(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(input);
      expect(result.unknownFields).toEqual({});
    }
  });

  it("rejects a missing required field at its JSON pointer", () => {
    const { summary: _summary, ...input } = validEvidenceRecord();

    expectIssue(validateEvidenceRecord(input), "/summary", "required_field");
  });

  it("rejects a field with the wrong type at its JSON pointer", () => {
    expectIssue(
      validateEvidenceRecord({ ...validEvidenceRecord(), recordedAt: 42 }),
      "/recordedAt",
      "invalid_timestamp",
    );
  });

  it("rejects an invalid schema version", () => {
    expectIssue(
      validateEvidenceRecord({ ...validEvidenceRecord(), schemaVersion: 2 }),
      "/schemaVersion",
      "invalid_literal",
    );
  });

  it.each([
    ["kind", "future_evidence", "/kind"],
    ["mode", "probabilistic", "/mode"],
    ["reliability", "perfect", "/reliability"],
    ["sourceKind", "manual", "/sourceKind"],
  ] as const)("rejects an invalid %s enum value", (field, value, path) => {
    expectIssue(
      validateEvidenceRecord({ ...validEvidenceRecord(), [field]: value }),
      path,
      "invalid_enum",
    );
  });

  it("rejects an invalid attestation provenance enum value", () => {
    expectIssue(
      validateEvidenceRecord({
        ...validEvidenceRecord(),
        attestation: {
          ...validEvidenceRecord().attestation,
          provenance: "self_asserted",
        },
      }),
      "/attestation/provenance",
      "invalid_enum",
    );
  });

  it("rejects an invalid actor kind enum value", () => {
    expectIssue(
      validateEvidenceRecord({
        ...validEvidenceRecord(),
        attestation: {
          provenance: "worker_provided",
          actor: { kind: "robot", workerId: "worker-1" },
        },
      }),
      "/attestation/actor/kind",
      "invalid_enum",
    );
  });

  it("preserves unknown fields verbatim at their JSON pointers", () => {
    const futureValue = { nested: [1, "two", { three: true }] };
    const result = validateEvidenceRecord({
      ...validEvidenceRecord(),
      futureEvidence: futureValue,
      attestation: {
        ...validEvidenceRecord().attestation,
        futureAttestation: "kept",
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.unknownFields["/futureEvidence"]).toEqual(futureValue);
      expect(result.unknownFields["/attestation/futureAttestation"]).toBe("kept");
      expect(result.value).toHaveProperty("futureEvidence");
    }
  });
});

describe("validateVerdictAssessment", () => {
  it("accepts a current assessment and returns its status", () => {
    const input = { kind: "current", status: "VERIFIED_PASS" };
    const result = validateVerdictAssessment(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("current");
      if (result.value.kind === "current") {
        expect(result.value.status).toBe("VERIFIED_PASS");
      }
    }
  });

  it("accepts a stale assessment and returns its triggers", () => {
    const input = {
      kind: "stale",
      reason: "policy changed",
      triggers: ["policy_configuration_changed"],
    };
    const result = validateVerdictAssessment(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("stale");
      if (result.value.kind === "stale") {
        expect(result.value.reason).toBe("policy changed");
        expect(result.value.triggers).toEqual(["policy_configuration_changed"]);
      }
    }
  });

  it("rejects an invalid discriminator enum value", () => {
    expectIssue(validateVerdictAssessment({ kind: "expired" }), "/kind", "invalid_enum");
  });

  it("rejects a verdict status outside the declared union", () => {
    expectIssue(
      validateVerdictAssessment({ kind: "current", status: "FAILED" }),
      "/status",
      "invalid_enum",
    );
  });

  it("rejects a staleness trigger outside the declared union", () => {
    expectIssue(
      validateVerdictAssessment({
        kind: "stale",
        reason: "changed",
        triggers: ["time_travel"],
      }),
      "/triggers/0",
      "invalid_enum",
    );
  });

  it("rejects a missing field required by the selected union arm", () => {
    expectIssue(
      validateVerdictAssessment({ kind: "stale", triggers: ["mutation_any"] }),
      "/reason",
      "required_field",
    );
  });

  it("refuses an unknown field rather than preserving it", () => {
    // This test previously asserted the opposite, and passed — while the
    // package's own SchemaMeta declared unknownFields: "reject". The test and
    // the metadata contradicted each other and nothing noticed, because each
    // was checked against the code separately and never against the other.
    //
    // Assessments are the exception to D4's preserve rule for the same reason
    // credentials are: what an unrecognised field might carry is worse than
    // what is lost by refusing it. Here that is a field like `verified: true`
    // riding along with a stale record.
    const result = validateVerdictAssessment({
      kind: "current",
      status: "CONDITIONAL",
      futureAssessment: { confidence: 0.95 },
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((i) => i.code === "unknown_assessment_field")).toBe(true);
  });
});

describe("a worker cannot vouch for itself as an independent verifier", () => {
  // Architectural principle 2: the worker does not issue its own verdict.
  // FR-6.3: receipts must distinguish worker-provided from independent-verifier
  // evidence. Neither holds if a record can simply assert the distinction —
  // provenance and actor were validated as two unrelated enums, so nothing
  // connected the claim to who actually made it.
  const record = (attestation: unknown) => ({ ...validEvidenceRecord(), attestation });

  it("refuses independent-verifier provenance from a worker", () => {
    const result = validateEvidenceRecord(
      record({ provenance: "independent_verifier", actor: { kind: "worker", workerId: "worker-1" } }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((i) => i.code === "provenance_actor_mismatch")).toBe(true);
  });

  it("refuses independent-verifier provenance from a verifier that is not independent", () => {
    // FR-7.3 allows the same model to work and verify, but requires the product
    // to DISCLOSE that the verifier is not independent. Letting the record
    // claim independence hides exactly what must be disclosed.
    const result = validateEvidenceRecord(
      record({
        provenance: "independent_verifier",
        actor: { kind: "verifier", verifierId: "v-1", independent: false },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((i) => i.code === "verifier_not_independent")).toBe(true);
  });

  it("accepts an actually independent verifier", () => {
    expect(
      validateEvidenceRecord(
        record({
          provenance: "independent_verifier",
          actor: { kind: "verifier", verifierId: "v-1", independent: true },
        }),
      ).ok,
    ).toBe(true);
  });

  it("pairs every provenance case with exactly one actor kind", () => {
    const pairs = [
      ["worker_provided", { kind: "worker", workerId: "w-1" }],
      ["system_observed", { kind: "system", component: "runner" }],
      ["human_provided", { kind: "user", userId: "u-1" }],
      ["independent_verifier", { kind: "verifier", verifierId: "v-1", independent: true }],
    ] as const;
    for (const [provenance, actor] of pairs) {
      expect(validateEvidenceRecord(record({ provenance, actor })).ok, provenance).toBe(true);
    }
    // and every mismatched pairing is refused
    for (const [provenance] of pairs) {
      for (const [, actor] of pairs) {
        const result = validateEvidenceRecord(record({ provenance, actor }));
        const matches = pairs.find(([p]) => p === provenance)?.[1] === actor;
        expect(result.ok, `${provenance} with ${actor.kind}`).toBe(matches);
      }
    }
  });
});

describe("a stale assessment cannot carry a live pass", () => {
  it("refuses a stale assessment that also has a status", () => {
    // The discriminant said stale; the payload said VERIFIED_PASS, and the
    // value round-tripped intact for any reader that did not know to ignore it.
    const result = validateVerdictAssessment({
      kind: "stale",
      status: "VERIFIED_PASS",
      reason: "files changed",
      triggers: ["mutation_any"],
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((i) => i.code === "field_not_valid_for_kind")).toBe(true);
  });

  it("refuses a current assessment carrying staleness fields", () => {
    const result = validateVerdictAssessment({
      kind: "current",
      status: "VERIFIED_PASS",
      reason: "files changed",
    });
    expect(result.ok).toBe(false);
  });
});

describe("timestamps", () => {
  it("refuses a date that does not exist", () => {
    // 2026 is not a leap year. Date.parse normalises this to March 1 rather
    // than rejecting it, so the round-trip comparison is what catches it —
    // and is what makes evidence agree with model-classes and approvals.
    const result = validateEvidenceRecord({
      ...validEvidenceRecord(),
      recordedAt: "2026-02-29T12:34:56.789Z",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((i) => i.code === "invalid_timestamp")).toBe(true);
  });

  it("still accepts a real one", () => {
    expect(validateEvidenceRecord(validEvidenceRecord()).ok).toBe(true);
  });
});

describe("schema metadata", () => {
  it("answers the six questions for every schema this package exports", () => {
    // The evidence package was the only one without a meta conformance test,
    // and VerdictAssessment had no SchemaMeta at all.
    for (const meta of [EVIDENCE_RECORD_SCHEMA_META, VERDICT_ASSESSMENT_SCHEMA_META]) {
      expect(() => assertSchemaMetaComplete(meta)).not.toThrow();
    }
  });
});

describe("independence cannot be claimed around the guard", () => {
  const base = () => validEvidenceRecord();

  it("refuses an actor carrying another kind's identity", () => {
    // kind:"verifier", independent:true, AND a workerId — a worker wearing a
    // verifier's label. It validated.
    const result = validateEvidenceRecord({
      ...base(),
      attestation: {
        provenance: "independent_verifier",
        actor: { kind: "verifier", verifierId: "v-1", independent: true, workerId: "w-1" },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((i) => i.code === "actor_identity_mismatch")).toBe(true);
  });

  it("keeps isProvenanceConsistent agreeing with the validator", () => {
    // This exported helper returned true for a verifier with
    // independent: false — an alternate path that agreed on the actor kind and
    // disagreed on the thing that matters.
    const notIndependent = { kind: "verifier", verifierId: "v-1", independent: false } as const;
    expect(isProvenanceConsistent("independent_verifier", notIndependent)).toBe(false);
    const independent = { kind: "verifier", verifierId: "v-1", independent: true } as const;
    expect(isProvenanceConsistent("independent_verifier", independent)).toBe(true);

    // The two must not be able to disagree: whatever the helper permits, the
    // validator must permit, and vice versa.
    for (const actor of [notIndependent, independent]) {
      const viaValidator = validateEvidenceRecord({
        ...base(),
        attestation: { provenance: "independent_verifier", actor },
      }).ok;
      expect(viaValidator).toBe(isProvenanceConsistent("independent_verifier", actor));
    }
  });
});

describe("an assessment carries only what it declares", () => {
  it("rejects an unknown field instead of preserving it", () => {
    // The metadata said reject; the validator preserved. An unrecognised field
    // like `verified: true` sat alongside a stale record for any reader that
    // did not know to ignore it.
    const result = validateVerdictAssessment({
      kind: "stale",
      reason: "r",
      triggers: ["mutation_any"],
      verified: true,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((i) => i.code === "unknown_assessment_field")).toBe(true);
  });

  it("behaves the way its metadata says it does", () => {
    // The claim and the behaviour are asserted together, so they cannot drift
    // apart the way they just did.
    expect(VERDICT_ASSESSMENT_SCHEMA_META.unknownFields).toBe("reject");
    const withUnknown = validateVerdictAssessment({
      kind: "current",
      status: "VERIFIED_PASS",
      somethingNew: 1,
    });
    expect(withUnknown.ok).toBe(false);
  });

  it("rejects a cross-arm field even when its value is undefined", () => {
    expect(validateVerdictAssessment({ kind: "stale", reason: "r", triggers: ["mutation_any"], status: undefined }).ok).toBe(false);
    expect(validateVerdictAssessment({ kind: "current", status: "VERIFIED_PASS", triggers: undefined }).ok).toBe(false);
  });
});

describe("the helper and the validator cannot disagree", () => {
  // The previous version of this test varied only the independence flag and
  // declared the two functions equivalent. It passed while they diverged on
  // foreign identity fields — a verifier carrying a workerId, where the helper
  // said consistent and the validator refused.
  //
  // Vary everything: every provenance case against every actor shape,
  // including the malformed ones.
  const ACTORS = [
    { kind: "worker", workerId: "w-1" },
    { kind: "system", component: "runner" },
    { kind: "user", userId: "u-1" },
    { kind: "verifier", verifierId: "v-1", independent: true },
    { kind: "verifier", verifierId: "v-1", independent: false },
    // cross-contaminated shapes, one per arm
    { kind: "worker", workerId: "w-1", independent: true },
    { kind: "verifier", verifierId: "v-1", independent: true, workerId: "w-1" },
    { kind: "user", userId: "u-1", policyVersion: 2 },
    { kind: "system", component: "runner", verifierId: "v-1" },
  ] as const;

  const PROVENANCES = [
    "worker_provided",
    "system_observed",
    "human_provided",
    "independent_verifier",
  ] as const;

  it.each(PROVENANCES)("agrees with the validator for %s, across every actor shape", (provenance) => {
    for (const actor of ACTORS) {
      const viaValidator = validateEvidenceRecord({
        ...validEvidenceRecord(),
        attestation: { provenance, actor },
      }).ok;
      const viaHelper = isProvenanceConsistent(provenance, actor as never);
      expect(viaHelper, `${provenance} + ${JSON.stringify(actor)}`).toBe(viaValidator);
    }
  });

  it("refuses a worker that asserts its own independence", () => {
    // The hand-written foreign-field list omitted `independent`.
    const result = validateEvidenceRecord({
      ...validEvidenceRecord(),
      attestation: { provenance: "worker_provided", actor: { kind: "worker", workerId: "w-1", independent: true } },
    });
    expect(result.ok).toBe(false);
  });
});

describe("a stale assessment must say why", () => {
  it("refuses an empty trigger list", () => {
    // FR-7.4 enumerates the staleness conditions so a stale verdict stays
    // useful as history. Naming none records nothing.
    expect(validateVerdictAssessment({ kind: "stale", reason: "r", triggers: [] }).ok).toBe(false);
  });

  it("no longer lets a caller fabricate a contentless staleness record", () => {
    // The old signature took a boolean and invented reason:"stale", triggers:[].
    const current = verdictAssessmentFor("VERIFIED_PASS", null);
    expect(current.ok).toBe(true);

    const stale = verdictAssessmentFor("VERIFIED_PASS", {
      reason: "the artifact digest changed after the verdict was issued",
      triggers: ["artifact_digest_changed"],
    });
    expect(stale.ok).toBe(true);
    expect(stale.ok && stale.value.kind === "stale" && stale.value.triggers.length).toBeGreaterThan(0);
  });
});

describe("the constructor cannot manufacture what the validator refuses", () => {
  it("refuses a staleness record with no reason and no triggers", () => {
    // This constructed cleanly and then failed the package's own validator —
    // a second, unchecked way into the type.
    const result = verdictAssessmentFor("VERIFIED_PASS", { reason: "", triggers: [] });
    expect(result.ok).toBe(false);
  });

  it("round-trips: anything it builds, the validator accepts", () => {
    const cases = [
      null,
      { reason: "files changed", triggers: ["mutation_any"] },
      { reason: "digest changed", triggers: ["artifact_digest_changed"] },
    ] as const;
    for (const staleness of cases) {
      const built = verdictAssessmentFor("VERIFIED_PASS", staleness as never);
      expect(built.ok, JSON.stringify(staleness)).toBe(true);
      if (built.ok) expect(validateVerdictAssessment(built.value).ok).toBe(true);
    }
  });

  it("does not share the caller's triggers array", () => {
    // Emptying the caller's array afterwards emptied the assessment's, turning
    // a valid record into one recording no reason for staleness.
    const triggers: string[] = ["artifact_digest_changed"];
    const built = verdictAssessmentFor("VERIFIED_PASS", { reason: "r", triggers: triggers as never });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    triggers.length = 0;
    expect(built.value.kind === "stale" && built.value.triggers.length).toBe(1);
    expect(Object.isFrozen(built.value)).toBe(true);
  });
});

describe("a failure cannot be recorded without saying whose it is", () => {
  // The difference between an evaluator worth having and one that is worse than
  // nothing. Reporting a broken container or a missing credential as a defect
  // in the submitted work does not merely fail to help — it teaches people to
  // stop believing verdicts, and a false accusation is paid every time.
  const withAssessment = (assessment: unknown) =>
    validateEvidenceRecord({ ...validEvidenceRecord(), assessment });

  it("refuses a contradicting outcome with no owner", () => {
    const result = withAssessment({ outcome: "contradicts" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((i) => i.code === "failure_owner_required")).toBe(true);
  });

  it("refuses an invalid outcome with no owner", () => {
    expect(withAssessment({ outcome: "invalid" }).ok).toBe(false);
  });

  it("accepts a failure that names its owner", () => {
    for (const failureOwner of FAILURE_OWNERS) {
      expect(withAssessment({ outcome: "contradicts", failureOwner }).ok, failureOwner).toBe(true);
    }
  });

  it("refuses a failure owner on a non-failing outcome", () => {
    // "supports, and by the way someone is at fault" is not a coherent record.
    expect(withAssessment({ outcome: "supports", failureOwner: "submitted_work" }).ok).toBe(false);
  });

  it("counts only submitted_work against the author", () => {
    // Infrastructure breakage must never read as a defect in the work.
    expect(countsAgainstSubmittedWork({ outcome: "contradicts", failureOwner: "submitted_work" })).toBe(true);
    for (const owner of ["vinci_infrastructure", "missing_access", "unclear_requirement"] as const) {
      expect(countsAgainstSubmittedWork({ outcome: "contradicts", failureOwner: owner }), owner).toBe(false);
    }
    expect(countsAgainstSubmittedWork({ outcome: "supports" })).toBe(false);
    expect(countsAgainstSubmittedWork({ outcome: "inconclusive" })).toBe(false);
  });

  it("treats inconclusive as not-a-failure", () => {
    // Reporting an inconclusive check as a contradiction is how a flaky test
    // becomes a rejected pull request.
    expect(withAssessment({ outcome: "inconclusive" }).ok).toBe(true);
    expect(countsAgainstSubmittedWork({ outcome: "inconclusive" })).toBe(false);
  });
});

describe("what was not checked has to be said", () => {
  const withNotTested = (notTested: unknown) =>
    validateEvidenceRecord({ ...validEvidenceRecord(), notTested });

  it("accepts an empty list, meaning everything in scope was checked", () => {
    expect(withNotTested([]).ok).toBe(true);
  });

  it("requires a reason, because 'not tested' alone is indistinguishable from an oversight", () => {
    expect(withNotTested([{ description: "the migration path" }]).ok).toBe(false);
    expect(withNotTested([{ description: "the migration path", reason: "" }]).ok).toBe(false);
    expect(
      withNotTested([{ description: "the migration path", reason: "no staging database available" }]).ok,
    ).toBe(true);
  });

  it("refuses an entry carrying anything else", () => {
    expect(
      withNotTested([{ description: "d", reason: "r", severity: "low" }]).ok,
    ).toBe(false);
  });
});

describe("a verdict cannot claim more than its evidence supports", () => {
  const verdict = (o: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    status: "VERIFIED_PASS",
    snapshotDigest: "a".repeat(64),
    summary: "The requested endpoint behaves as specified",
    scope: "the /orders endpoint at commit abc123, by execution",
    criterionResults: [
      { criterionId: "c-1", status: "supported", summary: "returns 404 for unknown ids", evidenceIds: ["e-1"] },
    ],
    decisiveEvidenceIds: ["e-1"],
    unresolvedConditions: [],
    residualRisks: [],
    notTested: [],
    policyVersion: "policy-v3",
    evaluatorVersion: "acceptance-2026.08",
    issuedAt: "2026-08-23T12:34:56.789Z",
    expiresAt: null,
    staleWhen: [],
    ...o,
  });

  it("accepts a pass whose criteria are all supported", () => {
    expect(validateVerdictRecord(verdict()).ok).toBe(true);
  });

  it("refuses VERIFIED_PASS while a criterion is contradicted", () => {
    // Something was found not to work and the verdict says it all works.
    const result = validateVerdictRecord(
      verdict({
        criterionResults: [
          { criterionId: "c-1", status: "contradicted", summary: "returns 500", evidenceIds: ["e-1"] },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((i) => i.code === "unearned_pass")).toBe(true);
  });

  it("refuses VERIFIED_PASS while a criterion is unknown", () => {
    // Unknown means the check ran and settled nothing. Treating that as passing
    // is issuing confidence that was not earned.
    expect(
      validateVerdictRecord(
        verdict({
          criterionResults: [
            { criterionId: "c-1", status: "unknown", summary: "could not reach the service", evidenceIds: ["e-1"] },
          ],
        }),
      ).ok,
    ).toBe(false);
  });

  it("permits CONDITIONAL and BLOCKED to carry the same results", () => {
    // Those statuses exist precisely for "holds with caveats" and "could not be
    // settled", so the same criteria must be expressible under them.
    for (const status of ["CONDITIONAL", "BLOCKED"] as const) {
      expect(
        validateVerdictRecord(
          verdict({
            status,
            criterionResults: [
              { criterionId: "c-1", status: "contradicted", summary: "returns 500", evidenceIds: ["e-1"] },
            ],
          }),
        ).ok,
        status,
      ).toBe(true);
    }
  });

  it("refuses a criterion result citing no evidence", () => {
    // A conclusion resting on nothing is an opinion.
    expect(
      validateVerdictRecord(
        verdict({
          criterionResults: [
            { criterionId: "c-1", status: "supported", summary: "looks fine", evidenceIds: [] },
          ],
        }),
      ).ok,
    ).toBe(false);
  });

  it("requires a scope, because a verdict that will not say what it covers claims everything", () => {
    for (const scope of ["", "   ", undefined]) {
      expect(validateVerdictRecord(verdict({ scope })).ok, String(scope)).toBe(false);
    }
  });

  it("requires the snapshot digest that binds it to what it examined", () => {
    expect(validateVerdictRecord(verdict({ snapshotDigest: "not-a-digest" })).ok).toBe(false);
  });

  it("refuses an unknown field and a bad status", () => {
    expect(validateVerdictRecord(verdict({ extra: 1 })).ok).toBe(false);
    // FAILED and CANCELLED are job terminations, not assessments.
    expect(validateVerdictRecord(verdict({ status: "FAILED" })).ok).toBe(false);
  });
});

describe("a required string must carry content, not just length", () => {
  it("accepts the valid record unchanged", () => {
    // Positive control. Every negative case below mutates exactly one field of
    // this record, so a failure localises rather than meaning "something else
    // in a fifteen-field fixture broke".
    expect(validateEvidenceRecord(validEvidenceRecord()).ok).toBe(true);
  });

  it("rejects a blank id or summary", () => {
    for (const blank of ["   ", "\t", "\n", " "]) {
      expect(
        validateEvidenceRecord({ ...validEvidenceRecord(), id: blank }).ok,
        `id=${JSON.stringify(blank)}`,
      ).toBe(false);
      expect(
        validateEvidenceRecord({ ...validEvidenceRecord(), summary: blank }).ok,
        `summary=${JSON.stringify(blank)}`,
      ).toBe(false);
    }
  });

  it("rejects a blank actor identifier", () => {
    // A blank workerId passed a typeof check and a length check while being
    // attributable to nobody — on the field that says who produced the
    // evidence, which is the whole point of an attestation.
    const record = {
      ...validEvidenceRecord(),
      attestation: {
        provenance: "worker_provided",
        actor: { kind: "worker", workerId: "   " },
      },
    };
    expect(validateEvidenceRecord(record).ok).toBe(false);
  });

  it("still accepts identifiers with internal or surrounding content", () => {
    // The check is trim-based, so it must not reject a legitimate value that
    // merely contains whitespace.
    const record = { ...validEvidenceRecord(), summary: "ran 3 tests, all passed" };
    expect(validateEvidenceRecord(record).ok).toBe(true);
  });
});

describe("attribution predicates decide from own data", () => {
  it("refuses an outcome whose fields are inherited", () => {
    // Attribution decided from a prototype is attribution nobody wrote.
    const inherited = Object.create({ outcome: "contradicts", failureOwner: "submitted_work" });
    expect(Object.keys(inherited)).toEqual([]);
    expect(countsAgainstSubmittedWork(inherited)).toBe(false);
  });

  it("refuses hostile input instead of throwing", () => {
    for (const hostile of [
      null, undefined, "contradicts", 7, new Array(1),
      { get outcome() { return "contradicts"; }, failureOwner: "submitted_work" },
      new Proxy({}, { get() { throw new Error("t"); } }),
    ]) {
      expect(() => countsAgainstSubmittedWork(hostile as never)).not.toThrow();
      expect(countsAgainstSubmittedWork(hostile as never)).toBe(false);
    }
  });

  it("still attributes genuine failures", () => {
    // Positive controls. Returning false for everything would silently
    // exonerate all broken work, which is the failure that matters most here.
    expect(countsAgainstSubmittedWork({ outcome: "contradicts", failureOwner: "submitted_work" })).toBe(true);
    expect(countsAgainstSubmittedWork({ outcome: "invalid", failureOwner: "submitted_work" })).toBe(true);
    expect(countsAgainstSubmittedWork({ outcome: "contradicts", failureOwner: "vinci_harness" })).toBe(false);
    expect(countsAgainstSubmittedWork({ outcome: "supports" })).toBe(false);
  });

  it("returns a boolean for an unrecognised provenance, not undefined", () => {
    // The switch had no default, so it fell through and returned `undefined`
    // from a signature declaring `boolean`. Falsy, so it failed closed by luck
    // rather than design, and a caller comparing === false got the wrong answer.
    const result = isProvenanceConsistent("toString" as never, { kind: "worker", workerId: "w" });
    expect(result).toBe(false);
    expect(typeof result).toBe("boolean");
  });
});

describe("provenance is decided from the snapshot, never from a re-read", () => {
  it("refuses a Proxy that shows a worker to the check and a verifier to the decision", () => {
    // The escalation this closes: a worker authorized to vouch for its own
    // output as an independent verifier — the one thing the evidence layer
    // must never permit. Descriptor checking did not defeat it; it only moved
    // which lens was lied to.
    const proxy = new Proxy({ kind: "worker", workerId: "w" }, {
      get(target, prop, receiver) {
        if (prop === "kind") return "verifier";
        if (prop === "independent") return true;
        return Reflect.get(target, prop, receiver);
      },
      getOwnPropertyDescriptor: (t, p) => Reflect.getOwnPropertyDescriptor(t, p),
      ownKeys: (t) => Reflect.ownKeys(t),
    });
    expect(isProvenanceConsistent("independent_verifier" as never, proxy as never)).toBe(false);
    // And it is still correctly read as the honest worker it wraps.
    expect(isProvenanceConsistent("worker_provided" as never, proxy as never)).toBe(true);
  });

  it("still accepts genuine provenance, and still refuses undisclosed non-independence", () => {
    expect(isProvenanceConsistent("worker_provided" as never, { kind: "worker", workerId: "w" } as never)).toBe(true);
    expect(isProvenanceConsistent("independent_verifier" as never, { kind: "verifier", verifierId: "v", independent: true } as never)).toBe(true);
    expect(isProvenanceConsistent("independent_verifier" as never, { kind: "verifier", verifierId: "v", independent: false } as never)).toBe(false);
  });
});
