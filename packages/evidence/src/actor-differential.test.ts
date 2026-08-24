import { describe, expect, it } from "vitest";
import { plainActor } from "@getsimpledirect/vinci-contracts";
import { validateEvidenceRecord } from "./schema.ts";

/**
 * The exported helper must never be MORE PERMISSIVE than the validator.
 *
 * An earlier version of this file promised something stronger and false: that
 * the two agree on every actor shape. An independent review falsified it with
 *
 *   { get kind() { return "worker"; }, workerId: "w" }
 *
 * which plainActor then REJECTED and validateEvidenceRecord ACCEPTED, because
 * the two used different read disciplines — one walked descriptors, the other
 * snapshotted through toPlainRecord.
 *
 * That divergence is now GONE rather than documented: plainActor defers to
 * toPlainRecord, so both see the value serialization captures, and an accessor
 * is accepted by both. Serialization invokes the getter exactly once and stores
 * the result as data, so there is no later read for it to answer differently.
 *
 * The property that actually protects anything is DIRECTIONAL. A helper
 * stricter than the validator costs a caller a rejection. A helper looser than
 * the validator is an alternate, unwatched route to authority — which is what
 * both real divergences here were: a verifier carrying a workerId, and a worker
 * carrying no identity at all.
 *
 * So: equality is asserted for plain-data actors, where the two see the same
 * value and any difference is a genuine defect; and the one-way implication is
 * asserted for live objects, where a difference is expected and only the
 * permissive direction is a bug.
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
 * Actors that are LIVE objects rather than plain data.
 *
 * The mutation class the previous corpus omitted, and the omission is the
 * reason the false promise survived: every generated case above is plain data,
 * so the two functions saw identical values and could not disagree.
 */
/**
 * Actors that are not objects at all.
 *
 * The mutation class the corpus omitted, found by an independent review. Every
 * generated case elsewhere in this file starts from a valid actor object and
 * mutates a FIELD, so nothing ever asked what happens when the actor is not an
 * object in the first place.
 */
function nonObjectActors(): Array<[string, () => unknown]> {
  return [
    ["a function", () => function actor() {}],
    ["an arrow function", () => () => undefined],
    ["a class", () => class Actor {}],
    ["an array", () => []],
    ["an array of one valid actor", () => [{ kind: "worker", workerId: "w" }]],
    ["a number", () => 7],
    ["a string", () => "worker"],
    ["a boolean", () => true],
    ["null", () => null],
    ["undefined", () => undefined],
    ["a symbol", () => Symbol("worker")],
    ["a bigint", () => 1n],
    ["a Date", () => new Date(0)],
    ["a Map", () => new Map([["kind", "worker"]])],
  ];
}

