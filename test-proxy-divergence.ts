// Test Property A: plainActor returns one inert frozen snapshot
// and no Proxy/getter/inherited field can make it disagree with
// validateEvidenceRecord about the same object IN THE PERMISSIVE DIRECTION

import { plainActor } from "./packages/contracts/src/actor.ts";
import { toPlainRecord } from "./packages/contracts/src/plain-record.ts";

// Test Case 1: Proxy with honest descriptors but lying get trap
// Descriptors say: { kind: "worker", workerId: "w" }
// get trap says: kind -> "verifier", independent -> true
const target1 = { kind: "worker", workerId: "w" };
const proxy1 = new Proxy(target1, {
  get: (t, p) =>
    p === "kind" ? "verifier" :
    p === "independent" ? true :
    Reflect.get(t, p),
  getOwnPropertyDescriptor: Reflect.getOwnPropertyDescriptor,
  ownKeys: Reflect.ownKeys,
});

console.log("=== Test Case 1: Proxy with honest descriptors, lying get trap ===");
console.log("Target has:", JSON.stringify(target1));

// Check what descriptors say
const descriptors = Object.getOwnPropertyDescriptor(proxy1, "kind");
console.log("Descriptor for 'kind':", descriptors);

// Check what get trap says
console.log("Proxy.get('kind'):", (proxy1 as any).kind);
console.log("Proxy.get('independent'):", (proxy1 as any).independent);

// Check what plainActor returns
const snapshot1 = plainActor(proxy1);
console.log("plainActor result:", snapshot1 ? JSON.stringify(snapshot1) : "null");

// Check what toPlainRecord returns
const plainResult1 = toPlainRecord(proxy1);
console.log("toPlainRecord result:", plainResult1.ok ? JSON.stringify(plainResult1.value) : plainResult1.err);

console.log();

// Test Case 2: Fresh instance per call to check for stateful traps
console.log("=== Test Case 2: Fresh instances (no shared state) ===");
function makeProxy() {
  const target = { kind: "worker", workerId: "w" };
  return new Proxy(target, {
    get: (t, p) =>
      p === "kind" ? "verifier" :
      p === "independent" ? true :
      Reflect.get(t, p),
    getOwnPropertyDescriptor: Reflect.getOwnPropertyDescriptor,
    ownKeys: Reflect.ownKeys,
  });
}

const proxy2a = makeProxy();
const snapshot2a = plainActor(proxy2a);
console.log("plainActor on fresh instance 1:", snapshot2a ? JSON.stringify(snapshot2a) : "null");

const proxy2b = makeProxy();
const plainResult2b = toPlainRecord(proxy2b);
console.log("toPlainRecord on fresh instance 2:", plainResult2b.ok ? JSON.stringify(plainResult2b.value) : plainResult2b.err);

// They should be inert snapshots that don't hold the original object
console.log("snapshot is frozen:", Object.isFrozen(snapshot2a));
console.log("snapshot is plain object:", Object.getPrototypeOf(snapshot2a) === Object.prototype || Object.getPrototypeOf(snapshot2a) === null);

console.log();

// Test Case 3: Can we make plainActor more permissive than validators?
console.log("=== Test Case 3: Testing permissiveness divergence ===");
const evilProxy = new Proxy({}, {
  get: (t, p) => {
    if (p === "kind") return "worker";
    if (p === "workerId") return "w-123";
    if (p === Symbol.toStringTag) return undefined;
    return undefined;
  },
  getOwnPropertyDescriptor: (t, p) => {
    // Lie: claim these properties exist
    if (p === "kind" || p === "workerId") {
      return { value: "", enumerable: true, writable: true, configurable: true };
    }
    return Reflect.getOwnPropertyDescriptor(t, p);
  },
  ownKeys: () => ["kind", "workerId"],
});

const evilSnapshot = plainActor(evilProxy);
console.log("plainActor on evil proxy:", evilSnapshot ? JSON.stringify(evilSnapshot) : "null");

const evilPlain = toPlainRecord(evilProxy);
console.log("toPlainRecord on evil proxy:", evilPlain.ok ? JSON.stringify(evilPlain.value) : evilPlain.err);
