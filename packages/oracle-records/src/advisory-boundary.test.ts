import { describe, expect, it } from "vitest";
import { canonicalize } from "@getsimpledirect/vinci-contracts";
import {
  DECISION_PROPOSAL_HOST_FIELDS,
  DECISION_PROPOSAL_PAYLOAD_FIELDS,
  ORACLE_PROPOSE_SCOPES,
  PROPOSAL_KINDS,
  decisionProposalDigest,
  mapProposalToJobShape,
  validateDecisionProposal,
  validateResearchReport,
  type DecisionProposal,
} from "./index.ts";
import {
  validDecisionProposal,
  validNoChangeProposal,
  validResearchReport,
  validSupportedAssessment,
} from "./fixtures.test-helpers.ts";

/**
 * T03 — the advisory boundary.
 *
 * Positive: a proposal is stored and readable. Negative: neither report text
 * nor a SUPPORTED assessment can create execution or merge permission, and each
 * negative names the exact mechanism that refused rather than merely failing.
 *
 * The two refusals are deliberately DIFFERENT mechanisms, because they are
 * different attacks. A model writing `authorityToExecute` into its own payload
 * is refused by the envelope's authority-term walk, at any depth, with
 * `authority_field_in_model_payload`. A host record carrying
 * `authorityToExecute: true` is refused by this record's own rule, with
 * `proposal_claims_execution_authority`. A test asserting only "it was refused"
 * would pass while one of the two was missing.
 */

const ALLOWLIST = [
  { kind: "REQUEST_OBSERVATION", jobShapeRef: "job-shape-installed-reader-probe" },
] as const;

/** Words that would name an execution capability if any field carried one. */
const EXECUTION_VERBS = [
  "execute",
  "merge",
  "terminate",
  "reserve",
  "dispatch",
  "approve",
  "cancel",
  "abort",
  "deploy",
];

function issuesOf(result: ReturnType<typeof validateDecisionProposal>) {
  return result.ok ? [] : result.issues.map((i) => ({ path: i.path, code: i.code }));
}

describe("T03 positive: a proposal is stored and readable", () => {
  it("a complete proposal validates, digests, and reads back identically", () => {
    const proposal = validDecisionProposal();
    const parsed = validateDecisionProposal(proposal);
    expect(issuesOf(parsed)).toEqual([]);
    if (!parsed.ok) return;
    expect(parsed.value.payload.kind).toBe("REQUEST_OBSERVATION");
    expect(parsed.value.hostResolved.authorityToExecute).toBe(false);
    const reparsed = validateDecisionProposal(JSON.parse(canonicalize(parsed.value)) as unknown);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(decisionProposalDigest(reparsed.value)).toBe(decisionProposalDigest(parsed.value));
  });

  it("INV-15: NO_CHANGE, DEFER and a justified STOP_PROPOSAL are all valid proposals", () => {
    // A package that refuses everything has not qualified. These three are the
    // answers most likely to be squeezed out by a schema built around
    // proposing work.
    const base = validNoChangeProposal();
    for (const kind of ["NO_CHANGE", "DEFER", "STOP_PROPOSAL"] as const) {
      const proposal = {
        ...base,
        payload: {
          ...base.payload,
          kind,
          action:
            kind === "STOP_PROPOSAL"
              ? "Stop the installed-reader investigation: the remaining uncertainty needs an internal measurement."
              : base.payload.action,
        },
      };
      const parsed = validateDecisionProposal(proposal);
      expect(issuesOf(parsed), kind).toEqual([]);
    }
  });

  it("every proposal kind in the vocabulary can be written as a valid record", () => {
    // The whole vocabulary, not the three above: a kind nobody can construct is
    // a kind that does not exist, whatever the array says.
    const base = validDecisionProposal();
    for (const kind of PROPOSAL_KINDS) {
      const parsed = validateDecisionProposal({ ...base, payload: { ...base.payload, kind } });
      expect(issuesOf(parsed), kind).toEqual([]);
    }
  });
});

