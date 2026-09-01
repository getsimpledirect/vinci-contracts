import { describe, expect, it } from "vitest";
import { TERMINAL_STATES, assertSchemaMetaComplete, type ReceiptId, type RunId } from "@getsimpledirect/vinci-contracts";
import {
  CORRECTION_SCHEMA_META,
  RECEIPT_COVERED_FIELDS,
  RECEIPT_DECLARED_FIELDS,
  RECEIPT_SCHEMA_META,
  VERIFICATION_STATUS_SCHEMA_META,
  attentionPerVerifiedOutcome,
  canonicalize,
  receiptDigest,
  validateCorrection,
  validateReceipt,
  validateVerificationRecord,
  verificationAgainst,
  type Receipt,
  type VerificationRecord,
} from "./index.ts";

const STARTED_AT = "2026-08-23T12:00:00.000Z";
const COMPLETED_AT = "2026-08-23T12:00:12.345Z";

function unsignedReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    receiptVersion: 2,
    receiptId: "receipt-1",
    runId: "run-1",
    objective: "Update the dependency lockfile",
    workspace: { kind: "personal", workspaceId: "workspace-1", ownerId: "user-1" },
    requester: { kind: "user", userId: "user-1", deviceId: "device-1" },
    worker: { kind: "worker", workerId: "worker-1" },
    modelId: "model-1",
    providerId: "provider-1",
    executionLocation: "ca-central-1",
    policyId: "policy-1",
    policyVersion: 3,
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    activeDuration: 12_345,
    humanAttention: { seconds: 25, interruptions: 3, decisions: 2, escalations: 1 },
    finalState: "DONE",
    actionSummary: "Regenerated and checked the lockfile",
    resourcesAccessed: ["repo:vinci", "registry:npm"],
    changesMade: ["file:package-lock.json"],
    artifactsProduced: ["artifact:lockfile"],
    approvalIds: ["approval-1"],
    evidenceIds: ["evidence-1"],
    verdict: "VERIFIED_PASS",
    spend: 17,
    unresolvedConditions: [],
    resumeInstructions: null,
    rollbackInfo: "Restore the previous lockfile",
    digest: "0".repeat(64),
    signature: null,
    ...overrides,
  };
}

// 🔴 DRIFT REGRESSION. receipts inlined its own 5-element terminal-state array and
// omitted WAITING, so a run ending WAITING_FOR_APPROVAL or WAITING_FOR_USER (both
// map onto WAITING in contracts) could not have a receipt written at all. The
// package already depended on @getsimpledirect/vinci-contracts, so the copy bought
// nothing.
//
// This enumerates the WHOLE canonical vocabulary rather than asserting the one
// value that happened to be missing. A test naming only WAITING would pass again
// the next time a DIFFERENT state is added to contracts and not mirrored here --
// which is the failure that actually occurred, one identifier at a time.
// `receipt()` throws when the fixture does not validate, so it cannot carry a case
// whose validity is the thing under test. This builds and digests without asserting ok.
function digested(overrides: Record<string, unknown>): Record<string, unknown> {
  const candidate = unsignedReceipt(overrides);
  candidate.digest = receiptDigest(candidate as unknown as Receipt);
  return candidate;
}

describe("finalState accepts exactly the canonical terminal vocabulary", () => {
  for (const state of TERMINAL_STATES) {
    it(`accepts ${state}`, () => {
      const result = validateReceipt(digested({ finalState: state }));
      // validateReceipt is a discriminated union: `issues` exists only on the failure arm.
      const finalStateIssues = result.ok
        ? []
        : result.issues.filter((issue) => issue.path === "/finalState");
      expect(finalStateIssues, `${state} is in contracts TERMINAL_STATES but receipts rejected it`).toEqual([]);
    });
  }

  // Anti-vacuity: if every string were accepted the loop above would pass while
  // proving nothing about the vocabulary.
  it("still rejects a state outside the vocabulary", () => {
    const result = validateReceipt(digested({ finalState: "TOTALLY_NOT_A_STATE" }));
    expect(result.ok).toBe(false);
    expect(
      result.ok
        ? false
        : result.issues.some((issue) => issue.path === "/finalState" && issue.code === "invalid_state"),
    ).toBe(true);
  });
});

