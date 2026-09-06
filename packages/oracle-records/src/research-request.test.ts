import { describe, expect, it } from "vitest";
import {
  ASSUMABLE_ELEMENTS,
  CRITICAL_ELEMENTS,
  MISSING_ELEMENT_CLASSES,
  admitResearchRequest,
  researchRequestDigest,
  resolveIdempotency,
  validateResearchRequest,
} from "./index.ts";
import { reversed, validAdmittedIdentity, validResearchRequest } from "./fixtures.test-helpers.ts";

/**
 * T01 (request schema), REQ-01, REQ-02 and REQ-03.
 *
 * Every negative here is `validResearchRequest()` with exactly ONE field
 * changed, and every one asserts the exact path AND code rather than
 * `ok === false`. QUAL-02: a hand-written invalid object usually fails for
 * three reasons, of which the intended one may never be reached.
 */

const issuesOf = (input: unknown): { path: string; code: string }[] => {
  const result = validateResearchRequest(input);
  return result.ok ? [] : result.issues.map((i) => ({ path: i.path, code: i.code }));
};

/** Replace one value at a JSON pointer in a deep copy. */
function withField(root: unknown, pointer: string, value: unknown): unknown {
  const copy: unknown = structuredClone(root);
  const segments = pointer.split("/").slice(1);
  const last = segments.pop();
  if (last === undefined) throw new Error("pointer must name a field");
  let node: Record<string, unknown> = copy as Record<string, unknown>;
  for (const segment of segments) {
    node = node[segment] as Record<string, unknown>;
  }
  if (value === undefined) delete node[last];
  else node[last] = value;
  return copy;
}

/** Fields whose absence, null, emptiness and wrong type must each be diagnosed by name. */
const REQUIRED_FIELDS: readonly {
  readonly pointer: string;
  readonly missing: string;
  readonly wrongType: readonly [unknown, string];
}[] = [
  { pointer: "/workspaceRef", missing: "invalid_id", wrongType: [7, "invalid_id"] },
  { pointer: "/runRef", missing: "invalid_id", wrongType: [["run-1"], "invalid_id"] },
  { pointer: "/policyRef", missing: "invalid_id", wrongType: [true, "invalid_id"] },
  { pointer: "/policyVersion", missing: "invalid_type", wrongType: ["3", "invalid_type"] },
  { pointer: "/principal", missing: "invalid_actor", wrongType: ["worker-1", "invalid_actor"] },
  { pointer: "/contextManifestDigest", missing: "invalid_digest", wrongType: [64, "invalid_digest"] },
  { pointer: "/issuedAt", missing: "invalid_timestamp", wrongType: [0, "invalid_timestamp"] },
  { pointer: "/hostResolved/requestId", missing: "invalid_id", wrongType: [{}, "invalid_id"] },
  {
    pointer: "/hostResolved/lineage/idempotencyKey",
    missing: "required_field",
    wrongType: [12, "required_field"],
  },
  { pointer: "/payload/question", missing: "required_field", wrongType: [42, "required_field"] },
  {
    pointer: "/payload/consequenceOfNoAnswer",
    missing: "required_field",
    wrongType: [["a"], "required_field"],
  },
  {
    pointer: "/payload/completion/deliveryDestination",
    missing: "required_field",
    wrongType: [false, "required_field"],
  },
];

