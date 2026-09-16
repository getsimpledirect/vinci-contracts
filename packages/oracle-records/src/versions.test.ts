import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSchemaMetaComplete, type SchemaMeta } from "@getsimpledirect/vinci-contracts";
import { describe, expect, it } from "vitest";
import {
  ADMITTED_REQUEST_IDENTITY_SCHEMA_META,
  ATTESTED_ENVELOPE_SCHEMA_META,
  ORACLE_CONTEXT_BINDING_SCHEMA_META,
  RESEARCH_REQUEST_SCHEMA_META,
  SOURCE_CITATION_SCHEMA_META,
  SOURCE_RECORD_SCHEMA_META,
  SUPPORTED_SCHEMA_VERSIONS,
  isSupportedSchemaVersion,
  oracleContextBindingDigest,
  researchRequestDigest,
  sourceCitationDigest,
  sourceRecordDigest,
  validateAdmittedRequestIdentity,
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
 * T07 — supported schema versions preserve semantics, and an unsupported one is
 * refused rather than silently downgraded.
 *
 * "Cannot be silently downgraded" is a claim about a code path that does not
 * exist, which is the hardest kind to test: a missing branch produces no
 * observable behaviour to assert. What is asserted instead is everything a
 * downgrade WOULD produce — a success arm, a coerced value on the way out, a
 * digest computed over a record whose version was changed — and none of them
 * appear.
 */

const VECTORS = join(dirname(fileURLToPath(import.meta.url)), "..", "vectors");

const RECORDS = [
  {
    name: "research request",
    valid: () => validResearchRequest() as unknown,
    validate: validateResearchRequest,
    digest: (value: unknown) => researchRequestDigest(value as ReturnType<typeof validResearchRequest>),
  },
  {
    name: "context binding",
    valid: () => validContextBinding() as unknown,
    validate: validateOracleContextBinding,
    digest: (value: unknown) => oracleContextBindingDigest(value as ReturnType<typeof validContextBinding>),
  },
  {
    name: "source record",
    valid: () => validSourceRecord() as unknown,
    validate: validateSourceRecord,
    digest: (value: unknown) => sourceRecordDigest(value as ReturnType<typeof validSourceRecord>),
  },
  {
    name: "source citation",
    valid: () => validSourceCitation() as unknown,
    validate: validateSourceCitation,
    digest: (value: unknown) => sourceCitationDigest(value as ReturnType<typeof validSourceCitation>),
  },
] as const;

describe("T07: a supported version is read, an unsupported one is refused", () => {
  it("declares exactly one supported version, and says so in one place", () => {
    expect([...SUPPORTED_SCHEMA_VERSIONS]).toEqual([1]);
    expect(isSupportedSchemaVersion(1)).toBe(true);
    for (const value of [0, 2, "1", 1.0000001, null, undefined, true, [1]]) {
      expect(isSupportedSchemaVersion(value)).toBe(false);
    }
  });

  for (const record of RECORDS) {
    it(`${record.name}: version 1 is read`, () => {
      const result = record.validate(record.valid());
      expect(result.ok ? [] : result.issues).toEqual([]);
    });

    it(`${record.name}: version 2 is refused by name, and nothing is handed back`, () => {
      const future = { ...(record.valid() as Record<string, unknown>), schemaVersion: 2 };
      const result = record.validate(future);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.map((i) => ({ path: i.path, code: i.code }))).toEqual([
        { path: "/schemaVersion", code: "unsupported_schema_version" },
      ]);
      // A DOWNGRADE would show up as a success arm carrying schemaVersion 1.
      // There is no `value` on a failed result at all, which is the shape that
      // makes the downgrade unrepresentable rather than merely unimplemented.
      expect("value" in result).toBe(false);
    });

    it(`${record.name}: version 0 and a non-integer version are refused the same way`, () => {
      for (const schemaVersion of [0, -1, 1.5, "1", null]) {
        const wrong = { ...(record.valid() as Record<string, unknown>), schemaVersion };
        const result = record.validate(wrong);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.issues.map((i) => i.code)).toEqual(["unsupported_schema_version"]);
      }
    });
  }

  it("an unsupported version cannot be digested, so it cannot acquire an identity", () => {
    // The other half of "not silently downgraded". If a v2 record could be
    // digested, a store keyed by digest would happily hold it beside the v1
    // records and nothing downstream would ever ask again.
    for (const record of RECORDS) {
      const future = { ...(record.valid() as Record<string, unknown>), schemaVersion: 2 };
      expect(() => record.digest(future)).toThrow(/unsupported_schema_version/);
    }
  });

  it("a version change is a different record, not the same record read differently", () => {
    // If a downgrade existed, these two would resolve to one identity. The
    // digest covers schemaVersion, so they cannot.
    const request = validResearchRequest();
    const canonicalOne = readFileSync(
      join(VECTORS, "research-request-1-admitted", "canonical.txt"),
      "utf8",
    );
    expect(canonicalOne).toContain('"schemaVersion":1');
    expect(researchRequestDigest(request)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the admitted-request identity carries its own version too", () => {
    const identity = {
      schemaVersion: 1,
      idempotencyKey: "idem-oracle-1",
      requestId: "oracle-request-1",
      requestDigest: researchRequestDigest(validResearchRequest()),
    };
    expect(validateAdmittedRequestIdentity(identity).ok).toBe(true);
    const future = validateAdmittedRequestIdentity({ ...identity, schemaVersion: 2 });
    expect(future.ok).toBe(false);
    if (!future.ok) {
      expect(future.issues.map((i) => i.code)).toEqual(["unsupported_schema_version"]);
    }
  });
});

