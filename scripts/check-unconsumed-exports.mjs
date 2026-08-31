#!/usr/bin/env node
/**
 * Detects exported schema types and values that nothing consumes.
 *
 * This repository publishes contract packages for the rest of the Vinci estate.
 * A schema can be designed, reviewed, merged — and then drift out of sync with
 * reality while looking healthy, because tests only test it against itself.
 * The defect is invisible to test coverage by construction: an unused export is
 * perfectly correct code.
 *
 * This gate makes it visible by counting references from outside the defining
 * module for every export, distinguishing between genuine external use
 * (external packages or other modules), test-only use, and no use at all.
 * An allowlist supports genuinely-external API types; a reason field is mandatory
 * so the allowlist does not decay into unmaintained cruft.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative as relativePath, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
let rootDir = process.cwd();
let strictMode = false;
const consumerPaths = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--root") {
    rootDir = args[i + 1];
    i++;
  } else if (args[i] === "--consumers") {
    const value = args[i + 1];
    if (!value || value.startsWith("--")) {
      console.error("Argument error: --consumers requires a comma-separated path list");
      process.exit(2);
    }
    consumerPaths.push(...value.split(",").map((path) => path.trim()).filter(Boolean));
    i++;
  } else if (args[i] === "--strict") {
    strictMode = true;
  }
}

rootDir = resolve(rootDir);

const consumers = consumerPaths.map((path) => ({
  displayPath: path,
  path: resolve(path),
  exists: existsSync(resolve(path)),
  filesScanned: 0,
  // Caches *matches* (export names -> referring files) after the single walk.
  // It deliberately never caches file contents.
  matches: null,
}));

const packagesDir = join(rootDir, "packages");
const scriptsDir = join(rootDir, "scripts");
const allowlistPath = join(scriptsDir, "expected-unconsumed.json");

function findExportsInFile(filePath) {
  const source = readFileSync(filePath, "utf8");
  const exports = new Map();
  for (const match of source.matchAll(/export\s+(?:const|let|var)\s+(\w+)\b/g)) {
    exports.set(match[1], "const");
  }
  for (const match of source.matchAll(/export\s+type\s+(\w+)\b/g)) {
    exports.set(match[1], "type");
  }
  for (const match of source.matchAll(/export\s+interface\s+(\w+)\b/g)) {
    exports.set(match[1], "interface");
  }
  for (const match of source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*\(/g)) {
    exports.set(match[1], "function");
  }
  for (const match of source.matchAll(/export\s+class\s+(\w+)\b/g)) {
    exports.set(match[1], "class");
  }
  for (const match of source.matchAll(/export\s+enum\s+(\w+)\b/g)) {
    exports.set(match[1], "enum");
  }
  return exports;
}

function tracePackageExports(packageDir) {
  const indexPath = join(packageDir, "src", "index.ts");
  if (!existsSync(indexPath)) {
    return new Map();
  }

  const source = readFileSync(indexPath, "utf8");
  const traced = new Map();

  for (const match of source.matchAll(/export\s+\*\s+from\s+["']\.\/([^"']+)["']/g)) {
    const moduleFile = match[1];
    const modulePath = join(packageDir, "src", moduleFile);
    if (existsSync(modulePath)) {
      const moduleExports = findExportsInFile(modulePath);
      for (const [name] of moduleExports) {
        traced.set(name, moduleFile);
      }
    }
  }

  const indexExports = findExportsInFile(indexPath);
  for (const [name] of indexExports) {
    traced.set(name, "index.ts");
  }

  return traced;
}

function stripCommentsAndStrings(source) {
  let result = "";
  let i = 0;
  while (i < source.length) {
    // Single-line comment
    if (source[i] === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      result += "\n";
      i++;
      continue;
    }
    // Multi-line comment
    if (source[i] === "/" && source[i + 1] === "*") {
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") result += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    // Double-quoted string
    if (source[i] === '"') {
      result += " ";
      i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    // Single-quoted string
    if (source[i] === "'") {
      result += " ";
      i++;
      while (i < source.length && source[i] !== "'") {
        if (source[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    // Template string
    if (source[i] === "`") {
      result += " ";
      i++;
      while (i < source.length && source[i] !== "`") {
        if (source[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    result += source[i];
    i++;
  }
  return result;
}

const vinciModuleLiteral = String.raw`["']@getsimpledirect\/vinci-[^"'\s]+["']`;

function extractVinciImports(source) {
  // Preserve Vinci module literals while masking comments and all other
  // strings, so import-like text in either cannot create false references.
  const importSource = source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
    (token) => (
      /^["']@getsimpledirect\/vinci-[^"'\s]+["']$/.test(token)
        ? token
        : token.replace(/[^\r\n]/g, " ")
    ),
  );
  const bindings = new Map();
  const namespaces = new Set();
  const directImports = new Set();
  let importsEverything = false;

  function addBinding(importedName, localName) {
    if (!/^\w+$/.test(importedName) || !/^\w+$/.test(localName)) return;
    if (!bindings.has(importedName)) bindings.set(importedName, new Set());
    bindings.get(importedName).add(localName);
  }

  function parseNamedImports(list, aliasPattern, addName) {
    for (let item of list.split(",")) {
      item = item.trim().replace(/^type\s+/, "");
      if (!item) continue;
      const [importedName, localName = importedName] = item.split(aliasPattern);
      addName(importedName.trim(), localName.trim());
    }
  }

  const staticImportPattern = new RegExp(
    String.raw`\bimport\s+(?:type\s+)?([\w\s{},*$]+?)\s+from\s+${vinciModuleLiteral}`,
    "g",
  );
  for (const match of importSource.matchAll(staticImportPattern)) {
    const named = match[1].match(/\{([^}]*)\}/s);
    if (named) parseNamedImports(named[1], /\s+as\s+/, addBinding);
    const namespace = match[1].match(/\*\s+as\s+(\w+)/);
    if (namespace) namespaces.add(namespace[1]);
  }

  const reexportPattern = new RegExp(
    String.raw`\bexport\s+(?:type\s+)?(\*\s*(?:as\s+\w+)?|\{[^}]*\})\s+from\s+${vinciModuleLiteral}`,
    "g",
  );
  for (const match of importSource.matchAll(reexportPattern)) {
    if (match[1].trim().startsWith("*")) {
      importsEverything = true;
    } else {
      parseNamedImports(match[1].slice(1, -1), /\s+as\s+/, (importedName) => {
        if (/^\w+$/.test(importedName)) directImports.add(importedName);
      });
    }
  }

  const requireCall = String.raw`require\s*\(\s*${vinciModuleLiteral}\s*\)`;
  const dynamicImportCall = String.raw`import\s*\(\s*${vinciModuleLiteral}\s*\)`;

  for (const match of importSource.matchAll(new RegExp(
    String.raw`\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*${requireCall}`,
    "g",
  ))) {
    parseNamedImports(match[1], /\s*:\s*/, addBinding);
  }
  for (const match of importSource.matchAll(new RegExp(
    String.raw`\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+${dynamicImportCall}`,
    "g",
  ))) {
    parseNamedImports(match[1], /\s*:\s*/, addBinding);
  }

  for (const match of importSource.matchAll(new RegExp(
    String.raw`\b(?:const|let|var)\s+(\w+)\s*=\s*${requireCall}`,
    "g",
  ))) {
    namespaces.add(match[1]);
  }
  for (const match of importSource.matchAll(new RegExp(
    String.raw`\b(?:const|let|var)\s+(\w+)\s*=\s*await\s+${dynamicImportCall}`,
    "g",
  ))) {
    namespaces.add(match[1]);
  }
  for (const match of importSource.matchAll(new RegExp(
    String.raw`\bimport\s+(\w+)\s*=\s*${requireCall}`,
    "g",
  ))) {
    namespaces.add(match[1]);
  }

  const propertyPatterns = [
    new RegExp(String.raw`(?:${requireCall}|${dynamicImportCall})\s*(?:\?\.|\.)\s*(\w+)`, "g"),
    new RegExp(String.raw`\(\s*await\s+${dynamicImportCall}\s*\)\s*(?:\?\.|\.)\s*(\w+)`, "g"),
  ];
  for (const pattern of propertyPatterns) {
    for (const match of importSource.matchAll(pattern)) directImports.add(match[1]);
  }

  return { bindings, namespaces, directImports, importsEverything };
}