describe("T01: a complete valid request is admitted", () => {
  it("admits the fixture, with no issues at all", () => {
    const result = validateResearchRequest(validResearchRequest());
    expect(result.ok ? [] : result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("admits the same record whatever order its keys arrive in", () => {
    // Identity must not depend on insertion order, or two hosts serialising the
    // same request would disagree about whether it is the same request.
    const request = validResearchRequest();
    const shuffled = reversed(request);
    expect(validateResearchRequest(shuffled).ok).toBe(true);
    expect(researchRequestDigest(shuffled as typeof request)).toBe(researchRequestDigest(request));
  });

  it("retains no unknown fields on the success arm", () => {
    const result = validateResearchRequest(validResearchRequest());
    expect(result.ok && result.unknownFields).toEqual({});
  });
});

describe("T01: missing, null, empty and wrong-type required fields are diagnosed BY NAME", () => {
  for (const field of REQUIRED_FIELDS) {
    it(`${field.pointer}: absent`, () => {
      expect(issuesOf(withField(validResearchRequest(), field.pointer, undefined))).toEqual([
        { path: field.pointer, code: field.missing },
      ]);
    });

    it(`${field.pointer}: null`, () => {
      expect(issuesOf(withField(validResearchRequest(), field.pointer, null))).toEqual([
        { path: field.pointer, code: field.missing },
      ]);
    });

    it(`${field.pointer}: empty`, () => {
      expect(issuesOf(withField(validResearchRequest(), field.pointer, ""))).toEqual([
        { path: field.pointer, code: field.missing },
      ]);
    });

    it(`${field.pointer}: wrong type`, () => {
      const [value, code] = field.wrongType;
      expect(issuesOf(withField(validResearchRequest(), field.pointer, value))).toEqual([
        { path: field.pointer, code },
      ]);
    });
  }

  it("blank-but-not-empty text is refused too", () => {
    // `"   "` satisfies typeof and .length and says nothing, which is the shape
    // a required field takes when its author had nothing to put in it.
    expect(issuesOf(withField(validResearchRequest(), "/payload/question", "   "))).toEqual([
      { path: "/payload/question", code: "required_field" },
    ]);
  });
});

describe("REQ-01: a request names a decision with a plausible operational use", () => {
  it("refuses exploration with no approved portfolio, and admits it with one", () => {
    const exploring = withField(
      validResearchRequest(),
      "/hostResolved/effort/mode",
      "exploration",
    );
    expect(issuesOf(exploring)).toEqual([
      {
        path: "/hostResolved/effort/explorationPortfolioRef",
        code: "exploration_without_portfolio",
      },
    ]);
    // The positive reachability control: the SAME mode with a portfolio is
    // admitted, so the refusal is the portfolio rule and not the mode itself.
    const approved = withField(
      exploring,
      "/hostResolved/effort/explorationPortfolioRef",
      "portfolio-institutional-exploration",
    );
    expect(issuesOf(approved)).toEqual([]);
    // And the reverse control: every other mode is admitted with a null
    // portfolio, so the rule is scoped to exploration.
    expect(issuesOf(validResearchRequest())).toEqual([]);
  });
});

describe("REQ-02: what cannot be guessed is named precisely, and never assumed", () => {
  it("admits a complete draft and reports the digest and the labeled assumptions", () => {
    const admission = admitResearchRequest(validResearchRequest());
    expect(admission.outcome).toBe("ADMITTED");
    if (admission.outcome !== "ADMITTED") return;
    expect(admission.requestDigest).toBe(researchRequestDigest(validResearchRequest()));
    // The noncritical half of REQ-02: a detail the requester left out is
    // carried as a LABELED assumption rather than silently defaulted.
    expect(admission.assumptions).toEqual([
      {
        about: "/payload/freshness/asOfCutoff",
        assumed: "No cutoff was stated, so the question is read as being about the current state.",
        basis: "ratified_default",
      },
    ]);
  });

  for (const element of CRITICAL_ELEMENTS) {
    it(`${element.path} absent: INCOMPLETE naming ${element.element}, not a generic failure`, () => {
      const draft = withField(validResearchRequest(), element.path, undefined);
      const admission = admitResearchRequest(draft);
      expect(admission.outcome).toBe("INCOMPLETE");
      if (admission.outcome !== "INCOMPLETE") return;
      expect(admission.missing).toEqual([
        { element: element.element, path: element.path, reason: element.reason },
      ]);
    });

    it(`${element.path} null: INCOMPLETE, because null is not a stated authority either`, () => {
      const admission = admitResearchRequest(withField(validResearchRequest(), element.path, null));
      expect(admission.outcome).toBe("INCOMPLETE");
      if (admission.outcome !== "INCOMPLETE") return;
      expect(admission.missing.map((m) => m.path)).toEqual([element.path]);
    });
  }

  it("distinguishes INCOMPLETE from REFUSED: a malformed draft is not an unanswered question", () => {
    // Both records fail. They fail for different reasons and a consumer must be
    // able to act on the difference — REQ-02's actual complaint about "please
    // provide more context".
    const malformed = withField(validResearchRequest(), "/issuedAt", "yesterday");
    const refused = admitResearchRequest(malformed);
    expect(refused.outcome).toBe("REFUSED");
    if (refused.outcome !== "REFUSED") return;
    expect(refused.issues.map((i) => i.code)).toEqual(["invalid_timestamp"]);

    const incomplete = admitResearchRequest(withField(validResearchRequest(), "/policyRef", undefined));
    expect(incomplete.outcome).toBe("INCOMPLETE");
  });

  it("reports the critical element FIRST, not whatever the validator reached first", () => {
    // A draft missing its policy reference AND carrying a malformed timestamp.
    // Run in the other order this answers "your timestamp is wrong", which is
    // true, unhelpful, and exactly the failure REQ-02 names.
    let draft = withField(validResearchRequest(), "/policyRef", undefined);
    draft = withField(draft, "/issuedAt", "yesterday");
    const admission = admitResearchRequest(draft);
    expect(admission.outcome).toBe("INCOMPLETE");
    if (admission.outcome !== "INCOMPLETE") return;
    expect(admission.missing.map((m) => m.path)).toEqual(["/policyRef"]);
  });

  it("refuses to record an assumption over a critical element", () => {
    // REQ-02's easy half to leave out. Refusing to GUESS a critical element is
    // worthless if the guess can be admitted as a labeled assumption instead.
    const assumed = withField(validResearchRequest(), "/hostResolved/admissionAssumptions", [
      { about: "/principal", assumed: "Probably the worker that asked.", basis: "requester_default" },
    ]);
    expect(issuesOf(assumed)).toEqual([
      {
        path: "/hostResolved/admissionAssumptions/0/about",
        code: "assumption_over_critical_element",
      },
    ]);
    // Positive control on the same field: an assumption over a NONCRITICAL
    // element is admitted, so the refusal is the critical table and not the
    // assumption machinery.
    const permitted = withField(validResearchRequest(), "/hostResolved/admissionAssumptions", [
      {
        about: "/hostResolved/lineage/parentInvestigationRef",
        assumed: "No parent was named, so this is read as a root investigation.",
        basis: "requester_default",
      },
    ]);
    expect(issuesOf(permitted)).toEqual([]);
  });

  it("refuses an assumption over an element that is in neither table", () => {
    const assumed = withField(validResearchRequest(), "/hostResolved/admissionAssumptions", [
      { about: "/payload/invented", assumed: "Something.", basis: "requester_default" },
    ]);
    expect(issuesOf(assumed)).toEqual([
      { path: "/hostResolved/admissionAssumptions/0/about", code: "unknown_assumable_element" },
    ]);
  });

  it("keeps the assumable and critical tables disjoint", () => {
    // If they overlapped, the two rules above would contradict each other and
    // whichever ran first would decide. They cannot overlap by construction
    // here, and this is what says so.
    const critical = new Set(CRITICAL_ELEMENTS.map((e) => e.path));
    for (const assumable of ASSUMABLE_ELEMENTS) expect(critical.has(assumable)).toBe(false);
    // Non-vacuity: both tables are non-empty and cover all four classes.
    expect(ASSUMABLE_ELEMENTS.length).toBeGreaterThan(0);
    expect(new Set(CRITICAL_ELEMENTS.map((e) => e.element))).toEqual(new Set(MISSING_ELEMENT_CLASSES));
  });
});

describe("REQ-03: an idempotency key resolves to one identity, and a conflict is named", () => {
  const request = validResearchRequest();
  const digest = researchRequestDigest(request);

  it("returns the same identity for the same key and the same digest", () => {
    const outcome = resolveIdempotency(validAdmittedIdentity(digest), request);
    expect(outcome).toEqual({
      outcome: "SAME_REQUEST",
      requestId: "oracle-request-1",
      requestDigest: digest,
    });
  });

  it("returns the same identity when only the key ORDER of the record changed", () => {
    // The reason the digest is canonical: a re-serialised request is the same
    // request, and a key reordering must not read as a conflict.
    const outcome = resolveIdempotency(validAdmittedIdentity(digest), reversed(request));
    expect(outcome.outcome).toBe("SAME_REQUEST");
  });

  it("names a conflict when the key is reused for a different immutable request", () => {
    // The scope was widened underneath the key. Nothing about the question
    // changed, which is precisely why the digest must cover the whole record.
    const widened = withField(validResearchRequest(), "/hostResolved/scope/repositoryRefs", [
      "repo:vinci-contracts@365fe6ce",
      "repo:somebody-elses-repository@main",
    ]);
    const outcome = resolveIdempotency(validAdmittedIdentity(digest), widened);
    expect(outcome.outcome).toBe("KEY_CONFLICT");
    if (outcome.outcome !== "KEY_CONFLICT") return;
    expect(outcome.issues.map((i) => ({ path: i.path, code: i.code }))).toEqual([
      {
        path: "/hostResolved/lineage/idempotencyKey",
        code: "idempotency_key_conflict",
      },
    ]);
    // And the conflict is not a silent replacement: nothing in the outcome
    // hands the caller a new identity to store under the old key.
    expect(Object.keys(outcome).sort()).toEqual(["issues", "outcome"]);
  });

  it("treats a different key as a new request rather than a conflict", () => {
    const other = withField(validResearchRequest(), "/hostResolved/lineage/idempotencyKey", "idem-other");
    const outcome = resolveIdempotency(validAdmittedIdentity(digest), other);
    expect(outcome.outcome).toBe("NEW_REQUEST");
  });

  it("REFUSES rather than resolving when either side is malformed", () => {
    // A prior identity carrying whatever digest the incoming request has would
    // otherwise manufacture a SAME_REQUEST out of nothing.
    expect(resolveIdempotency({ requestDigest: digest }, request).outcome).toBe("REFUSED");
    expect(resolveIdempotency(validAdmittedIdentity(digest), { schemaVersion: 1 }).outcome).toBe(
      "REFUSED",
    );
    expect(resolveIdempotency(null, null).outcome).toBe("REFUSED");
  });

  it("covers the whole record, not only the question", () => {
    // The property the conflict test above depends on, asserted directly: two
    // requests differing only in a host-resolved field have different digests.
    for (const pointer of [
      "/policyRef",
      "/grantRefs",
      "/budgetReservationRef",
      "/hostResolved/authority/readScope",
      "/hostResolved/effort/budgetMicrousd",
    ]) {
      const changed = withField(
        validResearchRequest(),
        pointer,
        pointer === "/grantRefs" ? ["grant-read-institutional"]
          : pointer === "/hostResolved/effort/budgetMicrousd" ? 1
            : pointer === "/hostResolved/authority/readScope" ? "workspace_wide"
              : "something-else",
      );
      expect(researchRequestDigest(changed as ReturnType<typeof validResearchRequest>)).not.toBe(digest);
    }
  });
});

describe("REQ-02: an empty object is 'not stated', which is the headline case", () => {
  it("an empty authority object is INCOMPLETE naming authority, not REFUSED", () => {
    // The `stated` test covered undefined, null, blank strings and empty
    // ARRAYS, and missed the empty OBJECT — so `hostResolved.authority = {}`,
    // a request stating no read or propose scope, came back REFUSED with
    // whatever the validator reached first. REQ-02's whole point is that the
    // answer names the element that cannot be guessed.
    const base = validResearchRequest();
    const admission = admitResearchRequest({
      ...base,
      hostResolved: { ...base.hostResolved, authority: {} },
    });
    expect(admission.outcome).toBe("INCOMPLETE");
    if (admission.outcome !== "INCOMPLETE") return;
    expect(admission.missing.map((m) => ({ element: m.element, path: m.path }))).toEqual([
      { element: "authority", path: "/hostResolved/authority" },
    ]);
  });

  it("and the same holds for the other object-valued critical elements", () => {
    // Three of the eleven critical elements are objects, so the omission
    // covered more than one field. The sweep is over the table rather than over
    // the one example the finding named.
    const base = validResearchRequest();
    const cases: [string, unknown][] = [
      ["/hostResolved/scope", { ...base.hostResolved, scope: {} }],
      ["/hostResolved/missionOwner", { ...base.hostResolved, missionOwner: {} }],
      ["/hostResolved/intendedRecipient", { ...base.hostResolved, intendedRecipient: {} }],
    ];
    for (const [path, hostResolved] of cases) {
      const admission = admitResearchRequest({ ...base, hostResolved });
      expect(admission.outcome, path).toBe("INCOMPLETE");
      if (admission.outcome !== "INCOMPLETE") continue;
      expect(admission.missing.map((m) => m.path), path).toEqual([path]);
    }
  });

  it("POSITIVE CONTROL: a populated authority is ADMITTED", () => {
    // Without this, an `admitResearchRequest` that called everything
    // incomplete would satisfy every assertion above.
    expect(admitResearchRequest(validResearchRequest()).outcome).toBe("ADMITTED");
  });
});

describe("REQ-03: a stored identity whose id disagrees with its own digest", () => {
  it("is a KEY_CONFLICT rather than a SAME_REQUEST returning the wrong id", () => {
    // `requestId` rode alongside the digest and was handed back unchecked, so a
    // stored identity naming a different request than the one its digest
    // identifies would attach this request to whatever the caller looked up.
    const request = validResearchRequest();
    const admitted = admitResearchRequest(request);
    expect(admitted.outcome).toBe("ADMITTED");
    if (admitted.outcome !== "ADMITTED") return;
    const prior = {
      schemaVersion: 1 as const,
      idempotencyKey: request.hostResolved.lineage.idempotencyKey,
      requestId: "oracle-request-somebody-else",
      requestDigest: admitted.requestDigest,
    };
    const result = resolveIdempotency(prior, request);
    expect(result.outcome).toBe("KEY_CONFLICT");
    if (result.outcome !== "KEY_CONFLICT") return;
    expect(result.issues.map((i) => i.code)).toEqual(["prior_identity_request_id_mismatch"]);
  });

  it("POSITIVE CONTROL: the matching identity still resolves to SAME_REQUEST", () => {
    const request = validResearchRequest();
    const admitted = admitResearchRequest(request);
    if (admitted.outcome !== "ADMITTED") throw new Error("fixture must be admissible");
    const result = resolveIdempotency(
      {
        schemaVersion: 1 as const,
        idempotencyKey: request.hostResolved.lineage.idempotencyKey,
        requestId: request.hostResolved.requestId,
        requestDigest: admitted.requestDigest,
      },
      request,
    );
    expect(result.outcome).toBe("SAME_REQUEST");
  });
});
