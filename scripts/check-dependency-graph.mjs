#!/usr/bin/env node
/**
 * Enforces the package layering fixed in docs/E0-decisions.md, D2.
 *
 * A cycle between contract packages is not a style problem: it makes the
 * packages unpublishable independently and lets a consumer pull the entire
 * graph to import one type. Catching it here rather than in review is the
 * point — the layering is a decision, so it should fail the build.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(root, "packages");

/** Lower layers may not import from higher ones. Index is the layer number. */
const LAYERS = [
  ["@vinci/contracts"],
  ["@vinci/policy", "@vinci/model-classes", "@vinci/evidence", "@vinci/approvals", "@vinci/device-auth"],
  ["@vinci/receipts", "@vinci/run-events"],
  ["@vinci/worker-protocol", "@vinci/remote-protocol"],
];

const layerOf = new Map();
LAYERS.forEach((names, i) => names.forEach((n) => layerOf.set(n, i)));

const errors = [];

for (const dir of readdirSync(packagesDir)) {
  const manifestPath = join(packagesDir, dir, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const name = manifest.name;

  if (!layerOf.has(name)) {
    errors.push(
      `${name}: not placed in any layer. Add it to LAYERS in this script and to D2 in docs/E0-decisions.md before adding the package.`,
    );
    continue;
  }

  const own = layerOf.get(name);
  for (const dep of Object.keys(manifest.dependencies ?? {})) {
    if (!dep.startsWith("@vinci/")) continue;
    if (!layerOf.has(dep)) {
      errors.push(`${name}: depends on unknown contract package ${dep}`);
      continue;
    }
    const depLayer = layerOf.get(dep);
    if (depLayer >= own) {
      errors.push(
        `${name} (layer ${own}) may not depend on ${dep} (layer ${depLayer}). ` +
          `Dependencies must point strictly downward; see docs/E0-decisions.md D2.`,
      );
    }
  }
}

if (errors.length > 0) {
  console.error("Dependency graph violations:\n");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("Dependency graph OK");
