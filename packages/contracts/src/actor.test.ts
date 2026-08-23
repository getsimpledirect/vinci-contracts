import { describe, expect, it } from "vitest";
import { actorFieldsAreConsistent, plainActor } from "./actor.ts";

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

describe("an actor is snapshotted once, so a Proxy cannot serve two views", () => {
  /** Honest to reflection, lying to property access. */
  const twoFaced = () =>
    new Proxy({ kind: "worker", workerId: "w" }, {
      get(target, prop, receiver) {
        if (prop === "kind") return "verifier";
        if (prop === "independent") return true;
        return Reflect.get(target, prop, receiver);
      },
      getOwnPropertyDescriptor: (t, p) => Reflect.getOwnPropertyDescriptor(t, p),
      ownKeys: (t) => Reflect.ownKeys(t),
    });

  it("gives reflection and property access genuinely different answers", () => {
    // Pin the premise. If this ever stops holding the test below proves nothing.
    const proxy = twoFaced();
    expect(Object.getOwnPropertyDescriptor(proxy, "kind")?.value).toBe("worker");
    expect((proxy as unknown as { kind: string }).kind).toBe("verifier");
  });

  it("returns the reflected view, and the same view every time", () => {
    const snapshot = plainActor(twoFaced() as never);
    expect(snapshot?.kind).toBe("worker");
    expect(snapshot?.independent).toBeUndefined();
    // Frozen and null-prototype: nothing downstream can be handed a second view.
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.getPrototypeOf(snapshot)).toBe(null);
  });

  it("refuses a descriptor trap that changes its answer between reads", () => {
    let reads = 0;
    const shifting = new Proxy({ kind: "worker", workerId: "w" }, {
      getOwnPropertyDescriptor(target, prop) {
        reads += 1;
        if (prop === "kind") {
          return { value: reads > 2 ? "verifier" : "worker", writable: true, enumerable: true, configurable: true };
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
      ownKeys: (t) => Reflect.ownKeys(t),
    });
    // Whatever it says, it says once — and a verifier carrying a workerId is
    // not a consistent actor, so the shifted view is refused outright.
    const snapshot = plainActor(shifting as never);
    expect(snapshot === null || snapshot.kind === "worker").toBe(true);
  });

  it("still snapshots honest actors", () => {
    // Positive controls. Returning null for everything satisfies every case
    // above and makes the function useless.
    expect(plainActor({ kind: "worker", workerId: "w" })?.kind).toBe("worker");
    expect(plainActor({ kind: "verifier", verifierId: "v", independent: true })?.independent).toBe(true);
    expect(plainActor({ kind: "verifier", verifierId: "v", workerId: "w" })).toBe(null);
  });
});
