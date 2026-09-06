import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AUTHORITY_TERMS, forbiddenTermIn } from "./lib/validate.ts";
import {
  RESEARCH_REQUEST_PAYLOAD_FIELDS,
  validateAttestedEnvelope,
  validateOracleContextBinding,
  validateResearchRequest,
  validateSourceCitation,
  validateSourceRecord,
} from "./index.ts";
import {
  validContextBinding,
  validResearchRequest,
  validSourceCitation,
  validSourceRecord,
} from "./fixtures.test-helpers.ts";

/**
 * Properties of the package as a whole, rather than of one record.
 *
 * These exist because every rule here is a rule about a SET — every payload
 * field, every validator, every declared name — and a test written against one
 * example of a set proves something about the example.
 */

const SRC = dirname(fileURLToPath(import.meta.url));

const VALIDATORS = [
  ["attested envelope", validateAttestedEnvelope],
  ["research request", validateResearchRequest],
  ["context binding", validateOracleContextBinding],
  ["source record", validateSourceRecord],
  ["source citation", validateSourceCitation],
] as const;

describe("the substring authority rule is affordable for the fields this package declares", () => {
  it("names no model-authored payload field that would trip it", () => {
    // The cost of a substring rule, paid explicitly. `ModelAuthored` maps such
    // a field to `never`, so the failure mode without this test is a record
    // type that silently cannot be constructed — a compile error somewhere far
    // from the field that caused it.
    for (const field of RESEARCH_REQUEST_PAYLOAD_FIELDS) {
      expect(forbiddenTermIn(field, AUTHORITY_TERMS), field).toBeNull();
    }
    for (const field of ["sourceId", "quotedSpan", "offeredFor"]) {
      expect(forbiddenTermIn(field, AUTHORITY_TERMS), field).toBeNull();
    }
    // And every nested payload key in the valid fixtures, not only the top
    // level, since the runtime rule walks the whole subtree.
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((child, i) => walk(child, `${path}/${i}`));
        return;
      }
      if (node === null || typeof node !== "object") return;
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        expect(forbiddenTermIn(key, AUTHORITY_TERMS), `${path}/${key}`).toBeNull();
        walk(child, `${path}/${key}`);
      }
    };
    walk(validResearchRequest().payload, "/payload");
    walk(validSourceCitation().payload, "/payload");
  });

  it("does trip on the names it exists for", () => {
    // Non-vacuity for the assertions above: a `forbiddenTermIn` that always
    // returned null would satisfy every one of them.
    for (const name of ["policyRef", "principal", "grantRefs", "workspaceRef", "budgetMicrousd", "contextManifestDigest"]) {
      expect(forbiddenTermIn(name, AUTHORITY_TERMS), name).not.toBeNull();
    }
  });
});

describe("every validator in this package fails closed on the same hostile shapes", () => {
  /**
   * The repository-wide `scripts/check-hostile-keys.mjs` probes these too. This
   * is the same property asserted where a developer sees it before the gate
   * does, and over shapes that check does not carry — an array where an object
   * belongs, a frozen record, and a record whose prototype is not Object's.
   */
  const hostile: readonly [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["a number", 7],
    ["a string", "oracle-request-1"],
    ["an array", []],
    ["kind=toString", { kind: "toString" }],
    ["type=constructor", { type: "constructor" }],
    ["an own __proto__ key", JSON.parse('{"__proto__":{"polluted":true},"a":1}')],
    ["a prototyped object", Object.assign(Object.create({ inherited: 1 }), { a: 1 })],
    ["an object with an accessor", Object.defineProperty({}, "schemaVersion", { get: () => 1, enumerable: true })],
  ];

  for (const [name, validate] of VALIDATORS) {
    for (const [shape, input] of hostile) {
      it(`${name} refuses ${shape} without throwing`, () => {
        const result = validate(input);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
      });
    }
  }

  it("and none of that polluted Object.prototype", () => {
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("positive control: each validator still admits its own valid record", () => {
    // Without this, a validator that refused everything would satisfy every
    // assertion above.
    expect(validateAttestedEnvelope(validResearchRequest()).ok).toBe(true);
    expect(validateResearchRequest(validResearchRequest()).ok).toBe(true);
    expect(validateOracleContextBinding(validContextBinding()).ok).toBe(true);
    expect(validateSourceRecord(validSourceRecord()).ok).toBe(true);
    expect(validateSourceCitation(validSourceCitation()).ok).toBe(true);
  });
});

describe("the package's own source obeys the conventions the gate cannot see", () => {
  const sources = readdirSync(SRC)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".test-helpers.ts"))
    .map((f) => [f, readFileSync(join(SRC, f), "utf8")] as const);

  it("scanned the files it meant to scan", () => {
    // A floor, so a broken glob fails loudly rather than blessing an empty scan.
    expect(sources.length).toBeGreaterThanOrEqual(5);
    expect(sources.map(([name]) => name)).toContain("envelope.ts");
  });

  it("declares no schema whose SchemaMeta this package does not export", () => {
    for (const [name, source] of sources) {
      if (!source.includes("SCHEMA_META")) continue;
      expect(source, name).toMatch(/export const [A-Z_]+_SCHEMA_META: SchemaMeta/);
    }
  });

  it("imports nothing from another package's internals", () => {
    // The layer check sees package-level edges. This sees the reach into a
    // `src/` path, which resolves inside the workspace and breaks the moment
    // the package is installed from a tarball.
    for (const [name, source] of sources) {
      expect(source, name).not.toMatch(/@getsimpledirect\/vinci-[a-z-]+\/src\//);
    }
  });
});
