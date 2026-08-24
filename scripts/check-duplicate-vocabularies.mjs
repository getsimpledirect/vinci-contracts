#!/usr/bin/env node
/**
 * Rejects independently declared copies of closed string vocabularies.
 *
 * Coverage: every non-test .ts file under each package's src, recursively. Generated
 * dist output is excluded explicitly: it is a copy of source, not another source
 * definition. Const string-array declarations (`const X = ["a"] as const`) and
 * bare string-literal type unions (`type X = "a" | "b"`) are compared. Types
 * derived from an array (`type X = (typeof XS)[number]`) are intentionally not
 * declarations of a second vocabulary and are not counted.
 *
 * This is deliberately not a general semantic-equivalence checker. It does not
 * compare object/number arrays, arrays assembled with spreads, enums, schemas,
 * or unions containing anything other than string literals.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(root, "packages");

// These floors make a broken glob/traversal fail loudly instead of blessing an
// empty or suspiciously partial scan. Update them deliberately if the repository
// genuinely shrinks below these conservative bounds.
const MIN_SOURCE_FILES = 50;
const MIN_VOCABULARY_DECLARATIONS = 20;

/**
 * Intentional duplicates must name their complete comparison key and exact set
 * of declaring locations. A non-empty reason is mandatory. Every entry is also
 * required to match a live finding, so removing or moving the duplicate makes
 * its waiver stale and fails this check.
 *
 * Shape:
 * {
 *   comparison: "ordered" | "unordered",
 *   members: ["first", "second"],
 *   locations: ["package:src/file.ts#NAME (const array)"],
 *   reason: "Why these declarations must remain independent.",
 * }
 */
const ALLOWLIST = [];

function sourceFilesUnder(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    // dist is generated output even if one appears below src in the future.
    if (entry.isDirectory() && entry.name === "dist") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFilesUnder(path));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

function stringUnionMembers(type) {
  if (!ts.isUnionTypeNode(type)) return null;
  const members = type.types;
  if (
    members.length === 0
    || !members.every(
      (member) => ts.isLiteralTypeNode(member) && ts.isStringLiteralLike(member.literal),
    )
  ) {
    return null;
  }
  return members.map((member) => member.literal.text);
}

function constArrayMembers(initializer, sourceFile) {
  if (!ts.isAsExpression(initializer) || initializer.type.getText(sourceFile) !== "const") {
    return null;
  }
  if (!ts.isArrayLiteralExpression(initializer.expression)) return null;
  if (!initializer.expression.elements.every(ts.isStringLiteralLike)) return null;
  return initializer.expression.elements.map((element) => element.text);
}

function declarationsIn(file, packageName) {
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const declarations = [];
  const fileName = relative(join(packagesDir, packageName), file).replaceAll("\\", "/");

  function record(name, members, kind, node) {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    declarations.push({ packageName, file: fileName, name, members, kind, line });
  }

  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const declarationList = node.parent;
      if (
        ts.isVariableDeclarationList(declarationList)
        && (declarationList.flags & ts.NodeFlags.Const) !== 0
      ) {
        const members = constArrayMembers(node.initializer, sourceFile);
        if (members !== null) record(node.name.text, members, "const array", node);
      }
    } else if (ts.isTypeAliasDeclaration(node)) {
      const members = stringUnionMembers(node.type);
      if (members !== null) record(node.name.text, members, "type union", node);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return declarations;
}

function orderedKey(members) {
  return JSON.stringify(members);
}

function unorderedKey(members) {
  return JSON.stringify([...members].sort());
}

function location(declaration) {
  return `${declaration.packageName}:${declaration.file}#${declaration.name} (${declaration.kind})`;
}

function crossesDefinitionBoundary(declarations) {
  const packages = new Set(declarations.map((declaration) => declaration.packageName));
  if (packages.size > 1) return true;
  return new Set(declarations.map((declaration) => declaration.file)).size > 1;
}

function groupBy(declarations, keyFor) {
  const groups = new Map();
  for (const declaration of declarations) {
    const key = keyFor(declaration.members);
    const group = groups.get(key) ?? [];
    group.push(declaration);
    groups.set(key, group);
  }
  return groups;
}

