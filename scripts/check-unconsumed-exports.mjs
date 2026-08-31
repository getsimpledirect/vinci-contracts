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

function importKey(moduleSpecifier, exportName) {
  return `${moduleSpecifier}\0${exportName}`;
}

function vinciModuleFrom(matchText) {
  return matchText.match(/["'](@getsimpledirect\/vinci-[^"'\s]+)["']/)?.[1] ?? null;
}

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
  // Package identity is part of every key. Flattening this to an export name
  // makes an import from one Vinci package consume a same-named export from
  // every other package.
  const bindings = new Map();
  const namespaces = new Map();
  const directImports = new Set();
  const importsEverything = new Set();

  function addBinding(moduleSpecifier, importedName, localName) {
    if (!/^\w+$/.test(importedName) || !/^\w+$/.test(localName)) return;
    const key = importKey(moduleSpecifier, importedName);
    if (!bindings.has(key)) bindings.set(key, new Set());
    bindings.get(key).add(localName);
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
    const moduleSpecifier = vinciModuleFrom(match[0]);
    if (!moduleSpecifier) continue;
    const named = match[1].match(/\{([^}]*)\}/s);
    if (named) {
      parseNamedImports(named[1], /\s+as\s+/, (importedName, localName) => {
        addBinding(moduleSpecifier, importedName, localName);
      });
    }
    const namespace = match[1].match(/\*\s+as\s+(\w+)/);
    if (namespace) namespaces.set(namespace[1], moduleSpecifier);
  }

  const reexportPattern = new RegExp(
    String.raw`\bexport\s+(?:type\s+)?(\*\s*(?:as\s+\w+)?|\{[^}]*\})\s+from\s+${vinciModuleLiteral}`,
    "g",
  );
  for (const match of importSource.matchAll(reexportPattern)) {
    const moduleSpecifier = vinciModuleFrom(match[0]);
    if (!moduleSpecifier) continue;
    if (match[1].trim().startsWith("*")) {
      importsEverything.add(moduleSpecifier);
    } else {
      parseNamedImports(match[1].slice(1, -1), /\s+as\s+/, (importedName) => {
        if (/^\w+$/.test(importedName)) {
          directImports.add(importKey(moduleSpecifier, importedName));
        }
      });
    }
  }

  const requireCall = String.raw`require\s*\(\s*${vinciModuleLiteral}\s*\)`;
  const dynamicImportCall = String.raw`import\s*\(\s*${vinciModuleLiteral}\s*\)`;

  for (const match of importSource.matchAll(new RegExp(
    String.raw`\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*${requireCall}`,
    "g",
  ))) {
    const moduleSpecifier = vinciModuleFrom(match[0]);
    if (!moduleSpecifier) continue;
    parseNamedImports(match[1], /\s*:\s*/, (importedName, localName) => {
      addBinding(moduleSpecifier, importedName, localName);
    });
  }
  for (const match of importSource.matchAll(new RegExp(
    String.raw`\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+${dynamicImportCall}`,
    "g",
  ))) {
    const moduleSpecifier = vinciModuleFrom(match[0]);
    if (!moduleSpecifier) continue;
    parseNamedImports(match[1], /\s*:\s*/, (importedName, localName) => {
      addBinding(moduleSpecifier, importedName, localName);
    });
  }

  for (const match of importSource.matchAll(new RegExp(
    String.raw`\b(?:const|let|var)\s+(\w+)\s*=\s*${requireCall}`,
    "g",
  ))) {
    const moduleSpecifier = vinciModuleFrom(match[0]);
    if (moduleSpecifier) namespaces.set(match[1], moduleSpecifier);
  }
  for (const match of importSource.matchAll(new RegExp(
    String.raw`\b(?:const|let|var)\s+(\w+)\s*=\s*await\s+${dynamicImportCall}`,
    "g",
  ))) {
    const moduleSpecifier = vinciModuleFrom(match[0]);
    if (moduleSpecifier) namespaces.set(match[1], moduleSpecifier);
  }
  for (const match of importSource.matchAll(new RegExp(
    String.raw`\bimport\s+(\w+)\s*=\s*${requireCall}`,
    "g",
  ))) {
    const moduleSpecifier = vinciModuleFrom(match[0]);
    if (moduleSpecifier) namespaces.set(match[1], moduleSpecifier);
  }

  const propertyPatterns = [
    new RegExp(String.raw`(?:${requireCall}|${dynamicImportCall})\s*(?:\?\.|\.)\s*(\w+)`, "g"),
    new RegExp(String.raw`\(\s*await\s+${dynamicImportCall}\s*\)\s*(?:\?\.|\.)\s*(\w+)`, "g"),
  ];
  for (const pattern of propertyPatterns) {
    for (const match of importSource.matchAll(pattern)) {
      const moduleSpecifier = vinciModuleFrom(match[0]);
      if (moduleSpecifier) directImports.add(importKey(moduleSpecifier, match[1]));
    }
  }

  return { bindings, namespaces, directImports, importsEverything };
}