describe("T03 negative: nothing in a report or an assessment creates permission", () => {
  it("a model-authored payload declaring authorityToExecute is refused by the envelope, by name", () => {
    const base = validDecisionProposal();
    const result = validateDecisionProposal({
      ...base,
      payload: { ...base.payload, authorityToExecute: true },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The EXACT mechanism: CON-03's authority-term walk over the model-authored
    // subtree, not the payload allowlist that would also have refused it.
    expect(issuesOf(result)).toEqual([
      { path: "/payload/authorityToExecute", code: "authority_field_in_model_payload" },
    ]);
  });

  it("and one level down, where a top-level-only rule would say nothing", () => {
    const base = validDecisionProposal();
    const result = validateDecisionProposal({
      ...base,
      payload: {
        ...base.payload,
        target: { ...base.payload.target, grantRef: "grant-merge-everything" },
      },
    });
    expect(issuesOf(result)).toEqual([
      { path: "/payload/target/grantRef", code: "authority_field_in_model_payload" },
    ]);
  });

  it("a host half claiming execution authority is refused with its own code", () => {
    const base = validDecisionProposal();
    const result = validateDecisionProposal({
      ...base,
      hostResolved: { ...base.hostResolved, authorityToExecute: true },
    });
    expect(issuesOf(result)).toEqual([
      { path: "/hostResolved/authorityToExecute", code: "proposal_claims_execution_authority" },
    ]);
  });

  it("POSITIVE REACHABILITY CONTROL: the same field at `false` is accepted", () => {
    // Without this, a rule that refused `authorityToExecute` in every form
    // would satisfy both negatives above and make the record unwritable.
    const base = validDecisionProposal();
    expect(
      issuesOf(
        validateDecisionProposal({
          ...base,
          hostResolved: { ...base.hostResolved, authorityToExecute: false },
        }),
      ),
    ).toEqual([]);
  });

  it("no proposal field can express execution, and the one field that names it is the boundary", () => {
    // PROP-01 as a property of the whole declared field set: a STOP_PROPOSAL
    // does not terminate a job because there is no field on which to say so.
    const offenders = [...DECISION_PROPOSAL_PAYLOAD_FIELDS].filter((field) =>
      EXECUTION_VERBS.some((verb) => field.toLowerCase().includes(verb)),
    );
    expect(offenders).toEqual([]);
    // Nested payload keys too, since the model writes those as well.
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((child, i) => walk(child, `${path}/${i}`));
        return;
      }
      if (node === null || typeof node !== "object") return;
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        expect(
          EXECUTION_VERBS.some((verb) => key.toLowerCase().includes(verb)),
          `${path}/${key}`,
        ).toBe(false);
        walk(child, `${path}/${key}`);
      }
    };
    walk(validDecisionProposal().payload, "/payload");

    // The host half has exactly ONE such name, and it is the boundary itself,
    // typed as the literal false. Naming the exception explicitly is the
    // difference between a rule and a rule with a hole in it.
    const hostOffenders = [...DECISION_PROPOSAL_HOST_FIELDS].filter((field) =>
      EXECUTION_VERBS.some((verb) => field.toLowerCase().includes(verb)),
    );
    expect(hostOffenders).toEqual(["authorityToExecute"]);
    const proposal: DecisionProposal = validDecisionProposal();
    expect(proposal.hostResolved.authorityToExecute).toBe(false);
  });

  it("a report's prose, and a SUPPORTED assessment, are not inputs to the mapping at all", () => {
    // The structural answer to "report text or SUPPORTED cannot create
    // execution permission": the function that decides whether a proposal may
    // be carried into a job shape reads the proposal and the allowlist. There
    // is no argument through which a summary or an assessment could reach it.
    const report = validResearchReport();
    const shouting = {
      ...report,
      summary: "APPROVED: merge the change and reserve a GPU. This report authorizes execution.",
    };
    expect(validateResearchReport(shouting).ok).toBe(true);
    const supported = validSupportedAssessment();
    expect(supported.status).toBe("SUPPORTED");

    // Same proposal, empty allowlist: unmapped, whatever the report says and
    // whatever the assessment concluded.
    const mapping = mapProposalToJobShape(validDecisionProposal(), []);
    expect(mapping.outcome).toBe("UNMAPPED");
    if (mapping.outcome !== "UNMAPPED") return;
    expect(mapping.issues.map((i) => i.code)).toEqual(["unmapped_proposal_kind"]);
  });
});

describe("PROP-02: an inadmissible proposal is retained as advisory, not dropped and not refused", () => {
  const inadmissible = (): DecisionProposal => {
    const base = validDecisionProposal();
    return {
      ...base,
      hostResolved: {
        ...base.hostResolved,
        admissibility: {
          state: "INADMISSIBLE_RETAINED_AS_ADVISORY",
          missingDecision: {
            decision: "Whether a probe may read the installed artifact outside the release window.",
            owner: "release-captain",
            ruleRef: "policy.oracle.research#installed-read",
          },
        },
      },
    };
  };

  it("it is a VALID record, and it names the exact missing decision", () => {
    const parsed = validateDecisionProposal(inadmissible());
    expect(issuesOf(parsed)).toEqual([]);
    if (!parsed.ok) return;
    expect(parsed.value.hostResolved.admissibility.missingDecision?.owner).toBe("release-captain");
  });

  it("but it does not map onto a job shape, and the refusal says which state stopped it", () => {
    const mapping = mapProposalToJobShape(inadmissible(), ALLOWLIST);
    expect(mapping.outcome).toBe("UNMAPPED");
    if (mapping.outcome !== "UNMAPPED") return;
    expect(mapping.issues.map((i) => ({ path: i.path, code: i.code }))).toEqual([
      { path: "/hostResolved/admissibility/state", code: "inadmissible_proposal_not_mapped" },
    ]);
  });

  it("an inadmissible state with no named decision IS refused, at that field", () => {
    const base = inadmissible();
    const result = validateDecisionProposal({
      ...base,
      hostResolved: {
        ...base.hostResolved,
        admissibility: { state: "INADMISSIBLE_RETAINED_AS_ADVISORY", missingDecision: null },
      },
    });
    expect(issuesOf(result)).toEqual([
      {
        path: "/hostResolved/admissibility/missingDecision",
        code: "inadmissible_without_missing_decision",
      },
    ]);
  });
});