function receipt(overrides: Record<string, unknown> = {}): Receipt {
  const candidate = unsignedReceipt(overrides);
  candidate.digest = receiptDigest(candidate as unknown as Receipt);
  const result = validateReceipt(candidate);
  if (!result.ok) throw new Error(`fixture invalid: ${JSON.stringify(result.issues)}`);
  return result.value;
}

describe("canonicalization", () => {
  it("sorts keys recursively at every object depth", () => {
    const one = {
      outer: { z: 1, inner: { beta: "two", alpha: "one" } },
      first: true,
    };
    const two = {
      first: true,
      outer: { inner: { alpha: "one", beta: "two" }, z: 1 },
    };
    expect(JSON.stringify(one)).not.toBe(JSON.stringify(two));
    expect(canonicalize(one)).toBe(canonicalize(two));
  });

  it("preserves array order and explicitly encodes strings and finite numbers", () => {
    expect(canonicalize([1, "1", -0, 1.5])).toBe('[1,"1",0,1.5]');
    expect(canonicalize(["a", "b"])).not.toBe(canonicalize(["b", "a"]));
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    expect(() => canonicalize(undefined)).toThrow(/undefined/);
  });
});

describe("receipt digest coverage", () => {
  const mutations: Readonly<Record<(typeof RECEIPT_COVERED_FIELDS)[number], unknown>> = {
    receiptVersion: 3,
    receiptId: "receipt-2",
    runId: "run-2",
    objective: "A different objective",
    workspace: { kind: "organization", workspaceId: "workspace-2", organizationId: "org-1" },
    requester: { kind: "system", component: "scheduler" },
    worker: { kind: "worker", workerId: "worker-2" },
    modelId: "model-2",
    providerId: "provider-2",
    executionLocation: "local",
    policyId: "policy-2",
    policyVersion: 4,
    startedAt: "2026-08-23T11:59:59.000Z",
    completedAt: "2026-08-23T12:00:13.345Z",
    activeDuration: 12_346,
    humanAttention: { seconds: 26, interruptions: 4, decisions: 3, escalations: 2 },
    finalState: "DONE_UNVERIFIED",
    actionSummary: "A different action summary",
    resourcesAccessed: ["repo:different"],
    changesMade: ["file:different"],
    artifactsProduced: ["artifact:different"],
    approvalIds: ["approval-2"],
    evidenceIds: ["evidence-2"],
    verdict: "CONDITIONAL",
    spend: 18,
    unresolvedConditions: ["Integration test pending"],
    resumeInstructions: "Run the integration test",
    rollbackInfo: null,
  };

  it("declares every and only covered field", () => {
    const allReceiptFields = Object.keys(unsignedReceipt()).sort();
    expect([...RECEIPT_DECLARED_FIELDS].sort()).toEqual(allReceiptFields);
    expect([...RECEIPT_COVERED_FIELDS].sort()).toEqual(
      allReceiptFields.filter((field) => field !== "digest" && field !== "signature"),
    );
    expect(RECEIPT_COVERED_FIELDS).not.toContain("digest");
    expect(RECEIPT_COVERED_FIELDS).not.toContain("signature");
    expect(Object.keys(mutations).sort()).toEqual([...RECEIPT_COVERED_FIELDS].sort());
  });

  it("hashes the same content identically regardless of insertion order", () => {
    const base = receipt();
    const reordered = {
      signature: base.signature,
      digest: base.digest,
      rollbackInfo: base.rollbackInfo,
      resumeInstructions: base.resumeInstructions,
      unresolvedConditions: base.unresolvedConditions,
      spend: base.spend,
      verdict: base.verdict,
      evidenceIds: base.evidenceIds,
      approvalIds: base.approvalIds,
      artifactsProduced: base.artifactsProduced,
      changesMade: base.changesMade,
      resourcesAccessed: base.resourcesAccessed,
      actionSummary: base.actionSummary,
      finalState: base.finalState,
      humanAttention: {
        escalations: base.humanAttention.escalations,
        decisions: base.humanAttention.decisions,
        interruptions: base.humanAttention.interruptions,
        seconds: base.humanAttention.seconds,
      },
      activeDuration: base.activeDuration,
      completedAt: base.completedAt,
      startedAt: base.startedAt,
      policyVersion: base.policyVersion,
      policyId: base.policyId,
      executionLocation: base.executionLocation,
      providerId: base.providerId,
      modelId: base.modelId,
      worker: { workerId: "worker-1", kind: "worker" },
      requester: { deviceId: "device-1", userId: "user-1", kind: "user" },
      workspace: { ownerId: "user-1", workspaceId: "workspace-1", kind: "personal" },
      objective: base.objective,
      runId: base.runId,
      receiptId: base.receiptId,
      receiptVersion: base.receiptVersion,
    } as Receipt;
    expect(receiptDigest(reordered)).toBe(receiptDigest(base));
  });

  it("changes when every covered field is mutated", () => {
    const base = receipt();
    for (const field of RECEIPT_COVERED_FIELDS) {
      const changed = { ...base, [field]: mutations[field] } as Receipt;
      expect(receiptDigest(changed), field).not.toBe(receiptDigest(base));
    }
  });

  it("changes when humanAttention.seconds changes", () => {
    const base = receipt();
    const changed = {
      ...base,
      humanAttention: { ...base.humanAttention, seconds: base.humanAttention.seconds + 1 },
    };
    expect(receiptDigest(changed)).not.toBe(receiptDigest(base));
  });

  it("does not cover digest or signature", () => {
    const base = receipt();
    expect(receiptDigest({ ...base, digest: "f".repeat(64) })).toBe(receiptDigest(base));
    expect(receiptDigest({ ...base, signature: "different-signature" })).toBe(receiptDigest(base));
  });
});