function vinciImportsReference(imports, moduleSpecifier, exportName, source) {
  const key = importKey(moduleSpecifier, exportName);
  if (
    imports.directImports.has(key)
    || imports.bindings.has(key)
    || imports.importsEverything.has(moduleSpecifier)
  ) {
    return true;
  }

  for (const [namespace, importedModule] of imports.namespaces) {
    if (importedModule !== moduleSpecifier) continue;
    const namespacePattern = new RegExp(
      `\\b${namespace}\\s*(?:\\?\\.|\\.)\\s*${exportName}\\b`,
    );
    if (namespacePattern.test(source)) return true;
  }
  return false;
}

function relativeImportReferencesPackage(source, sourcePath, packageDir, exportName) {
  const importSource = source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
    (token) => (
      /^["']\.[^"'\s]+["']$/.test(token)
        ? token
        : token.replace(/[^\r\n]/g, " ")
    ),
  );
  const statementPattern = /\b(?:import|export)\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  for (const match of importSource.matchAll(statementPattern)) {
    if (!match[2].startsWith(".")) continue;
    const importedPath = resolve(dirname(sourcePath), match[2]);
    const relativeToPackage = relativePath(packageDir, importedPath);
    if (relativeToPackage === ".." || relativeToPackage.startsWith(`..${process.platform === "win32" ? "\\\\" : "/"}`)) {
      continue;
    }
    if (match[1].trim().startsWith("*")) return true;
    if (new RegExp(`\\b${exportName}\\b`).test(match[1])) return true;
  }
  return false;
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
function getConsumerSourceFiles(consumer, exportKey, exportRecords) {
  if (consumer.matches !== null) {
    return exportKey === undefined ? null : (consumer.matches.get(exportKey) ?? []);
  }

  const matches = new Map();
  for (const { key } of exportRecords) matches.set(key, []);
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
      for (const [key, localNames] of imports.bindings) {
        if ([...localNames].some((localName) => patternFor(localName).test(source))) {
          referencedImports.add(key);
        }
      }
      for (const [namespace, moduleSpecifier] of imports.namespaces) {
        const namespacePattern = new RegExp(
          `\\b${namespace}\\s*(?:\\?\\.|\\.)\\s*(\\w+)`,
          "g",
        );
        for (const match of source.matchAll(namespacePattern)) {
          referencedImports.add(importKey(moduleSpecifier, match[1]));
        }
      }

      // Test every package-qualified export immediately against this one file, then let
      // `source` go out of scope so its memory is freed right away.
      for (const { key, moduleSpecifier } of exportRecords) {
        if (imports.importsEverything.has(moduleSpecifier) || referencedImports.has(key)) {
          matches.get(key).push(`${consumer.displayPath}:${relativePath(consumer.path, fullPath)}`);
        }
      }
    }
  }

  if (consumer.exists) walkDir(consumer.path);
  consumer.matches = matches;

  return exportKey === undefined ? null : (matches.get(exportKey) ?? []);
}

function findReferences(
  exportName,
  exportKey,
  moduleSpecifier,
  packageDir,
  definingModule,
  rootDir,
  consumersArray = [],
  exportRecords = [],
) {
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
        const rawSource = readFileSync(fullPath, "utf8");
        const source = stripCommentsAndStrings(rawSource);
        const pattern = new RegExp(`\\b${exportName}\\b`);
        if (!pattern.test(source)) continue;

        const rel = relativePath(rootDir, fullPath);
        if (!rel.startsWith("packages/")) continue;

        const pkgMatch = rel.match(/^packages\/([^/]+)\/src\/(.+)$/);
        if (!pkgMatch) continue;

        const pkgOfDef = relativePath(rootDir, packageDir).split("/")[1];
        const pkgOfRef = pkgMatch[1];
        const moduleOfRef = pkgMatch[2];

        if (pkgOfRef !== pkgOfDef) {
          const imports = extractVinciImports(rawSource);
          if (
            !vinciImportsReference(imports, moduleSpecifier, exportName, source)
            && !relativeImportReferencesPackage(rawSource, fullPath, packageDir, exportName)
          ) {
            continue;
          }
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
    for (const ref of getConsumerSourceFiles(consumer, exportKey, exportRecords)) {
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
  let moduleSpecifier = `@getsimpledirect/vinci-${pkgName}`;
  try {
    const manifestName = JSON.parse(readFileSync(join(pkgPath, "package.json"), "utf8")).name;
    if (typeof manifestName === "string" && manifestName.startsWith("@getsimpledirect/vinci-")) {
      moduleSpecifier = manifestName;
    }
  } catch {
    // Synthetic fixtures need no package.json when the directory name maps to
    // the standard @getsimpledirect/vinci-<directory> package name.
  }
  traced.push({ pkgName, pkgPath, moduleSpecifier, exports });
}
const allExportRecords = traced.flatMap(({ moduleSpecifier, exports }) =>
  [...exports.keys()].map((name) => ({
    key: importKey(moduleSpecifier, name),
    moduleSpecifier,
    name,
  })),
);

for (const { pkgName, pkgPath, moduleSpecifier, exports } of traced) {
  const nowhere = [];
  const testOnly = [];

  for (const [exportName, defModule] of exports) {
    const refs = findReferences(
      exportName,
      importKey(moduleSpecifier, exportName),
      moduleSpecifier,
      pkgPath,
      defModule,
      rootDir,
      consumers,
      allExportRecords,
    );
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
  getConsumerSourceFiles(consumer, undefined, allExportRecords);
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
