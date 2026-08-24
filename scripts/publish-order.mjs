#!/usr/bin/env node
/**
 * Print the packages in dependency order, one per line.
 *
 * The release workflow publishes in this order because lockstep pinning makes
 * order matter: an exact `"0.1.0"` dependency cannot resolve until that exact
 * version exists in the registry, so publishing remote-protocol before contracts
 * leaves a tarball on the registry that nobody can install.
 *
 * DERIVED, never hand-written. The first draft of the release workflow listed
 * all ten names inline, which is the same defect that let a package with no
 * build in its tarball pass the consumer check: a hand-maintained list omits
 * whatever was added after someone last looked at it, and omission here means a
 * package that silently never ships.
 */
import {
  assertExpectedInventory,
  internalDeps,
  readManifests,
  RUNTIME_SECTIONS,
} from "./lib/inventory.mjs";

const manifests = readManifests();
assertExpectedInventory(manifests);

// Runtime sections only. devDependencies are excluded on purpose — a dev-only
// edge does not have to exist in the registry for a consumer to install this
// package, and including it could impose an order the real graph does not need.
//
// optionalDependencies ARE included, and were missing: an optional edge still
// has to resolve when npm tries it, so publishing the dependent first leaves a
// window where the optional install fails for everyone who hits it.
const byName = new Map(
  manifests.map(({ dir, name, manifest }) => [
    name,
    { dir, deps: internalDeps(manifest, RUNTIME_SECTIONS).map((edge) => edge.dep) },
  ]),
);

const order = [];
const state = new Map();
function visit(name, trail) {
  if (state.get(name) === "done") return;
  if (state.get(name) === "visiting") {
    // check-dependency-graph.mjs is what normally catches this. Reaching it here
    // means publishing was about to happen with a cycle in the graph, and there
    // is no order that would work.
    console.error(`dependency cycle: ${[...trail, name].join(" -> ")}`);
    process.exit(1);
  }
  state.set(name, "visiting");
  for (const dep of byName.get(name)?.deps ?? []) {
    if (!byName.has(dep)) {
      console.error(`${name} depends on ${dep}, which is not a package in this repository`);
      process.exit(1);
    }
    visit(dep, [...trail, name]);
  }
  state.set(name, "done");
  order.push(name);
}
for (const name of [...byName.keys()].sort()) visit(name, []);

if (order.length !== byName.size) {
  console.error(`ordered ${order.length} of ${byName.size} packages — this scan is broken`);
  process.exit(1);
}

for (const name of order) console.log(byName.get(name).dir);