describe("receipt validation", () => {
  it("accepts the complete receipt and preserves unknown fields", () => {
    const candidate = unsignedReceipt({ futureField: { nested: true } });
    candidate.digest = receiptDigest(candidate as unknown as Receipt);
    const result = validateReceipt(candidate);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.unknownFields).toEqual({ "/futureField": { nested: true } });
  });

  it("rejects a digest that no longer matches the covered content", () => {
    const changed = { ...receipt(), objective: "silently rewritten" };
    const result = validateReceipt(changed);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((entry) => entry.code === "digest_mismatch")).toBe(true);
  });

  it.each([
    ["missing field", () => ({ ...receipt(), modelId: undefined })],
    ["bad timestamp", () => unsignedReceipt({ startedAt: "2026-08-23T12:00:00Z" })],
    ["impossible timestamp", () => unsignedReceipt({ startedAt: "2026-02-29T12:00:00.000Z" })],
    ["bad digest shape", () => unsignedReceipt({ digest: "A".repeat(64) })],
    ["wrong final state", () => unsignedReceipt({ finalState: "RUNNING" })],
    ["wrong verdict", () => unsignedReceipt({ verdict: "FAILED" })],
    // The receipt used to hand-roll its own verdict list (VERIFIED_FAIL, UNVERIFIED) that
    // disagreed with the canonical VerdictStatus its own field is typed with. Pinned.
    ["legacy verdict vocabulary", () => unsignedReceipt({ verdict: "VERIFIED_FAIL" })],
    ["wrong receipt version", () => unsignedReceipt({ receiptVersion: 1 })],
    [
      "signed zero attention count",
      () => unsignedReceipt({ humanAttention: { seconds: -0, interruptions: 0, decisions: 0, escalations: 0 } }),
    ],
    ["negative duration", () => unsignedReceipt({ activeDuration: -1 })],
    ["missing human attention", () => unsignedReceipt({ humanAttention: undefined })],
    ["non-object human attention", () => unsignedReceipt({ humanAttention: 1 })],
    ["missing human attention count", () => unsignedReceipt({ humanAttention: { seconds: 1, interruptions: 1, decisions: 1 } })],
    ["negative human attention count", () => unsignedReceipt({ humanAttention: { seconds: -1, interruptions: 1, decisions: 1, escalations: 1 } })],
    ["fractional human attention count", () => unsignedReceipt({ humanAttention: { seconds: 1.5, interruptions: 1, decisions: 1, escalations: 1 } })],
    ["per-human identity", () => unsignedReceipt({ humanAttention: { seconds: 1, interruptions: 1, decisions: 1, escalations: 1, humanId: "user-1" } })],
    ["fractional spend", () => unsignedReceipt({ spend: 1.5 })],
    ["invalid requester", () => unsignedReceipt({ requester: { kind: "user" } })],
    ["invalid worker", () => unsignedReceipt({ worker: { kind: "worker", workerId: 5 } })],
    ["invalid workspace arm", () => unsignedReceipt({ workspace: { kind: "personal", workspaceId: "w", organizationId: "o" } })],
    ["non-string list member", () => unsignedReceipt({ evidenceIds: [1] })],
  ])("rejects %s", (_label, build) => {
    expect(validateReceipt(build()).ok).toBe(false);
  });

  it("rejects a hostile key inside humanAttention", () => {
    const candidate = unsignedReceipt({
      humanAttention: JSON.parse(
        '{"seconds":1,"interruptions":1,"decisions":1,"escalations":1,"__proto__":{"polluted":true}}',
      ),
    });
    expect(validateReceipt(candidate).ok).toBe(false);
  });
});

