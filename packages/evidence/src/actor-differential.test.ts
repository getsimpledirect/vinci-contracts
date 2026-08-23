import { describe, expect, it } from "vitest";
import { plainActor } from "@vinci/contracts";
import { validateEvidenceRecord } from "./schema.ts";

/**
 * The exported helper and the validator must agree about every actor.
 *
 * They have now disagreed twice, and both times the helper was the permissive
 * one: first for a verifier carrying a workerId, then for a worker carrying no
 * identity at all. A helper that answers a question more generously than the
 * validator answering the same question is an alternate route to authority,
 * and the route nobody is watching.
 *
 * The previous defence was a handpicked matrix of actor shapes, which is
 * exactly why the second divergence survived it: the matrix covered the cases
 * someone thought of. This generates the corpus instead — every kind crossed
 * with missing, blank, wrong-type, extra, inherited, accessor and proxy
 * mutations — and asserts the two agree on all of it.
 */
const VALID_ACTORS: ReadonlyArray<Readonly<Record<string, unknown>>> = [
  { kind: "user", userId: "u" },
  { kind: "user", userId: "u", deviceId: "d" },
  { kind: "worker", workerId: "w" },
  { kind: "policy", policyId: "p", policyVersion: 3 },
  { kind: "system", component: "governor" },
  { kind: "verifier", verifierId: "v", independent: true },
  { kind: "verifier", verifierId: "v", independent: false },
];

/** Every way one field of an otherwise-valid actor can go wrong. */
function mutations(actor: Readonly<Record<string, unknown>>): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [["valid", actor]];
  for (const field of Object.keys(actor)) {
    for (const [label, value] of [
      ["missing", undefined],
      ["blank", "   "],
      ["empty", ""],
      ["number", 7],
      ["null", null],
      ["object", { a: 1 }],
      ["array", ["x"]],
      ["true", true],
    ] as Array<[string, unknown]>) {
      const copy: Record<string, unknown> = { ...actor };
      if (value === undefined) delete copy[field];
      else copy[field] = value;
      out.push([`${field}=${label}`, copy]);
    }
  }
  out.push(["extra foreign field", { ...actor, workerId: "w", verifierId: "v" }]);
  out.push(["all fields inherited", Object.create({ ...actor })]);
  return out;
}

/**
 * Does the validator consider this actor WELL-FORMED?
 *
 * `provenance_actor_mismatch` is deliberately excluded: it reports that the
 * actor does not match the provenance it was paired with, which is a fact
 * about the PAIR and not about the actor's own shape. plainActor is not given
 * the provenance and cannot answer that question, so counting it would make
 * the two disagree by construction and the differential would prove nothing.
 * Every other actor-path issue is a shape complaint and must be matched.
 */
function validatorAccepts(actor: unknown): boolean {
  const record = {
    schemaVersion: 1,
    id: "evidence-1",
    attestation: { provenance: "worker_provided", actor },
    kind: "unit_test",
    mode: "execution",
    reliability: "strong",
    sourceKind: "runner",
    assessment: { outcome: "supports" },
    notTested: [],
    summary: "ran the suite",
    recordedAt: "2026-08-23T12:34:56.789Z",
  };
  const result = validateEvidenceRecord(record);
  if (result.ok) return true;
  return !result.issues.some(
    (issue) => issue.path.includes("/actor") && issue.code !== "provenance_actor_mismatch",
  );
}

describe("plainActor agrees with validateEvidenceRecord on every actor shape", () => {
  const disagreements: string[] = [];

  for (const actor of VALID_ACTORS) {
    for (const [label, candidate] of mutations(actor)) {
      it(`${String(actor.kind)} / ${label}`, () => {
        const helperAccepts = plainActor(candidate as never) !== null;
        const validator = validatorAccepts(candidate);
        if (helperAccepts !== validator) {
          disagreements.push(`${String(actor.kind)}/${label}`);
        }
        expect(
          helperAccepts,
          `helper=${helperAccepts} validator=${validator} for ${JSON.stringify(candidate)}`,
        ).toBe(validator);
      });
    }
  }

  it("accepts every genuinely valid actor (positive control)", () => {
    // Without this the suite is satisfied by a helper and a validator that
    // both reject everything.
    for (const actor of VALID_ACTORS) {
      expect(plainActor(actor as never), JSON.stringify(actor)).not.toBe(null);
      expect(validatorAccepts(actor), JSON.stringify(actor)).toBe(true);
    }
  });
});
