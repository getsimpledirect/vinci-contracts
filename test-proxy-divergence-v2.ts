import { plainActor } from "./packages/contracts/src/actor.ts";
import { toPlainRecord } from "./packages/contracts/src/plain-record.ts";

console.log("=== Test 1: Proxy with honest descriptors, lying get trap ===");
const target1 = { kind: "worker", workerId: "w" };
const proxy1 = new Proxy(target1, {
  get: (t, p) =>
    p === "kind" ? "verifier" :
    p === "independent" ? true :
    Reflect.get(t, p),
  getOwnPropertyDescriptor: Reflect.getOwnPropertyDescriptor,
  ownKeys: Reflect.ownKeys,
});

const descriptors = Object.getOwnPropertyDescriptor(proxy1, "kind");
console.log("Descriptor for 'kind':", descriptors?.value);
console.log("Proxy.get('kind'):", (proxy1 as any).kind);
console.log("Proxy.get('independent'):", (proxy1 as any).independent);

const snapshot1 = plainActor(proxy1);
console.log("plainActor result:", snapshot1 ? JSON.stringify(snapshot1) : "null");

const plainResult1 = toPlainRecord(proxy1);
console.log("toPlainRecord result:", plainResult1.ok ? JSON.stringify(plainResult1.value) : "ERROR");

console.log();

// The key question: what does the OLD code (descriptor-walking) have returned?
// The commit says descriptors would report { kind: "worker", workerId: "w" }
// but toPlainRecord reports { kind: "verifier", workerId: "w" }
// So old code might have been MORE permissive in some cases and LESS permissive in others.

// Let me test the opposite: a Proxy that makes toPlainRecord see something
// LESS valid than descriptors would say.

console.log("=== Test 2: Check for permissive direction divergence ===");
// Scenario: plainActor might accept something validateEvidenceRecord refuses
// This would mean plainActor sees a more permissive view than the validators

const proxy2 = new Proxy({}, {
  get: (t, p) => {
    if (p === "kind") return "worker";
    if (p === "workerId") return "w-123";
    return undefined;
  },
  getOwnPropertyDescriptor: (t, p) => {
    // Lie: claim 'invalid_field' is an own property
    if (p === "kind" || p === "workerId") {
      return { value: undefined, enumerable: true, writable: true, configurable: true };
    }
    if (p === "invalid_field") {
      return { value: "extra", enumerable: true, writable: true, configurable: true };
    }
    return undefined;
  },
  ownKeys: () => ["kind", "workerId", "invalid_field"],
});

console.log("Proxy reports via descriptors/keys: kind, workerId, invalid_field");
console.log("Proxy reports via get: kind=worker, workerId=w-123, invalid_field=undefined");

const snapshot2 = plainActor(proxy2);
console.log("plainActor result:", snapshot2 ? JSON.stringify(snapshot2) : "null");

const plainResult2 = toPlainRecord(proxy2);
console.log("toPlainRecord result:", plainResult2.ok ? JSON.stringify(plainResult2.value) : "ERROR");