const consumerSourceExtension = /\.(?:[cm]?[jt]sx?)$/;
const ignoredConsumerDirectories = new Set([
  ".git",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "vendor",
  "__pycache__",
]);
// Skip oversized files outright: they are almost always generated artifacts,
// and reading/stripping them is pure memory cost.
const MAX_CONSUMER_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Scans a consumer's source tree for references to the repository's exports.
 *
 * The scan is memoized per consumer, but it caches only *matches* (which export
 * names occur in which files) - never the contents of the files themselves.
 * Each file is read, stripped and tested one at a time, then its content is
 * discarded immediately, so peak memory stays bounded no matter how many files
 * a consumer repository contains.
 *
 * Called exactly for two purposes: from findReferences() to find consumer
 * references for one export name (exportName given), and from the reporting
 * loop to confirm files were scanned (exportName undefined, returns null).
 */
function getConsumerSourceFiles(consumer, exportName, exportNames) {
  if (consumer.matches !== null) {
    return exportName === undefined ? null : (consumer.matches.get(exportName) ?? []);
  }

  const matches = new Map();
  for (const name of exportNames) matches.set(name, []);
  const patternCache = new Map();

  function patternFor(name) {
    let pattern = patternCache.get(name);
    if (!pattern) {
      pattern = new RegExp(`\\b${name}\\b`);
      patternCache.set(name, pattern);
    }
    return pattern;
  }

  function walkDir(dir) {
    if (!existsSync(dir)) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredConsumerDirectories.has(entry.name)) walkDir(fullPath);
        continue;
      }
      if (!consumerSourceExtension.test(entry.name)) continue;

      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.size > MAX_CONSUMER_FILE_BYTES) continue; // skip files > 2 MB

      consumer.filesScanned++;
      let source;
      let imports;
      try {
        source = readFileSync(fullPath, "utf8");
        imports = extractVinciImports(source);
        source = stripCommentsAndStrings(source);
      } catch {
        // A file that becomes unreadable during the scan has still been counted,
        // but cannot contribute references.
        continue;
      }

      const referencedImports = new Set(imports.directImports);
      for (const [importedName, localNames] of imports.bindings) {
        if ([...localNames].some((localName) => patternFor(localName).test(source))) {
          referencedImports.add(importedName);
        }
      }
      for (const namespace of imports.namespaces) {
        const namespacePattern = new RegExp(
          `\\b${namespace}\\s*(?:\\?\\.|\\.)\\s*(\\w+)`,
          "g",
        );
        for (const match of source.matchAll(namespacePattern)) referencedImports.add(match[1]);
      }

      // Test every export name immediately against this one file, then let
      // `source` go out of scope so its memory is freed right away.
      for (const name of exportNames) {
        if (imports.importsEverything || referencedImports.has(name)) {
          matches.get(name).push(`${consumer.displayPath}:${relativePath(consumer.path, fullPath)}`);
        }
      }
    }
  }

  if (consumer.exists) walkDir(consumer.path);
  consumer.matches = matches;

  return exportName === undefined ? null : (matches.get(exportName) ?? []);
}

