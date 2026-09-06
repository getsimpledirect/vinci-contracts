import { describe, expect, it } from "vitest";
import { CONTEXT_SECRET_TERMS } from "./lib/validate.ts";
import {
  ORACLE_CONTEXT_BINDING_FIELDS,
  oracleContextBindingDigest,
  validateOracleContextBinding,
} from "./index.ts";
import { validContextBinding } from "./fixtures.test-helpers.ts";

const issuesOf = (input: unknown): { path: string; code: string }[] => {
  const result = validateOracleContextBinding(input);
  return result.ok ? [] : result.issues.map((i) => ({ path: i.path, code: i.code }));
};

describe("CTX-01: separate reads are not one atomic cross-system snapshot", () => {
  it("admits a binding that reads two repositories at two instants inside one window", () => {
    expect(issuesOf(validContextBinding())).toEqual([]);
    const binding = validContextBinding();
    expect(binding.revisionVector).toHaveLength(2);
    expect(new Set(binding.revisionVector.map((r) => r.observedAt)).size).toBe(2);
  });

  it("has no field in which an atomic snapshot could be claimed", () => {
    // The mechanism is an ABSENCE, so what is asserted is the closed field
    // list: there is no `snapshotAt`, no `capturedAt`, no `atomic`, and the
    // record rejects unknown fields, so one cannot be added on the wire either.
    const forbidden = ["snapshotAt", "capturedAt", "atomic", "asOf", "consistentAt"];
    for (const name of forbidden) {
      expect(ORACLE_CONTEXT_BINDING_FIELDS).not.toContain(name);
      expect(issuesOf({ ...validContextBinding(), [name]: "2026-09-06T11:50:00.000Z" })).toEqual([
        { path: `/${name}`, code: "unknown_field" },
      ]);
    }
    // And the per-repository observation time is required, so a compiler cannot
    // omit it and let a reader infer simultaneity from its absence.
    const binding = validContextBinding();
    const vector = binding.revisionVector.map(({ observedAt: _dropped, ...rest }) => rest);
    expect(issuesOf({ ...binding, revisionVector: vector })).toEqual([
      { path: "/revisionVector/0/observedAt", code: "invalid_timestamp" },
      { path: "/revisionVector/1/observedAt", code: "invalid_timestamp" },
    ]);
  });

  it("refuses an observation taken outside the window the binding declares", () => {
    const binding = validContextBinding();
    const drifted = {
      ...binding,
      revisionVector: [
        binding.revisionVector[0],
        { ...binding.revisionVector[1], observedAt: "2026-09-06T12:30:00.000Z" },
      ],
    };
    expect(issuesOf(drifted)).toEqual([
      { path: "/revisionVector/1/observedAt", code: "observation_outside_window" },
    ]);
    // Positive control on the same field: an instant INSIDE the window is
    // admitted, including exactly at each edge.
    for (const at of ["2026-09-06T11:40:00.000Z", "2026-09-06T11:58:00.000Z"]) {
      const edge = {
        ...binding,
        revisionVector: [binding.revisionVector[0], { ...binding.revisionVector[1], observedAt: at }],
      };
      expect(issuesOf(edge)).toEqual([]);
    }
  });

  it("refuses a window that ends before it starts", () => {
    const binding = validContextBinding();
    expect(
      issuesOf({
        ...binding,
        observationWindow: { startedAt: "2026-09-06T11:58:00.000Z", endedAt: "2026-09-06T11:40:00.000Z" },
      }).map((i) => i.code),
    ).toContain("observation_window_inverted");
  });

  it("requires a git revision to be a commit id, not a digest of something else", () => {
    const binding = validContextBinding();
    expect(
      issuesOf({
        ...binding,
        revisionVector: [
          { ...binding.revisionVector[0], revision: "a".repeat(64) },
          binding.revisionVector[1],
        ],
      }),
    ).toEqual([{ path: "/revisionVector/0/revision", code: "invalid_git_object_id" }]);
    // The scoping control: an API snapshot id is not held to that rule, because
    // it is not a git object name and pretending otherwise would refuse every
    // legitimate non-git source.
    expect(binding.revisionVector[1]?.revisionKind).toBe("api_snapshot_id");
    expect(issuesOf(binding)).toEqual([]);
  });

  it("refuses one repository at two revisions", () => {
    const binding = validContextBinding();
    expect(
      issuesOf({
        ...binding,
        revisionVector: [
          binding.revisionVector[0],
          { ...binding.revisionVector[1], repositoryId: "vinci-contracts" },
        ],
      }),
    ).toEqual([{ path: "/revisionVector/1/repositoryId", code: "duplicate_repository_revision" }]);
  });

  it("refuses an empty revision vector, which is not the same as an unstated one", () => {
    expect(issuesOf({ ...validContextBinding(), revisionVector: [] })).toEqual([
      { path: "/revisionVector", code: "empty_revision_vector" },
    ]);
  });
});