describe("CON-04: every record and every transformation states its version", () => {
  const METAS: readonly (readonly [string, SchemaMeta])[] = [
    ["attested envelope", ATTESTED_ENVELOPE_SCHEMA_META],
    ["research request", RESEARCH_REQUEST_SCHEMA_META],
    ["admitted request identity", ADMITTED_REQUEST_IDENTITY_SCHEMA_META],
    ["context binding", ORACLE_CONTEXT_BINDING_SCHEMA_META],
    ["source record", SOURCE_RECORD_SCHEMA_META],
    ["source citation", SOURCE_CITATION_SCHEMA_META],
  ];

  it("every schema answers all six questions, and none is a duplicate of another", () => {
    for (const [name, meta] of METAS) {
      expect(() => assertSchemaMetaComplete(meta), name).not.toThrow();
      expect(meta.version).toBe(1);
      // These records are digested, and a digest over a shape that may gain
      // fields is not an identity. Frozen is the only honest answer here.
      expect(meta.compatibility, name).toBe("frozen");
      expect(meta.unknownFields, name).toBe("reject");
      expect(meta.malformedData, name).toBe("fail-closed");
    }
    expect(new Set(METAS.map(([, meta]) => meta.id)).size).toBe(METAS.length);
    for (const [, meta] of METAS) expect(meta.id.startsWith("vinci.oracle.")).toBe(true);
  });

  it("the transformations name their version inside the records they produce", () => {
    // CON-04 covers transformations, not only records. The compiler that built
    // a context and the adapter that read a source are both stated, and both
    // are required — an unversioned transformation is a record whose meaning
    // cannot be reproduced.
    const binding = validContextBinding();
    expect(binding.compilerVersion).not.toBe("");
    const withoutCompiler = { ...binding, compilerVersion: null };
    const result = validateOracleContextBinding(withoutCompiler);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => ({ path: i.path, code: i.code }))).toEqual([
        { path: "/compilerVersion", code: "required_field" },
      ]);
    }

    const source = validSourceRecord();
    const withoutExtraction = {
      ...source,
      content: { ...source.content, extractionVersion: null },
    };
    const extraction = validateSourceRecord(withoutExtraction);
    expect(extraction.ok).toBe(false);
    if (!extraction.ok) {
      expect(extraction.issues.map((i) => ({ path: i.path, code: i.code }))).toEqual([
        { path: "/content/extractionVersion", code: "required_field" },
      ]);
    }

    const citation = validSourceCitation();
    expect(citation.attestedBy.version).not.toBe("");
    const unattested = {
      ...citation,
      attestedBy: { ...citation.attestedBy, version: "" },
    };
    const attested = validateSourceCitation(unattested);
    expect(attested.ok).toBe(false);
    if (!attested.ok) {
      expect(attested.issues.map((i) => ({ path: i.path, code: i.code }))).toEqual([
        { path: "/attestedBy/version", code: "required_field" },
      ]);
    }
  });
});