function findingSignature(finding) {
  return JSON.stringify({
    comparison: finding.comparison,
    members: finding.members,
    locations: finding.declarations.map(location).sort(),
  });
}

function waiverSignature(waiver) {
  const members = waiver.comparison === "unordered" ? [...waiver.members].sort() : waiver.members;
  return JSON.stringify({
    comparison: waiver.comparison,
    members,
    locations: [...waiver.locations].sort(),
  });
}

const files = [];
for (const packageEntry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!packageEntry.isDirectory()) continue;
  const src = join(packagesDir, packageEntry.name, "src");
  if (!existsSync(src)) continue;
  for (const file of sourceFilesUnder(src)) files.push([file, packageEntry.name]);
}
files.sort(([left], [right]) => left.localeCompare(right));

const declarations = files.flatMap(([file, packageName]) => declarationsIn(file, packageName));
const constArrayCount = declarations.filter(({ kind }) => kind === "const array").length;
const typeUnionCount = declarations.length - constArrayCount;
const findings = [];

for (const group of groupBy(declarations, (members) => members.length).values()) {
  // A vocabulary can only be equal to one with the same cardinality. Splitting
  // first keeps the comparison maps small and makes this explicit.
  for (const exact of groupBy(group, orderedKey).values()) {
    if (exact.length > 1 && crossesDefinitionBoundary(exact)) {
      findings.push({ comparison: "ordered", members: exact[0].members, declarations: exact });
    }
  }

  for (const unordered of groupBy(group, unorderedKey).values()) {
    const distinctOrders = new Set(unordered.map(({ members }) => orderedKey(members)));
    if (distinctOrders.size > 1 && crossesDefinitionBoundary(unordered)) {
      findings.push({
        comparison: "unordered",
        members: [...unordered[0].members].sort(),
        declarations: unordered,
      });
    }
  }
}

console.log(
  `scanned ${files.length} source files, found ${declarations.length} vocabulary declarations `
    + `(${constArrayCount} const arrays, ${typeUnionCount} bare type unions), `
    + `${findings.length} duplicated`,
);

const errors = [];
if (files.length < MIN_SOURCE_FILES) {
  errors.push(
    `source file count ${files.length} is implausibly low (minimum ${MIN_SOURCE_FILES}); scan coverage may be broken`,
  );
}
if (declarations.length < MIN_VOCABULARY_DECLARATIONS) {
  errors.push(
    `vocabulary declaration count ${declarations.length} is implausibly low `
      + `(minimum ${MIN_VOCABULARY_DECLARATIONS}); declaration detection may be broken`,
  );
}

const liveFindingSignatures = new Set(findings.map(findingSignature));
const waivedSignatures = new Set();
for (const waiver of ALLOWLIST) {
  if (
    !["ordered", "unordered"].includes(waiver.comparison)
    || !Array.isArray(waiver.members)
    || !waiver.members.every((member) => typeof member === "string")
    || !Array.isArray(waiver.locations)
    || waiver.locations.length < 2
    || typeof waiver.reason !== "string"
    || waiver.reason.trim() === ""
  ) {
    errors.push(`invalid allowlist entry: ${JSON.stringify(waiver)}`);
    continue;
  }
  const signature = waiverSignature(waiver);
  if (waivedSignatures.has(signature)) {
    errors.push(`duplicate allowlist entry: ${signature}`);
    continue;
  }
  waivedSignatures.add(signature);
  if (!liveFindingSignatures.has(signature)) {
    errors.push(`stale allowlist entry (${waiver.reason}): ${signature}`);
  }
}

for (const finding of findings) {
  if (waivedSignatures.has(findingSignature(finding))) continue;
  const label = finding.comparison === "ordered"
    ? "exact ordered duplicate"
    : "unordered-only duplicate (same members in different order)";
  errors.push(`${label} ${JSON.stringify(finding.members)}:\n${finding.declarations
    .map((declaration) => `      ${location(declaration)}:${declaration.line}`)
    .join("\n")}`);
}

if (errors.length > 0) {
  console.error("Duplicate vocabulary check failed:\n");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`Duplicate vocabulary check passed (${ALLOWLIST.length} active allowlist entries).`);