describe("CTX-02: a mandatory constraint cannot be dropped to fit a budget", () => {
  it("refuses CONTEXT_COMPLETE beside a dropped mandatory constraint", () => {
    expect(
      issuesOf({
        ...validContextBinding(),
        droppedMandatoryConstraints: ["The ratified retention constraint did not fit."],
      }),
    ).toEqual([
      { path: "/droppedMandatoryConstraints", code: "mandatory_context_dropped_under_complete" },
    ]);
  });

  it("refuses CONTEXT_COMPLETE beside omitted critical contradictory evidence", () => {
    expect(
      issuesOf({
        ...validContextBinding(),
        omittedCriticalContradictions: ["A prior investigation reached the opposite conclusion."],
      }),
    ).toEqual([
      { path: "/omittedCriticalContradictions", code: "mandatory_context_dropped_under_complete" },
    ]);
  });

  it("admits the same two lists under CONTEXT_INCOMPLETE", () => {
    // The positive reachability control. The rule is not "these lists must be
    // empty" — it is "a context that dropped these is INCOMPLETE" — and a
    // consumer must have somewhere to record what was dropped.
    expect(
      issuesOf({
        ...validContextBinding(),
        completeness: "CONTEXT_INCOMPLETE",
        droppedMandatoryConstraints: ["The ratified retention constraint did not fit."],
        omittedCriticalContradictions: ["A prior investigation reached the opposite conclusion."],
      }),
    ).toEqual([]);
  });

  it("refuses CONTEXT_INCOMPLETE that names no gap at all", () => {
    // The other direction, and the one a fleet actually fails on: a refusal
    // that says nothing tells a consumer to handle a gap it cannot name.
    expect(issuesOf({ ...validContextBinding(), completeness: "CONTEXT_INCOMPLETE" })).toEqual([
      { path: "/completeness", code: "incomplete_without_named_gap" },
    ]);
  });

  it("gives a complete and an incomplete context two identities", () => {
    const complete = validContextBinding();
    const incomplete = {
      ...complete,
      completeness: "CONTEXT_INCOMPLETE" as const,
      droppedMandatoryConstraints: ["The ratified retention constraint did not fit."],
    };
    expect(oracleContextBindingDigest(incomplete)).not.toBe(oracleContextBindingDigest(complete));
  });
});

describe("CTX-03: a credential has no place in the model's context", () => {
  it("admits the binding that carries only descriptions of what was read", () => {
    expect(issuesOf(validContextBinding())).toEqual([]);
  });

  for (const name of ["apiToken", "credentials", "authorizationHeader", "secretRef", "privateKey", "password"]) {
    it(`refuses ${name} with a code of its own, not as an unknown field`, () => {
      expect(issuesOf({ ...validContextBinding(), [name]: "not-a-real-secret" })).toEqual([
        { path: `/${name}`, code: "credential_field_in_context" },
      ]);
    });
  }

  it("refuses a credential nested inside a section, not only at the top level", () => {
    const binding = validContextBinding();
    const nested = {
      ...binding,
      unavailableSections: [{ ...binding.unavailableSections[0], bearerToken: "x" }],
    };
    expect(issuesOf(nested)).toEqual([
      { path: "/unavailableSections/0/bearerToken", code: "credential_field_in_context" },
    ]);
  });

  it("still reports an ordinary unknown field as an unknown field", () => {
    // The discriminating control. If every unexpected key were reported as a
    // credential, the dedicated code above would carry no information.
    expect(issuesOf({ ...validContextBinding(), summary: "a summary" })).toEqual([
      { path: "/summary", code: "unknown_field" },
    ]);
  });

  it("names no declared field of this record as secret-shaped", () => {
    // The cost of a substring rule, paid explicitly: a legitimate field whose
    // name happened to contain one of these terms would make this record
    // unconstructable, and this is what would notice.
    for (const field of ORACLE_CONTEXT_BINDING_FIELDS) {
      for (const term of CONTEXT_SECRET_TERMS) {
        expect(field.toLowerCase().includes(term), `${field} contains ${term}`).toBe(false);
      }
    }
    expect(CONTEXT_SECRET_TERMS.length).toBeGreaterThanOrEqual(6);
  });
});
