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
  // EVERY dependency section, not just "dependencies".
  //
  // The layer rule was enforced against runtime dependencies alone, so an
  // upward edge declared as a devDependency, peerDependency or
  // optionalDependency was invisible — a synthetic contracts-to-
  // remote-protocol devDependency passed this check. A layering violation is a
  // violation whichever section declares it: the import compiles either way,
  // and a test importing upward couples the layers as firmly as source does.
  // SOURCE imports, not just manifest entries.
  //
  // The layer rule was enforced against declared dependencies alone, so an
  // import that no manifest mentions was invisible: workspace hoisting resolves
  // `@vinci/receipts` from any package whether or not that package declares it,
  // and the build succeeds. A reviewer listed this as untested and it was.
  //
  // Two distinct failures are reported here. An upward import is a layering
  // violation. An import of a package the manifest does not declare is a
  // different bug -- it works only by accident of hoisting, and breaks the
  // moment the package is consumed on its own.
  // `dir`, not `name`: the directory is "contracts", the package name is
  // "@vinci/contracts". Using the name pointed at packages/@vinci/contracts/src,
  // which does not exist, so existsSync was false and this entire scan silently
  // did nothing while the check reported OK. Caught only by mutation testing.
  const srcDir = join(packagesDir, dir, "src");
  if (existsSync(srcDir)) {
    for (const file of readdirSync(srcDir)) {
      if (!file.endsWith(".ts")) continue;
      const source = readFileSync(join(srcDir, file), "utf8");
      // Import/export ... from "@vinci/x", and dynamic import("@vinci/x").
      const seen = new Set();
      for (const m of source.matchAll(/(?:from|import)\s*\(?\s*["']@vinci\/([a-z0-9-]+)["']/g)) {
        seen.add(`@vinci/${m[1]}`);
      }
      for (const dep of seen) {
        if (!layerOf.has(dep)) {
          errors.push(`${name}/src/${file}: imports unknown contract package ${dep}`);
          continue;
        }
        if (layerOf.get(dep) >= own) {
          errors.push(
            `${name}/src/${file}: imports ${dep} (layer ${layerOf.get(dep)}) from layer ${own}. `
              + "Imports must point strictly downward.",
          );
        }
      }
    }
  }

  const declaredDeps = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
  };
  for (const dep of Object.keys(declaredDeps)) {
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