describe("attention per verified consequential outcome", () => {
  it("counts only VERIFIED_PASS outcomes but includes every receipt's attention", () => {
    const receipts = [
      receipt({
        receiptId: "receipt-pass-1",
        verdict: "VERIFIED_PASS",
        humanAttention: { seconds: 20, interruptions: 1, decisions: 1, escalations: 0 },
      }),
      receipt({
        receiptId: "receipt-conditional",
        verdict: "CONDITIONAL",
        humanAttention: { seconds: 15, interruptions: 2, decisions: 1, escalations: 1 },
      }),
      receipt({
        receiptId: "receipt-blocked",
        verdict: "BLOCKED",
        finalState: "BLOCKED",
        humanAttention: { seconds: 10, interruptions: 1, decisions: 1, escalations: 1 },
      }),
      receipt({
        receiptId: "receipt-pass-2",
        verdict: "VERIFIED_PASS",
        humanAttention: { seconds: 5, interruptions: 0, decisions: 0, escalations: 0 },
      }),
    ];

    expect(attentionPerVerifiedOutcome(receipts)).toEqual({
      verifiedOutcomes: 2,
      humanSeconds: 50,
      secondsPerVerifiedOutcome: 25,
    });
  });

  it("returns null rather than infinity or free when there are no verified outcomes", () => {
    expect(
      attentionPerVerifiedOutcome([
        receipt({
          verdict: "CONDITIONAL",
          humanAttention: { seconds: 30, interruptions: 1, decisions: 1, escalations: 0 },
        }),
      ]),
    ).toEqual({
      verifiedOutcomes: 0,
      humanSeconds: 30,
      secondsPerVerifiedOutcome: null,
    });
    expect(attentionPerVerifiedOutcome([])).toEqual({
      verifiedOutcomes: 0,
      humanSeconds: 0,
      secondsPerVerifiedOutcome: null,
    });
  });
});

