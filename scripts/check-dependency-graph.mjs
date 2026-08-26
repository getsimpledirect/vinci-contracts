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
import { join, dirname, resolve, relative as relativePath } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(root, "packages");

/** Lower layers may not import from higher ones. Index is the layer number. */
const LAYERS = [
  ["@getsimpledirect/vinci-contracts"],
  ["@getsimpledirect/vinci-policy", "@getsimpledirect/vinci-model-classes", "@getsimpledirect/vinci-evidence", "@getsimpledirect/vinci-approvals", "@getsimpledirect/vinci-device-auth"],
  ["@getsimpledirect/vinci-receipts", "@getsimpledirect/vinci-run-events", "@getsimpledirect/vinci-work-orders"],
  ["@getsimpledirect/vinci-worker-protocol", "@getsimpledirect/vinci-remote-protocol"],
  ["@getsimpledirect/vinci-session-stream", "@getsimpledirect/vinci-worker-capabilities"],
];

const layerOf = new Map();
LAYERS.forEach((names, i) => names.forEach((n) => layerOf.set(n, i)));

/**
 * Every TypeScript source file under a directory, RECURSIVELY.
 *
 * The scan used to call readdirSync once and filter on ".ts", which silently
 * skipped subdirectories: a directory entry does not end in ".ts", so it was
 * dropped by the same line that selected files. An upward import in
 * src/lib/anything.ts passed the whole gate. No package has a nested src
 * directory today, which is exactly why nobody noticed — the check was correct
 * for the tree that existed and wrong for the first one that grows a folder.
 *
 * Extensions beyond .ts are included because tsc compiles them and the scan
 * exists to see what tsc sees.
 */
function sourceFilesUnder(root, prefix = "") {
  const out = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...sourceFilesUnder(root, rel));
      continue;
    }
    if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) out.push(rel);
  }
  return out;
}


/**
 * Read a tsconfig with its `extends` chain resolved.
 *
 * The check previously JSON.parse'd one file and stopped. TypeScript does not:
 * it merges compilerOptions from every config in the extends chain, so a base
 * config carrying `paths` that reach a higher layer produced a violation this
 * saw nothing of. A review constructed exactly that and got "Dependency graph
 * OK". No package uses `extends` today, which is why it went unnoticed — the
 * same shape as the src-subdirectory gap: correct for the tree that exists,
 * wrong for the first one that grows the feature.
 *
 * Only compilerOptions are inherited here, because only compilerOptions are
 * inherited by TypeScript. `references`, `files`, `include` and `exclude` are
 * explicitly NOT inherited through extends, so reading them from a base would
 * report a violation the compiler ignores — fail-closed is the right instinct,
 * but not at the cost of flagging something that cannot actually happen.
 *
 * Cycles and runaway chains terminate rather than hang.
 */
function readTsconfigResolved(tsconfigPath, errors, label) {
  const seen = new Set();
  let current = tsconfigPath;
  const chain = [];
  while (current && !seen.has(current) && chain.length < 16) {
    seen.add(current);
    if (!existsSync(current)) {
      errors.push(`${label}: tsconfig extends ${current}, which does not exist`);
      break;
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(current, "utf8"));
    } catch {
      errors.push(`${label}: ${current} is not parseable JSON`);
      break;
    }
    chain.push(parsed);
    const ext = parsed.extends;
    if (typeof ext !== "string" || ext === "") break;
    // Only relative extends can point inside this repository; a bare specifier
    // resolves into node_modules and is out of scope for the layer rule.
    if (!ext.startsWith(".")) break;
    current = resolve(dirname(current), ext.endsWith(".json") ? ext : `${ext}.json`);
  }
  if (chain.length === 0) return null;

  // Nearest config wins, so merge from the far end of the chain inward.
  const merged = { ...chain[chain.length - 1] };
  const paths = {};
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    Object.assign(paths, chain[i].compilerOptions?.paths ?? {});
  }
  merged.compilerOptions = { ...(merged.compilerOptions ?? {}), paths };
  // References come from the package's OWN config only. See above.
  merged.references = chain[0].references ?? [];
  return merged;
}