function liveObjectActors(): Array<[string, () => unknown]> {
  // FACTORIES, not instances. A stateful trap advances on every call, so
  // handing the SAME object to the helper and then to the validator compares
  // two different object states and calls the difference a disagreement. That
  // flaw was real in the first version of this file, and it is the kind of
  // thing that manufactures a finding out of nothing.
  const base = () => ({ kind: "worker", workerId: "w" });
  return [
    ["kind is an accessor", () => ({ get kind() { return "worker"; }, workerId: "w" })],
    ["identifier is an accessor", () => ({ kind: "worker", get workerId() { return "w"; } })],
    ["accessor returning a foreign kind", () => ({ get kind() { return "verifier"; }, workerId: "w" })],
    ["a throwing getter", () => ({ get kind(): never { throw new Error("hostile"); }, workerId: "w" })],
    ["a two-faced proxy", () => new Proxy(base(), {
      get: (target, prop, receiver) =>
        prop === "kind" ? "verifier" : prop === "independent" ? true : Reflect.get(target, prop, receiver),
      getOwnPropertyDescriptor: (target, prop) => Reflect.getOwnPropertyDescriptor(target, prop),
      ownKeys: (target) => Reflect.ownKeys(target),
    })],
    ["a proxy whose descriptor shifts between reads", () => {
      let flips = 0;
      return new Proxy(base(), {
      getOwnPropertyDescriptor(target, prop) {
        flips += 1;
        if (prop === "kind") {
          return { value: flips > 2 ? "verifier" : "worker", writable: true, enumerable: true, configurable: true };
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
      ownKeys: (target) => Reflect.ownKeys(target),
      });
    }],
    ["a proxy that throws from ownKeys", () => new Proxy(base(), { ownKeys() { throw new Error("ownKeys"); } })],
  ];
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

  // A ROOT-level failure means the record never validated at all, so the
  // validator cannot be said to have accepted anything inside it.
  //
  // This oracle previously looked only for issues under "/actor", and a
  // function-valued actor is refused with `unsupported_value` at path "" —
  // which does not contain "/actor". So the harness reported ACCEPTED for a
  // record the validator had wholly refused. Every root-level rejection was
  // invisible to it: unsupported values, cycles, size caps, non-objects.
  //
  // An oracle that reports acceptance for rejected input can only mask a
  // permissive gap, never create one, which is exactly why it would have gone
  // unnoticed until it mattered.
  // ANY issue means the actor was not accepted, wherever it is reported.
  //
  // This oracle has now been wrong twice in the same direction. First it looked
  // only under "/actor", so a function-valued actor refused at the root path ""
  // read as ACCEPTED. Adding a root check fixed that case and left the general
  // one: a hostile actor can invalidate a path that is neither the root nor the
  // actor subtree — it is the only thing varying in this record — and the
  // oracle would still call it accepted.
  //
  // Every other field here is fixed by the template, so ANY complaint is
  // attributable to the actor. The single exception is
  // `provenance_actor_mismatch`, which reports that the actor does not match
  // the provenance it was PAIRED with; plainActor is never shown the
  // provenance and cannot answer that, so counting it would make the two
  // disagree by construction.
  return result.issues.every((issue) => issue.code === "provenance_actor_mismatch");
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

  for (const [label, make] of liveObjectActors()) {
    it(`live object / ${label}: helper is never more permissive`, () => {
      // A FRESH instance for each call, so a stateful trap cannot make one
      // call observe what the other advanced past.
      let helperAccepts = false;
      let validator = false;
      expect(() => { helperAccepts = plainActor(make() as never) !== null; }).not.toThrow();
      expect(() => { validator = validatorAccepts(make()); }).not.toThrow();
      if (helperAccepts) {
        expect(
          validator,
          `plainActor accepted what the validator refused: ${label} — an unwatched route to authority`,
        ).toBe(true);
      }
    });
  }

  for (const [label, make] of nonObjectActors()) {
    it(`non-object / ${label}: helper is never more permissive`, () => {
      let helperAccepts = false;
      let validator = false;
      expect(() => { helperAccepts = plainActor(make() as never) !== null; }).not.toThrow();
      expect(() => { validator = validatorAccepts(make()); }).not.toThrow();
      if (helperAccepts) {
        expect(
          validator,
          `plainActor accepted a ${label} that the validator refused — an unwatched route to authority`,
        ).toBe(true);
      }
    });
  }

  it("refuses every non-object actor outright", () => {
    // Stronger than the directional check: none of these is an actor at all,
    // so both sides must refuse. If any starts being accepted, something has
    // begun coercing non-objects into records.
    for (const [label, make] of nonObjectActors()) {
      expect(plainActor(make() as never), label).toBe(null);
      expect(validatorAccepts(make()), label).toBe(false);
    }
  });

  it("agrees on the accessor case a review used to falsify the promise", () => {
    // This case previously DIVERGED — the helper refused it and the validator
    // accepted it — because the two used different read disciplines. They now
    // share one, so they agree, and the divergence is eliminated rather than
    // documented.
    const accessor = { get kind() { return "worker"; }, workerId: "w" };
    expect(plainActor(accessor as never) !== null).toBe(validatorAccepts(accessor));
    // And the captured value is the getter's single invocation, as data.
    expect(plainActor(accessor as never)?.kind).toBe("worker");
  });

  it("sees the same actor the validator sees, even through a two-faced proxy", () => {
    // The gap the directional check caught: descriptors said "worker" while
    // serialization said "verifier", so the stored record and the authority
    // decision described different actors.
    const proxy = new Proxy({ kind: "worker", workerId: "w" }, {
      get: (target, prop, receiver) =>
        prop === "kind" ? "verifier" : prop === "independent" ? true : Reflect.get(target, prop, receiver),
      getOwnPropertyDescriptor: (target, prop) => Reflect.getOwnPropertyDescriptor(target, prop),
      ownKeys: (target) => Reflect.ownKeys(target),
    });
    expect(plainActor(proxy as never) !== null).toBe(validatorAccepts(proxy));
  });

  it("accepts every genuinely valid actor (positive control)", () => {
    // Without this the suite is satisfied by a helper and a validator that
    // both reject everything.
    for (const actor of VALID_ACTORS) {
      expect(plainActor(actor as never), JSON.stringify(actor)).not.toBe(null);
      expect(validatorAccepts(actor), JSON.stringify(actor)).toBe(true);
    }
  });
});