describe("verification language", () => {
  it("uses distinct unverified, verified, and invalidated arms", () => {
    const statuses: VerificationRecord[] = [
      { status: "unverified" },
      {
        status: "verified",
        verifierId: "verifier-1",
        independent: true,
        verifiedAt: COMPLETED_AT,
        subjectDigest: "a".repeat(64),
      },
      { status: "invalidated", reason: "artifact changed after verification" },
    ];
    for (const status of statuses) expect(validateVerificationRecord(status).ok).toBe(true);
  });

  it("rejects cross-arm, malformed, and unknown verification claims", () => {
    for (const status of [
      { status: "unverified", verifierId: "verifier-1" },
      { status: "verified", verifierId: "verifier-1", verifiedAt: "not-a-time" },
      // missing the artifact binding — one condition of three
      { status: "verified", verifierId: "v-1", independent: true, verifiedAt: COMPLETED_AT },
      // missing the independence disclosure FR-7.3 requires
      { status: "verified", verifierId: "v-1", verifiedAt: COMPLETED_AT, subjectDigest: "a".repeat(64) },
      { status: "invalidated", reason: "" },
      {
        status: "verified",
        verifierId: "verifier-1",
        independent: true,
        verifiedAt: COMPLETED_AT,
        subjectDigest: "a".repeat(64),
        reason: "stale",
      },
      { status: "trusted" },
    ]) {
      expect(validateVerificationRecord(status).ok).toBe(false);
    }
  });
});