function findReferences(exportName, packageDir, definingModule, rootDir, consumersArray = [], exportNames = []) {
  const refs = { external: [], samePackage: [], testOnly: [], self: [] };

  function walkDir(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
        continue;
      }
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) {
        continue;
      }

      try {
        const source = readFileSync(fullPath, "utf8");
        const cleaned = stripCommentsAndStrings(source);
        const pattern = new RegExp(`\\b${exportName}\\b`);
        if (!pattern.test(cleaned)) continue;

        const rel = relativePath(rootDir, fullPath);
        if (!rel.startsWith("packages/")) continue;

        const pkgMatch = rel.match(/^packages\/([^/]+)\/src\/(.+)$/);
        if (!pkgMatch) continue;

        const pkgOfDef = relativePath(rootDir, packageDir).split("/")[1];
        const pkgOfRef = pkgMatch[1];
        const moduleOfRef = pkgMatch[2];

        if (pkgOfRef !== pkgOfDef) {
          refs.external.push(rel);
        } else if (moduleOfRef === definingModule) {
          refs.self.push(rel);
        } else if (moduleOfRef.includes(".test.ts")) {
          refs.testOnly.push(rel);
        } else {
          refs.samePackage.push(rel);
        }
      } catch (e) {
        // ignore read errors
      }
    }
  }

  walkDir(rootDir);

  for (const consumer of consumersArray) {
    for (const ref of getConsumerSourceFiles(consumer, exportName, exportNames)) {
      refs.external.push(ref);
    }
  }

  return refs;
}

