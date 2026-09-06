import { describe, expect, it } from "vitest";
import {
  AUTHORITY_TERMS,
  HOST_ATTESTED_FIELDS,
  ORACLE_PROPOSE_SCOPES,
  attestedEnvelopeDigest,
  validateAttestedEnvelope,
  validateResearchRequest,
  validateSourceCitation,
} from "./index.ts";
import { validResearchRequest, validSourceCitation } from "./fixtures.test-helpers.ts";

/**
 * CON-03 and INV-01: the model-authored payload cannot carry authority.
 *
 * The negative in every test below is paired with a positive control on the
 * SAME field name, because the claim is not "these words are forbidden" — it is
 * "the host resolves these and the model does not". A rule that refused
 * `contextManifestDigest` everywhere would pass every negative here and would
 * be a rule about spelling.
 */

const codesAndPaths = (input: unknown): { path: string; code: string }[] => {
  const result = validateResearchRequest(input);
  return result.ok ? [] : result.issues.map((i) => ({ path: i.path, code: i.code }));
};

describe("CON-03: a model-authored payload cannot carry a host-resolved field", () => {
  it("admits the request whose envelope carries every host-resolved field", () => {
    // The reachability control for this whole file. Every negative below is
    // this record with ONE key added, so a refusal is attributable to that key.
    const result = validateResearchRequest(validResearchRequest());
    expect(result.ok ? [] : result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  for (const field of ["policyRef", "grantRefs", "workspaceRef", "budgetReservationRef", "contextManifestDigest", "principal"] as const) {
    it(`refuses ${field} inside the payload with its own code, while the envelope carries it`, () => {
      const request = validResearchRequest();
      const smuggled = {
        ...request,
        payload: { ...request.payload, [field]: request[field] },
      };
      expect(codesAndPaths(smuggled)).toEqual([
        { path: `/payload/${field}`, code: "authority_field_in_model_payload" },
      ]);
      // THE POSITIVE CONTROL, on the same name and the same value: the envelope
      // half already carries this exact field, and the unmodified record above
      // validates. So the refusal is about WHERE the field is, not what it is
      // called.
      expect(HOST_ATTESTED_FIELDS as readonly string[]).toContain(field);
    });
  }

  it("refuses an authority field nested inside the payload, not only at its top level", () => {
    const request = validResearchRequest();
    const smuggled = {
      ...request,
      payload: {
        ...request.payload,
        completion: { ...request.payload.completion, grantRef: "grant-invented" },
      },
    };
    expect(codesAndPaths(smuggled)).toEqual([
      { path: "/payload/completion/grantRef", code: "authority_field_in_model_payload" },
    ]);
  });

  it("refuses an authority field inside an ARRAY in the payload", () => {
    const request = validResearchRequest();
    const smuggled = {
      ...request,
      payload: {
        ...request.payload,
        completion: {
          ...request.payload.completion,
          acceptanceCriteria: [{ statement: "x", policyRef: "policy-invented" }],
        },
      },
    };
    // The authority rule reaches it wherever it is; the shape rule then also
    // objects that a criterion is not an object. Both are true, and the
    // authority code is the one that names the mechanism under test.
    expect(codesAndPaths(smuggled)).toContainEqual({
      path: "/payload/completion/acceptanceCriteria/0/policyRef",
      code: "authority_field_in_model_payload",
    });
  });

  it("refuses the authority term whatever spelling it arrives under", () => {
    const request = validResearchRequest();
    for (const spelling of ["policy_ref", "applicablePolicy", "POLICYREF", "resolvedPolicyRefs"]) {
      const smuggled = { ...request, payload: { ...request.payload, [spelling]: "x" } };
      expect(codesAndPaths(smuggled)).toEqual([
        { path: `/payload/${spelling}`, code: "authority_field_in_model_payload" },
      ]);
    }
  });

  it("still refuses an ordinary unknown payload field as an unknown field, not as authority", () => {
    // The discriminating control for the rule above. If every unexpected key
    // were reported as authority smuggling, the dedicated code would carry no
    // information and T03's negative would pass for the wrong reason.
    const request = validResearchRequest();
    const smuggled = { ...request, payload: { ...request.payload, confidenceScore: 0.98 } };
    expect(codesAndPaths(smuggled)).toEqual([
      { path: "/payload/confidenceScore", code: "unknown_field" },
    ]);
  });

  it("applies the same rule to a citation payload, which is a different record", () => {
    const citation = validSourceCitation();
    const smuggled = {
      ...citation,
      payload: { ...citation.payload, observedBytesDigest: "a".repeat(64) },
    };
    const result = validateSourceCitation(smuggled);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => ({ path: i.path, code: i.code }))).toEqual([
      { path: "/payload/observedBytesDigest", code: "authority_field_in_model_payload" },
    ]);
    // Positive control: the unmodified citation is admitted.
    expect(validateSourceCitation(validSourceCitation()).ok).toBe(true);
  });

  it("names the term list in a form a consumer can check its own field names against", () => {
    // Non-vacuity for the whole mechanism: an empty or single-entry term list
    // would let most of the tests above pass by accident.
    expect(AUTHORITY_TERMS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(AUTHORITY_TERMS).size).toBe(AUTHORITY_TERMS.length);
    for (const term of AUTHORITY_TERMS) expect(term).toBe(term.toLowerCase());
  });
});

describe("INV-01: nothing in an admitted request confers execution authority", () => {
  it("offers no propose scope that permits execution", () => {
    // The invariant as a property of the vocabulary rather than of a comment: a
    // member added later that permits execution fails this test.
    expect([...ORACLE_PROPOSE_SCOPES]).toEqual(["advisory_only", "advisory_with_job_shape_ref"]);
    for (const scope of ORACLE_PROPOSE_SCOPES) expect(scope.startsWith("advisory")).toBe(true);
  });

  it("refuses a propose scope the vocabulary does not contain", () => {
    const request = validResearchRequest();
    const escalated = {
      ...request,
      hostResolved: {
        ...request.hostResolved,
        authority: { ...request.hostResolved.authority, proposeScope: "execute" },
      },
    };
    expect(codesAndPaths(escalated)).toEqual([
      { path: "/hostResolved/authority/proposeScope", code: "unknown_propose_scope" },
    ]);
    // Positive control: a real member on the same field is admitted.
    const advisory = {
      ...request,
      hostResolved: {
        ...request.hostResolved,
        authority: { ...request.hostResolved.authority, proposeScope: "advisory_with_job_shape_ref" },
      },
    };
    expect(validateResearchRequest(advisory).ok).toBe(true);
  });
});

describe("the envelope is validated as a whole before either half is read", () => {
  it("accepts an envelope with an opaque payload and an opaque host half", () => {
    const result = validateAttestedEnvelope(validResearchRequest());
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  it("requires budgetReservationRef to be present, and accepts an explicit null", () => {
    const request = validResearchRequest();
    const { budgetReservationRef: _dropped, ...withoutBudget } = request;
    const missing = validateAttestedEnvelope(withoutBudget);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.issues.map((i) => ({ path: i.path, code: i.code }))).toEqual([
        { path: "/budgetReservationRef", code: "required_field" },
      ]);
    }
    // The control CON-02 demands: null is a different claim and is accepted.
    expect(validateAttestedEnvelope({ ...request, budgetReservationRef: null }).ok).toBe(true);
  });

  it("digests the envelope only after it validates", () => {
    const request = validResearchRequest();
    expect(attestedEnvelopeDigest(request)).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      attestedEnvelopeDigest({ ...request, issuedAt: "yesterday" } as unknown as typeof request),
    ).toThrow(/invalid_timestamp/);
  });

  it("gives two envelopes that differ in one host field two identities", () => {
    const request = validResearchRequest();
    const rebound = { ...request, workspaceRef: "ws-somebody-else" };
    expect(attestedEnvelopeDigest(rebound)).not.toBe(attestedEnvelopeDigest(request));
  });
});