describe("corrections", () => {
  it("validates a new record carrying the corrected receipt", () => {
    const corrected = receipt({ receiptId: "receipt-2", objective: "Corrected objective" });
    const result = validateCorrection({
      correctionId: "correction-1" as ReceiptId,
      supersedes: "receipt-1" as ReceiptId,
      actor: { kind: "user", userId: "user-1" },
      correctedFields: ["objective"],
      reason: "The original objective was incomplete",
      newReceipt: corrected,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects malformed lineage and a rewritten nested receipt", () => {
    const corrected = receipt({ receiptId: "receipt-2", objective: "Corrected objective" });
    const base = {
      correctionId: "correction-1" as ReceiptId,
      supersedes: "receipt-1" as ReceiptId,
      actor: { kind: "user", userId: "user-1" },
      correctedFields: ["objective"],
      reason: "The original objective was incomplete",
      newReceipt: corrected,
    };
    expect(validateCorrection({ ...base, supersedes: "" }).ok).toBe(false);
    expect(validateCorrection({ ...base, correctedFields: [] }).ok).toBe(false);
    expect(validateCorrection({ ...base, newReceipt: { ...corrected, objective: "rewritten" } }).ok).toBe(false);
  });

  it("keeps the imported brands distinct at compile time", () => {
    const runId = "run-1" as RunId;
    const receiptId = "receipt-1" as ReceiptId;
    const acceptsReceipt = (_value: ReceiptId): void => undefined;
    acceptsReceipt(receiptId);
    // @ts-expect-error RunId and ReceiptId are distinct brands from @getsimpledirect/vinci-contracts.
    acceptsReceipt(runId);
  });
});

describe("schema metadata", () => {
  it("answers all six schema questions", () => {
    for (const meta of [RECEIPT_SCHEMA_META, VERIFICATION_STATUS_SCHEMA_META, CORRECTION_SCHEMA_META]) {
      expect(() => assertSchemaMetaComplete(meta)).not.toThrow();
    }
    expect(RECEIPT_SCHEMA_META.unknownFields).toBe("preserve");
    expect(RECEIPT_SCHEMA_META.version).toBe(2);
    expect(VERIFICATION_STATUS_SCHEMA_META.unknownFields).toBe("reject");
  });
});

describe("verified requires all three FR-6.4 conditions, not a label", () => {
  const verified = (o: Record<string, unknown> = {}) => ({
    status: "verified" as const,
    verifierId: "verifier-1",
    independent: true,
    verifiedAt: COMPLETED_AT,
    subjectDigest: "a".repeat(64),
    ...o,
  });

  it("cannot report verified without being told the current state", () => {
    // The whole point. A holder of the record cannot answer "is this verified?"
    // alone, because the record cannot know whether anything changed since. An
    // earlier version of this type carried only a verifier id and a timestamp,
    // with a comment claiming three conditions.
    const record = verified();
    expect(verificationAgainst(record, "a".repeat(64)).show).toBe("verified");
    const stale = verificationAgainst(record, "b".repeat(64));
    expect(stale.show).toBe("not_verified");
    expect(stale.show === "not_verified" && stale.because).toBe("stale");
  });

  it("keeps a stale verdict visible as history rather than erasing it", () => {
    // FR-7.4: stale stays visible, and is never reported as current.
    const stale = verificationAgainst(verified(), "b".repeat(64));
    expect(stale.show === "not_verified" && stale.because === "stale" && stale.verifiedDigest).toBe(
      "a".repeat(64),
    );
  });

  it("carries the independence disclosure through to what is displayed", () => {
    // FR-7.3 permits a non-independent verifier and requires it be DISCLOSED.
    const shown = verificationAgainst(verified({ independent: false }), "a".repeat(64));
    expect(shown.show === "verified" && shown.independent).toBe(false);
  });

  it("never reports verified for an unverified or invalidated record", () => {
    expect(verificationAgainst({ status: "unverified" }, "a".repeat(64)).show).toBe("not_verified");
    expect(
      verificationAgainst({ status: "invalidated", reason: "artifact changed" }, "a".repeat(64)).show,
    ).toBe("not_verified");
  });
});

describe("preservation cannot smuggle unsigned semantics past the digest", () => {
  // The receipt schema PRESERVES unknown fields, because receipts are exported
  // and re-imported (FR-6.5) and a newer producer's data must survive the round
  // trip. That is only safe if preserved fields are also SIGNED — otherwise a
  // field riding inside the record but outside the digest is unsigned content
  // that a reader may treat as meaningful.
  //
  // Today they are covered, because receiptDigest spreads the whole record
  // rather than iterating the declared field list. That is the correct
  // behaviour and it is easy to lose: replacing the spread with a loop over
  // RECEIPT_COVERED_FIELDS would look like a tidy-up and would silently narrow
  // coverage to the 27 declared fields. These tests exist to make that change
  // fail loudly.
  it("hashes a field it does not declare", () => {
    const plain = unsignedReceipt();
    const extra = unsignedReceipt({ unsignedClaim: "independently verified" });
    expect(RECEIPT_COVERED_FIELDS).not.toContain("unsignedClaim");
    expect(receiptDigest(extra as never)).not.toBe(receiptDigest(plain as never));
  });

  it("keeps a preserved field verifiable after a round trip", () => {
    const candidate = unsignedReceipt({ futureField: { nested: [1, 2] } });
    candidate.digest = receiptDigest(candidate as never);
    const result = validateReceipt(candidate);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The field survives...
    expect(Object.hasOwn(result.value, "futureField")).toBe(true);
    // ...and the stored digest still verifies over the record as returned, so
    // nothing was silently added or dropped between signing and reading.
    const recomputed = receiptDigest({ ...result.value, digest: "0".repeat(64) } as never);
    expect(recomputed).toBe(candidate.digest);
  });

  it("detects a preserved field added after signing", () => {
    // The attack this closes: sign a receipt, then attach an unsigned claim.
    const candidate = unsignedReceipt();
    candidate.digest = receiptDigest(candidate as never);
    const tampered = { ...candidate, unsignedClaim: "independently verified" };
    const recomputed = receiptDigest({ ...tampered, digest: "0".repeat(64) } as never);
    expect(recomputed).not.toBe(candidate.digest);
  });
});
