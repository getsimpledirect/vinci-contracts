import { describe, expect, it } from "vitest";
import { actorFieldsAreConsistent } from "./actor.ts";

describe("an actor's fields must be its OWN data", () => {
  it("refuses an actor whose fields are all inherited", () => {
    // The attack this function replaced a denylist to prevent, working again
    // one level up the prototype chain. The object has no own keys, so
    // "every own field is permitted" was vacuously true — while
    // actor.independent still read back as true to everything downstream.
    const hostile = Object.create({ kind: "verifier", verifierId: "v", independent: true });
    expect(Object.keys(hostile)).toEqual([]);
    expect(actorFieldsAreConsistent(hostile)).toBe(false);
    // The same claim as an own key is refused, which is what made the
    // prototype route worth taking.
    expect(
      actorFieldsAreConsistent({ kind: "worker", workerId: "w", independent: true }),
    ).toBe(false);
  });

  it("refuses accessors, which can answer differently on a later read", () => {
    expect(actorFieldsAreConsistent({ get kind() { return "worker"; }, workerId: "w" })).toBe(false);
    expect(actorFieldsAreConsistent({ kind: "worker", get workerId() { return "w"; } })).toBe(false);
  });

  it("refuses hostile input instead of throwing", () => {
    const hostile: unknown[] = [
      { get kind(): never { throw new Error("g"); } },
      new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("gopd"); } }),
      { kind: "toString" },
      { kind: "constructor" },
      null,
      undefined,
      [],
      "worker",
      7,
    ];
    for (const actor of hostile) {
      expect(() => actorFieldsAreConsistent(actor as never)).not.toThrow();
      expect(actorFieldsAreConsistent(actor as never)).toBe(false);
    }
  });

  it("still accepts genuine actors", () => {
    // Positive controls. A function returning false for everything satisfies
    // every case above and destroys the only thing this is for.
    expect(actorFieldsAreConsistent({ kind: "worker", workerId: "w" })).toBe(true);
    expect(actorFieldsAreConsistent({ kind: "verifier", verifierId: "v", independent: true })).toBe(true);
    expect(actorFieldsAreConsistent({ kind: "user", userId: "u" })).toBe(true);
    expect(actorFieldsAreConsistent({ kind: "user", userId: "u", deviceId: "d" })).toBe(true);
    // And still catches the foreign-field case it was written for.
    expect(actorFieldsAreConsistent({ kind: "verifier", verifierId: "v", workerId: "w" })).toBe(false);
  });
});