const errors = [];

/**
 * Every direct edge observed, from any mechanism, as name -> Set(names).
 * Used for the transitive check below.
 */
const edges = new Map();
function recordEdge(from, to) {
  if (!edges.has(from)) edges.set(from, new Set());
  edges.get(from).add(to);
}

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
  // `@getsimpledirect/vinci-receipts` from any package whether or not that package declares it,
  // and the build succeeds. A reviewer listed this as untested and it was.
  //
  // Two distinct failures are reported here. An upward import is a layering
  // violation. An import of a package the manifest does not declare is a
  // different bug -- it works only by accident of hoisting, and breaks the
  // moment the package is consumed on its own.
  // `dir`, not `name`: the directory is "contracts", the package name is
  // "@getsimpledirect/vinci-contracts". Using the name pointed at a nonexistent
  // packages/@getsimpledirect/vinci-contracts/src path instead of packages/contracts/src,
  // which does not exist, so existsSync was false and this entire scan silently
  // did nothing while the check reported OK. Caught only by mutation testing.
  const srcDir = join(packagesDir, dir, "src");
  if (existsSync(srcDir)) {
    for (const file of sourceFilesUnder(srcDir)) {
      const source = readFileSync(join(srcDir, file), "utf8");
      // Import/export ... from "@getsimpledirect/vinci-x", and dynamic import("@getsimpledirect/vinci-x").
      const seen = new Set();
      // `from`, `import(...)` and `require(...)`. A subpath specifier such as
      // "@getsimpledirect/vinci-contracts/dist/x" is captured too — the package boundary is
      // what the layer rule is about, not the file inside it.
      for (const m of source.matchAll(
        /(?:from|import|require)\s*\(?\s*["']@getsimpledirect\/vinci-([a-z0-9-]+)(?:\/[^"']*)?["']/g,
      )) {
        seen.add(`@getsimpledirect/vinci-${m[1]}`);
      }
      for (const dep of seen) {
        if (!layerOf.has(dep)) {
          errors.push(`${name}/src/${file}: imports unknown contract package ${dep}`);
          continue;
        }
        recordEdge(name, dep);
        if (layerOf.get(dep) >= own) {
          errors.push(
            `${name}/src/${file}: imports ${dep} (layer ${layerOf.get(dep)}) from layer ${own}. `
              + "Imports must point strictly downward.",
          );
        }
      }
    }
  }

  // TSCONFIG EDGES: project references and path aliases.
  //
  // Both are real build edges that neither the manifest scan nor the source
  // scan can see, and `references` is not hypothetical — eight of nine packages
  // use it today. A reference makes tsc build the target and puts its types on
  // the import path, so an upward reference couples the layers exactly as
  // firmly as a dependency does, while declaring nothing in package.json.
  //
  // `paths` aliases are empty everywhere today. They are checked anyway,
  // because the cost of checking is a few lines and the cost of not checking is
  // that the first alias anyone adds is unexamined.
  const tsconfigPath = join(packagesDir, dir, "tsconfig.json");
  if (existsSync(tsconfigPath)) {
    const tsconfig = readTsconfigResolved(tsconfigPath, errors, name);
    if (tsconfig) {
      // A reference path is relative, e.g. "../contracts". Map the directory
      // back to a package name via its manifest, so a renamed directory cannot
      // silently escape the check.
      for (const ref of tsconfig.references ?? []) {
        // Resolve the reference properly rather than string-stripping "../".
        //
        // An ABSOLUTE reference path was previously reported as "not a package
        // here", which failed closed but said something false: it IS a package,
        // just referenced absolutely. A wrong message is not a harmless
        // cosmetic — it sends the next reader looking for a missing package
        // instead of at the layering violation actually in front of them.
        const refPath = String(ref.path ?? "");
        const resolved = resolve(join(packagesDir, dir), refPath);
        const relative = relativePath(packagesDir, resolved);
        const refDir = relative.split(/[\\/]/)[0];
        const refManifest = join(packagesDir, refDir, "package.json");
        if (relative.startsWith("..") || refDir === "" || !existsSync(refManifest)) {
          errors.push(
            `${name}: tsconfig references ${refPath}, which does not resolve to a package in this repository`,
          );
          continue;
        }
        const refName = JSON.parse(readFileSync(refManifest, "utf8")).name;
        if (!layerOf.has(refName)) {
          errors.push(`${name}: tsconfig references unknown contract package ${refName}`);
          continue;
        }
        recordEdge(name, refName);
        if (layerOf.get(refName) >= own) {
          errors.push(
            `${name}: tsconfig references ${refName} (layer ${layerOf.get(refName)}) from layer ${own}. `
              + "Project references must point strictly downward.",
          );
        }
      }

      for (const [alias, targets] of Object.entries(tsconfig.compilerOptions?.paths ?? {})) {
        for (const target of targets) {
          const match = /packages\/([a-z0-9-]+)\//.exec(String(target));
          const aliasedName = match ? `@getsimpledirect/vinci-${match[1]}` : String(alias).replace(/\/\*$/, "");
          if (!layerOf.has(aliasedName)) continue;
          if (layerOf.get(aliasedName) >= own) {
            errors.push(
              `${name}: tsconfig path alias ${alias} -> ${target} reaches ${aliasedName} `
                + `(layer ${layerOf.get(aliasedName)}) from layer ${own}. Aliases must point strictly downward.`,
            );
          }
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
    if (!dep.startsWith("@getsimpledirect/vinci-")) continue;
    if (!layerOf.has(dep)) {
      errors.push(`${name}: depends on unknown contract package ${dep}`);
      continue;
    }
    recordEdge(name, dep);
    const depLayer = layerOf.get(dep);
    if (depLayer >= own) {
      errors.push(
        `${name} (layer ${own}) may not depend on ${dep} (layer ${depLayer}). ` +
          `Dependencies must point strictly downward; see docs/E0-decisions.md D2.`,
      );
    }
  }
}

/**
 * TRANSITIVE reachability, not just direct edges.
 *
 * The direct rule already implies this. If every edge satisfies
 * layer(to) < layer(from), then along any path the layer strictly decreases at
 * each step, so the start's layer exceeds the end's — by induction on path
 * length, every reachable pair points downward. Cycles are impossible for the
 * same reason: one would require a layer to be strictly less than itself.
 *
 * It is checked anyway, and not from distrust of the arithmetic. That
 * conclusion holds only if the direct check SEES every edge, and this
 * repository has now found four separate edge mechanisms — dependencies,
 * devDependencies and friends, source imports, and tsconfig references — three
 * of which were invisible when first looked for. The closure runs over whatever
 * edges were actually observed, so a future missed mechanism surfaces as a
 * violation rather than as silence.
 *
 * It also turns an argument into a test. A proof in a comment is exactly the
 * kind of thing that stays in the comment after the code beneath it changes.
 */
for (const [from, directTargets] of edges) {
  const ownLayer = layerOf.get(from);
  if (ownLayer === undefined) continue;
  const seen = new Set();
  const queue = [...directTargets];
  while (queue.length > 0) {
    const next = queue.shift();
    if (seen.has(next)) continue;
    seen.add(next);
    if (next === from) {
      errors.push(`${from}: reachable from itself — the package graph has a cycle`);
      continue;
    }
    const nextLayer = layerOf.get(next);
    if (nextLayer !== undefined && nextLayer >= ownLayer) {
      errors.push(
        `${from} (layer ${ownLayer}) transitively reaches ${next} (layer ${nextLayer}). `
          + "Reachability must point strictly downward.",
      );
    }
    for (const onward of edges.get(next) ?? []) queue.push(onward);
  }
}

if (errors.length > 0) {
  console.error("Dependency graph violations:\n");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("Dependency graph OK");