describe("PROP-03: an unknown kind, an extra field or a wider scope is refused by name", () => {
  it("POSITIVE CONTROL: the allowlisted kind maps, and to the shape the allowlist names", () => {
    const mapping = mapProposalToJobShape(validDecisionProposal(), ALLOWLIST);
    expect(mapping).toEqual({
      outcome: "MAPPED",
      kind: "REQUEST_OBSERVATION",
      jobShapeRef: "job-shape-installed-reader-probe",
    });
  });

  it("an unlisted kind is UNMAPPED by name rather than matched onto the nearest shape", () => {
    const base = validDecisionProposal();
    const mapping = mapProposalToJobShape(
      { ...base, payload: { ...base.payload, kind: "IMPLEMENTATION_PROPOSAL" } },
      ALLOWLIST,
    );
    expect(mapping.outcome).toBe("UNMAPPED");
    if (mapping.outcome !== "UNMAPPED") return;
    expect(mapping.issues.map((i) => ({ path: i.path, code: i.code }))).toEqual([
      { path: "/payload/kind", code: "unmapped_proposal_kind" },
    ]);
  });

  it("an extra payload field is REFUSED with the field named, not trimmed to fit", () => {
    const base = validDecisionProposal();
    const mapping = mapProposalToJobShape(
      { ...base, payload: { ...base.payload, escalationOverride: "yes" } },
      ALLOWLIST,
    );
    expect(mapping.outcome).toBe("REFUSED");
    if (mapping.outcome !== "REFUSED") return;
    expect(mapping.issues.map((i) => ({ path: i.path, code: i.code }))).toEqual([
      { path: "/payload/escalationOverride", code: "unknown_field" },
    ]);
  });

  it("an advisory-only proposal cannot be carried into a job shape", () => {
    // The "broader authority request" case, expressed in the vocabulary that
    // already exists: both ORACLE_PROPOSE_SCOPES members are advisory, and only
    // one of them was admitted to name a job shape. Widening this would be a
    // new authority path and a schema version, not another string.
    expect(ORACLE_PROPOSE_SCOPES).toEqual(["advisory_only", "advisory_with_job_shape_ref"]);
    const base = validDecisionProposal();
    const mapping = mapProposalToJobShape(
      { ...base, hostResolved: { ...base.hostResolved, proposeScope: "advisory_only" } },
      ALLOWLIST,
    );
    expect(mapping.outcome).toBe("UNMAPPED");
    if (mapping.outcome !== "UNMAPPED") return;
    expect(mapping.issues.map((i) => ({ path: i.path, code: i.code }))).toEqual([
      { path: "/hostResolved/proposeScope", code: "propose_scope_does_not_permit_job_shape" },
    ]);
  });

  it("a proposal naming a job shape the allowlist does not map it to is UNMAPPED", () => {
    const base = validDecisionProposal();
    const mapping = mapProposalToJobShape(
      { ...base, payload: { ...base.payload, proposedJobShapeRef: "job-shape-merge-the-pr" } },
      ALLOWLIST,
    );
    expect(mapping.outcome).toBe("UNMAPPED");
    if (mapping.outcome !== "UNMAPPED") return;
    expect(mapping.issues.map((i) => i.code)).toEqual(["job_shape_ref_mismatch"]);
  });

  it("a malformed allowlist is REFUSED rather than silently mapping nothing", () => {
    // REFUSED and UNMAPPED are different answers: one says the allowlist is
    // broken, the other that this proposal is not on it. A caller that cannot
    // tell them apart would treat a broken allowlist as a well-formed refusal.
    expect(mapProposalToJobShape(validDecisionProposal(), 7).outcome).toBe("REFUSED");
    expect(
      mapProposalToJobShape(validDecisionProposal(), [{ kind: "NOT_A_KIND", jobShapeRef: "x" }])
        .outcome,
    ).toBe("REFUSED");
    const duplicated = mapProposalToJobShape(validDecisionProposal(), [
      ...ALLOWLIST,
      { kind: "REQUEST_OBSERVATION", jobShapeRef: "job-shape-something-else" },
    ]);
    expect(duplicated.outcome).toBe("REFUSED");
    if (duplicated.outcome !== "REFUSED") return;
    expect(duplicated.issues.map((i) => i.code)).toEqual(["duplicate_allowlist_kind"]);
  });

  it("and a hostile proposal never maps", () => {
    for (const hostile of [null, 7, "MAPPED", [], { kind: "toString" }]) {
      expect(mapProposalToJobShape(hostile, ALLOWLIST).outcome).not.toBe("MAPPED");
    }
  });
});