function loadAllowlist() {
  if (!existsSync(allowlistPath)) return [];
  try {
    const content = JSON.parse(readFileSync(allowlistPath, "utf8"));
    if (!Array.isArray(content)) return [];
    for (let i = 0; i < content.length; i++) {
      if (!content[i].reason || typeof content[i].reason !== "string" || content[i].reason.trim() === "") {
        console.error(`Allowlist error: entry ${i + 1} must have a non-empty reason`);
        process.exit(1);
      }
    }
    return content;
  } catch {
    return [];
  }
}

console.log("Matching strategy: exact identifier matches using word boundaries (\\b)");
console.log("");

if (!existsSync(packagesDir)) {
  process.exit(strictMode ? 1 : 0);
}

const packages = readdirSync(packagesDir);
const allowlist = loadAllowlist();
const results = new Map();

// Trace every package's exports up front so a single pass over each consumer
// tree can test all export names at once (see getConsumerSourceFiles).
const traced = [];
for (const pkgName of packages) {
  const pkgPath = join(packagesDir, pkgName);
  if (!existsSync(join(pkgPath, "src"))) continue;

  const exports = tracePackageExports(pkgPath);
  if (exports.size === 0) continue;
  traced.push({ pkgName, pkgPath, exports });
}
const allExportNames = [...new Set(traced.flatMap((t) => [...t.exports.keys()]))];

for (const { pkgName, pkgPath, exports } of traced) {
  const nowhere = [];
  const testOnly = [];

  for (const [exportName, defModule] of exports) {
    const refs = findReferences(exportName, pkgPath, defModule, rootDir, consumers, allExportNames);
    const isConsumed = refs.external.length > 0 || refs.samePackage.length > 0;

    if (!isConsumed) {
      if (refs.testOnly.length > 0) {
        testOnly.push({ name: exportName, module: defModule });
      } else if (refs.testOnly.length === 0) {
        nowhere.push({ name: exportName, module: defModule });
      }
    }
  }

  if (nowhere.length > 0 || testOnly.length > 0) {
    results.set(pkgName, { nowhere, testOnly });
  }
}

for (const consumer of consumers) {
  getConsumerSourceFiles(consumer, undefined, allExportNames);
  console.log(
    `[Consumer] ${consumer.displayPath}: exists=${consumer.exists ? "yes" : "no"} files_scanned=${consumer.filesScanned}`,
  );
  if (!consumer.exists) {
    console.log(`[Consumer] WARNING: directory does not exist: ${consumer.displayPath}`);
  }
}
if (consumers.length > 0 && results.size > 0) console.log("");

for (const [pkgName, pkgResults] of results) {
  if (results.size > 0 && pkgName !== Array.from(results.keys())[0]) console.log("");
  console.log(`Package: ${pkgName}`);

  if (pkgResults.nowhere.length > 0) {
    console.log(`  NOWHERE REFERENCED (${pkgResults.nowhere.length})`);
    for (const e of pkgResults.nowhere) {
      console.log(`    - ${e.name} (src/${e.module})`);
    }
  }

  if (pkgResults.testOnly.length > 0) {
    if (pkgResults.nowhere.length > 0) console.log("");
    console.log(`  TEST ONLY (${pkgResults.testOnly.length})`);
    for (const e of pkgResults.testOnly) {
      console.log(`    - ${e.name} (src/${e.module})`);
    }
  }
}

if (strictMode) {
  const unallowlisted = [];
  for (const [pkgName, pkgResults] of results) {
    for (const exp of pkgResults.nowhere) {
      const found = allowlist.some((e) => e.package === pkgName && e.export === exp.name);
      if (!found) {
        unallowlisted.push({ package: pkgName, export: exp.name });
      }
    }
  }

  console.log("");
  if (unallowlisted.length > 0) {
    console.log(`Strict result: ${unallowlisted.length} unallowlisted nowhere-referenced exports`);
    process.exit(1);
  } else {
    console.log("Strict result: no unallowlisted nowhere-referenced exports");
    process.exit(0);
  }
} else {
  process.exit(0);
}
