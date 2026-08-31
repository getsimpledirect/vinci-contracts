#!/usr/bin/env node
/**
 * Generates a checklist of undeclared rights and policy facts blocking role eligibility.
 *
 * This is a report, not a gate — unknown facts are the honest state of the registry,
 * and this script documents what someone would need to read to resolve each one. It
 * groups unknowns by the document that would resolve them, so one person reading one
 * document can close several at once.
 *
 * Always exits 0. Run after `npm run build`.
 */

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { mapUnevaluableReason } from "./rights-gap-mapping.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const modelClassesEntry = join(root, "packages", "model-classes", "dist", "index.js");

if (!existsSync(modelClassesEntry)) {
  console.error("Error: run `npm run build` first to generate dist/index.js");
  process.exit(0);
}

const mod = await import(pathToFileURL(modelClassesEntry).href);
const { VINCI_ENDPOINTS, VINCI_ROLES, matchEndpointToRole } = mod;

const now = "2026-08-30T12:00:00.000Z";

// Map of (endpoint, field) -> roles that are unevaluable because of it
const unknownFacts = new Map();
// Map of document -> set of (endpoint, field) pairs
const docToUnknowns = new Map();

// Analyze each endpoint against each role
for (const endpoint of VINCI_ENDPOINTS) {
  for (const role of VINCI_ROLES) {
    const result = matchEndpointToRole(role, endpoint, now);
    if (result.verdict !== "unevaluable") continue;

    // For each unevaluable reason, extract the unknown fact
    for (const reason of result.reasons) {
      const key = `${endpoint.endpointId}:${reason.code}`;
      if (!unknownFacts.has(key)) {
        unknownFacts.set(key, []);
      }
      unknownFacts.get(key).push(role.roleId);

      const { field, document } = mapUnevaluableReason(reason, endpoint);
      const factKey = `${endpoint.endpointId}:${field}`;
      if (!docToUnknowns.has(document)) {
        docToUnknowns.set(document, new Set());
      }
      docToUnknowns.get(document).add(factKey);
    }
  }
}

// Print the report
console.log("Rights and Policy Gaps in Vinci Endpoint Registry");
console.log("====================================================\n");

if (docToUnknowns.size === 0) {
  console.log("No undeclared facts found (all fields are known or not evaluated).\n");
  process.exit(0);
}

// Group by document and print in order
const docs = Array.from(docToUnknowns.keys()).sort();
for (const doc of docs) {
  const facts = Array.from(docToUnknowns.get(doc)).sort();
  const fields = new Set();

  // Collect all fields for this document
  for (const factKey of facts) {
    const [, field] = factKey.split(":");
    fields.add(field);
  }

  console.log(`${doc} (read to resolve: ${Array.from(fields).sort().join(", ")}):`);

  for (const factKey of facts) {
    const [endpointId, field] = factKey.split(":");
    const affected = new Set();

    // Find which roles are affected by this unknown
    for (const endpoint of VINCI_ENDPOINTS) {
      if (endpoint.endpointId !== endpointId) continue;

      for (const role of VINCI_ROLES) {
        const result = matchEndpointToRole(role, endpoint, now);
        if (result.verdict !== "unevaluable") continue;

        for (const reason of result.reasons) {
          const { field: reasonField } = mapUnevaluableReason(reason, endpoint);
          if (reasonField === field) {
            affected.add(role.roleId);
          }
        }
      }
    }

    if (affected.size > 0) {
      const roles = Array.from(affected).sort().join(", ");
      console.log(`  - ${endpointId}: ${field} is unknown (affects: ${roles} [unevaluable])`);
    } else {
      console.log(`  - ${endpointId}: ${field} is unknown (no roles currently unevaluable on this)`);
    }
  }

  console.log("");
}

process.exit(0);
