#!/usr/bin/env node
/**
 * Enforces D3: every package exports a SchemaMeta answering all six questions
 * §16 requires of a schema.
 *
 * This runs over built output and discovers packages at runtime rather than
 * importing a fixed list, so a new package is covered the moment it exists —
 * a checklist someone has to remember to update is exactly the thing D3 is
 * trying not to rely on.
 *
 * Run after `npm run build`.
 */
import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(root, "packages");

const REQUIRED = ["id", "version", "compatibility", "unknownFields", "malformedData", "migration"];

function looksLikeSchemaMeta(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.id === "string" &&
    typeof value.version === "number" &&
    "compatibility" in value
  );
}

/**
 * The closed vocabularies each policy field must come from.
 *
 * These were never checked. A review planted a SchemaMeta with a whitespace id,
 * a whitespace migration, `unknownFields: true` and `malformedData: 42`, and
 * this checker printed "SchemaMeta OK". It verified that the six fields were
 * PRESENT and never that any of them said anything — the same shape as a test
 * asserting a function exists rather than that it works.
 *
 * The point of SchemaMeta is that a schema answers §16's six questions. An
 * answer of `42` is not an answer, and a checker that accepts it is confirming
 * the questions were asked rather than answered.
 */
const POLICY_VALUES = {
  compatibility: ["frozen", "additive-only", "versioned"],
  unknownFields: ["reject", "preserve", "ignore"],
  malformedData: ["fail-closed", "fail-open"],
};

function policyProblems(name, meta) {
  const problems = [];
  if (typeof meta.id !== "string" || meta.id.trim() === "") {
    problems.push(`${name}: id must be a non-blank string`);
  }
  if (!Number.isInteger(meta.version) || meta.version < 1) {
    problems.push(`${name}: version must be a positive integer, got ${JSON.stringify(meta.version)}`);
  }
  if (typeof meta.migration !== "string" || meta.migration.trim() === "") {
    problems.push(`${name}: migration must be a non-blank string`);
  }
  for (const [field, allowed] of Object.entries(POLICY_VALUES)) {
    if (!allowed.includes(meta[field])) {
      problems.push(
        `${name}: ${field} must be one of ${allowed.join(", ")}, got ${JSON.stringify(meta[field])}`,
      );
    }
  }
  return problems;
}

const errors = [];
const found = [];

for (const dir of readdirSync(packagesDir)) {
  const entry = join(packagesDir, dir, "dist", "index.js");
  if (!existsSync(entry)) {
    errors.push(`${dir}: no dist/index.js — run \`npm run build\` first`);
    continue;
  }

  const mod = await import(pathToFileURL(entry).href);
  const metas = Object.entries(mod).filter(([, v]) => looksLikeSchemaMeta(v));

  if (metas.length === 0) {
    errors.push(
      `${dir}: exports no SchemaMeta. Every package must answer the six questions in §16 — see docs/E0-decisions.md D3.`,
    );
    continue;
  }

  for (const [name, meta] of metas) {
    errors.push(...policyProblems(`${dir}.${name}`, meta));
    found.push(`${dir}.${name} (${meta.id} v${meta.version})`);
    for (const field of REQUIRED) {
      const value = meta[field];
      if (value === undefined || value === null || value === "") {
        errors.push(`${dir}.${name}: SchemaMeta.${field} is unanswered`);
      }
    }
    // The one rule that cannot be satisfied by filling in a placeholder:
    // "none" is only an honest migration answer at version 1.
    if (meta.migration === "none" && meta.version !== 1) {
      errors.push(
        `${dir}.${name}: migration "none" is only valid at version 1, but version is ${meta.version}`,
      );
    }
  }
}

if (errors.length > 0) {
  console.error("SchemaMeta conformance failures:\n");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`SchemaMeta OK — ${found.length} schema(s):`);
for (const f of found) console.log(`  ${f}`);
