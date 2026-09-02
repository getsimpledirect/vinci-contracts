import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalize, type ValidationResult } from "@getsimpledirect/vinci-contracts";
import { RUN_EVENT_TYPES, validateRunEvent } from "@getsimpledirect/vinci-run-events";
import {
  ATTESTATION_STATUSES,
  CONTEXT_SECTIONS,
  CONTEXT_TRUSTS,
  CORRECTION_TYPES,
  EXCLUSION_REASONS,
  MOUNT_KINDS,
  NETWORK_CATEGORIES,
  OBSERVED_ENTRYPOINTS,
  REQUIRED_TERMINALS,
  RUN_STATES,
  SECRET_SOURCES,
  TOOL_CATEGORIES,
  agentDigest,
  attestedHarnessCapabilities,
  contextManifestDigest,
  environmentDigest,
  harnessAttestationDigest,
  humanCorrectionDigest,
  runDigest,
  validateAgent,
  validateContextManifest,
  validateEnvironment,
  validateHarnessAttestation,
  validateHumanCorrection,
  validateRun,
} from "./index.ts";

/**
 * Golden vectors, shared with the Python implementation.
 *
 * Each directory under ../vectors holds an input.json, the exact canonical
 * bytes (canonical.txt) and the digest (digest.txt). This test REGENERATES both
 * from the input and compares; python/test_run_vectors.py does the same from
 * the other language, reusing packages/work-orders/python/vinci_canonical.py.
 * A change to canonicalization, to what a digest covers, or to a fixture, fails
 * here and there — which is the point: the vectors are the contract, and
 * neither implementation gets to redefine it alone. Regenerate with
 * vectors/generate.mjs only as a deliberate act.
 *
 * Same construction as packages/work-orders/src/vectors.test.ts, deliberately.
 */
// fileURLToPath rather than import.meta.dirname: engines says node >=20 and
// import.meta.dirname arrived in 20.11.
const VECTORS = join(dirname(fileURLToPath(import.meta.url)), "..", "vectors");

const EXPECTED_VECTORS = [
  "agent-1-minimal",
  "context-manifest-1-trust",
  "environment-1-cloud",
  "harness-attestation-1-pass",
  "harness-attestation-2-expired",
  "human-correction-1",
  "run-1-created",
] as const;

const dirs = readdirSync(VECTORS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

function digested<T>(result: ValidationResult<T>, digest: (value: T) => string): string {
  if (!result.ok) throw new Error(`vector did not validate: ${JSON.stringify(result.issues)}`);
  return digest(result.value);
}

/**
 * The schema that owns a vector directory, by name prefix.
 *
 * An unrecognised directory throws rather than being skipped: a vector nobody
 * digests is a vector nobody checks, and a silent skip is how a fixture stops
 * being covered without anyone seeing it happen.
 */
function digestForVector(dir: string, input: unknown): string {
  if (dir.startsWith("agent-")) return digested(validateAgent(input), agentDigest);
  if (dir.startsWith("context-manifest-")) {
    return digested(validateContextManifest(input), contextManifestDigest);
  }
  if (dir.startsWith("environment-")) return digested(validateEnvironment(input), environmentDigest);
  if (dir.startsWith("harness-attestation-")) {
    return digested(validateHarnessAttestation(input), harnessAttestationDigest);
  }
  if (dir.startsWith("human-correction-")) {
    return digested(validateHumanCorrection(input), humanCorrectionDigest);
  }
  if (dir.startsWith("run-")) return digested(validateRun(input), runDigest);
  throw new Error(`${dir}: no schema owns this vector directory`);
}

function validates(dir: string, input: unknown): boolean {
  if (dir.startsWith("agent-")) return validateAgent(input).ok;
  if (dir.startsWith("context-manifest-")) return validateContextManifest(input).ok;
  if (dir.startsWith("environment-")) return validateEnvironment(input).ok;
  if (dir.startsWith("harness-attestation-")) return validateHarnessAttestation(input).ok;
  if (dir.startsWith("human-correction-")) return validateHumanCorrection(input).ok;
  if (dir.startsWith("run-")) return validateRun(input).ok;
  throw new Error(`${dir}: no schema owns this vector directory`);
}

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Flip ONE character of the first 64-hex string in a deep copy of `value`.
 *
 * Deliberately a hex-to-hex flip inside a digest field: the mutated fixture is
 * still a VALID record of the same schema, so a digest that changes can only
 * have changed because the bytes changed — not because validation refused the
 * mutant and something downstream swallowed the refusal. `mutated` is asserted
 * valid alongside every mutation test below, which is the positive
 * reachability control for that claim.
 */
function flipOneHexCharacter(value: unknown): { mutated: unknown; changed: boolean } {
  let changed = false;
  function walk(node: unknown): unknown {
    if (typeof node === "string") {
      if (!changed && HEX_64.test(node)) {
        changed = true;
        const last = node.slice(-1);
        return node.slice(0, -1) + (last === "0" ? "1" : "0");
      }
      return node;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        out[key] = walk(child);
      }
      return out;
    }
    return node;
  }
  const mutated = walk(value);
  return { mutated, changed };
}

describe("golden vectors pin the canonical bytes and digests", () => {
  it("holds exactly the seven committed vectors", () => {
    expect(dirs).toEqual([...EXPECTED_VECTORS]);
  });

  for (const dir of dirs) {
    it(`${dir}: canonical bytes and digest match the committed vector`, () => {
      const input: unknown = JSON.parse(readFileSync(join(VECTORS, dir, "input.json"), "utf8"));
      const canonical = readFileSync(join(VECTORS, dir, "canonical.txt"), "utf8");
      const digest = readFileSync(join(VECTORS, dir, "digest.txt"), "utf8").trim();
      expect(canonicalize(input)).toBe(canonical);
      expect(digestForVector(dir, input)).toBe(digest);
      expect(digest).toMatch(HEX_64);
    });

    // THE CONNECTED-INSTRUMENT CONTROL.
    //
    // A vector test that never sees a mismatch cannot tell a working comparison
    // from a comparison someone deleted. This copies the fixture in memory,
    // flips a single character of one digest field, and requires BOTH the
    // canonical bytes and the digest to move — while the mutant stays valid, so
    // the difference is attributable to the bytes and not to a refusal.
    it(`${dir}: one flipped character changes the canonical bytes and the digest`, () => {
      const input: unknown = JSON.parse(readFileSync(join(VECTORS, dir, "input.json"), "utf8"));
      const pinnedCanonical = readFileSync(join(VECTORS, dir, "canonical.txt"), "utf8");
      const pinnedDigest = readFileSync(join(VECTORS, dir, "digest.txt"), "utf8").trim();
      const { mutated, changed } = flipOneHexCharacter(input);
      expect(changed, "every vector must carry a 64-hex field to mutate").toBe(true);
      // Positive reachability: the mutant is still a valid record of this
      // schema, so the digest below is computed and not refused.
      expect(validates(dir, mutated)).toBe(true);
      expect(canonicalize(mutated)).not.toBe(pinnedCanonical);
      expect(digestForVector(dir, mutated)).not.toBe(pinnedDigest);
      // And the original is untouched: the mutation ran on a copy.
      expect(canonicalize(input)).toBe(pinnedCanonical);
    });
  }
});

const readVector = (dir: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(VECTORS, dir, "input.json"), "utf8")) as Record<string, unknown>;

const sorted = (values: readonly string[]): string[] => [...values].sort();

describe("the vectors exercise the closed vocabularies, not a corner of each", () => {
  /**
   * A fixture that happens to use two of seven trust labels pins two of seven
   * rules. These assertions are what make "entries in every section with a
   * valid trust label each" a checked property rather than a claim in a commit
   * message: adding a section or a trust to the vocabulary without extending
   * the vector fails here.
   */
  it("context-manifest-1-trust covers every section, every trust, and every exclusion reason", () => {
    const manifest = readVector("context-manifest-1-trust");
    const entries = manifest.entries as ReadonlyArray<Record<string, string>>;
    const excluded = manifest.excluded as ReadonlyArray<Record<string, string>>;
    expect(sorted(entries.map((e) => e.section))).toEqual(sorted(CONTEXT_SECTIONS));
    expect(sorted(entries.map((e) => e.trust))).toEqual(sorted(CONTEXT_TRUSTS));
    expect(sorted(excluded.map((e) => e.reason))).toEqual(sorted(EXCLUSION_REASONS));
    // And the control-plane rule is genuinely exercised: the stable_prefix
    // entry carries a trust the prefix permits, so this fixture is valid
    // BECAUSE of that rule rather than in spite of never touching it.
    const prefix = entries.filter((e) => e.section === "stable_prefix");
    expect(prefix).toHaveLength(1);
    expect(["authoritative", "ratified", "machine_observed"]).toContain(prefix[0]?.trust);
  });

  it("environment-1-cloud declares every network category and every mount kind", () => {
    const environment = readVector("environment-1-cloud");
    const network = environment.networkPolicy as { allowedCategories: string[] };
    const filesystem = environment.filesystem as { mounts: string[] };
    const secrets = environment.secretPolicy as { source: string };
    expect(sorted(network.allowedCategories)).toEqual(sorted(NETWORK_CATEGORIES));
    expect(sorted(filesystem.mounts)).toEqual(sorted(MOUNT_KINDS));
    expect(SECRET_SOURCES as readonly string[]).toContain(secrets.source);
  });

  it("agent-1-minimal draws its tool categories from TOOL_CATEGORIES", () => {
    const categories = readVector("agent-1-minimal").allowedToolCategories as string[];
    expect(categories.length).toBeGreaterThan(0);
    for (const category of categories) expect(TOOL_CATEGORIES as readonly string[]).toContain(category);
  });

  it("harness-attestation-1-pass covers every status and every observed entrypoint", () => {
    const capabilities = readVector("harness-attestation-1-pass").capabilities as ReadonlyArray<
      Record<string, string>
    >;
    expect(sorted([...new Set(capabilities.map((c) => c.status))])).toEqual(sorted(ATTESTATION_STATUSES));
    expect(sorted([...new Set(capabilities.map((c) => c.observedEntrypoint))])).toEqual(
      sorted(OBSERVED_ENTRYPOINTS),
    );
  });

  it("run-1-created and human-correction-1 name members of their closed sets", () => {
    const run = readVector("run-1-created");
    expect(REQUIRED_TERMINALS as readonly string[]).toContain(run.requiredTerminal as string);
    expect(RUN_STATES as readonly string[]).toContain(run.state as string);
    const correction = readVector("human-correction-1");
    expect(CORRECTION_TYPES as readonly string[]).toContain(correction.correctionType as string);
  });
});

describe("the attestation vectors mean what their names say", () => {

  it("harness-attestation-1-pass establishes only PASS capabilities seen on the installed worker", () => {
    const parsed = validateHarnessAttestation(readVector("harness-attestation-1-pass"));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    // Before expiry. shell_execution was proven on a source_checkout,
    // web_research FAILED, code_sandbox was SKIPPED, and
    // not_a_declared_capability is not a member of HARNESS_CAPABILITIES.
    expect(attestedHarnessCapabilities(parsed.value, "2026-08-23T12:00:00.000Z")).toEqual([
      "repository_editing",
      "evidence_citation",
    ]);
  });

  it("harness-attestation-2-expired is a valid record that establishes nothing", () => {
    const parsed = validateHarnessAttestation(readVector("harness-attestation-2-expired"));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    // Positive control: the same record, read BEFORE its expiry, does establish
    // the capability. So the empty list below is the expiry answering, not a
    // malformed fixture or an unreachable code path.
    expect(attestedHarnessCapabilities(parsed.value, "2026-08-20T12:00:00.000Z")).toEqual([
      "repository_editing",
    ]);
    expect(attestedHarnessCapabilities(parsed.value, "2026-08-23T00:00:00.000Z")).toEqual([]);
  });
});

/**
 * The 24 event types run-events v4 adds.
 *
 * Pinned here as a literal rather than derived from RUN_EVENT_TYPES: deriving
 * the expectation from the thing under test would make this vacuous — a type
 * accidentally deleted from the vocabulary would disappear from both sides at
 * once and the test would still pass.
 */
const V4_ADDITIONS = [
  "run.stalled",
  "run.attempt_started",
  "agent.turn_started",
  "agent.turn_finished",
  "agent.compaction_started",
  "agent.compaction_finished",
  "agent.retry_started",
  "agent.retry_finished",
  "tool.requested",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "tool.confirmation_required",
  "governor.lease_acquired",
  "governor.lease_renewed",
  "governor.lease_lost",
  "artifact.persisted",
  "artifact.verified",
  "approval.expired",
  "context.loaded",
  "context.invalidated",
  "capability.attested",
  "capability.refused",
  "steer.received",
] as const;

type AdditionCase = {
  readonly type: string;
  readonly valid: unknown;
  readonly invalid: unknown;
  readonly expectedIssue: { readonly path: string; readonly code: string };
};

const additions = JSON.parse(
  readFileSync(join(VECTORS, "run-events-v4-additions.json"), "utf8"),
) as { readonly schemaVersion: number; readonly cases: readonly AdditionCase[] };

describe("run-events v4 additions: one accepted and one refused payload per new type", () => {
  it("covers all 24 new types, and each is a member of the vocabulary", () => {
    expect(additions.schemaVersion).toBe(4);
    expect(additions.cases).toHaveLength(24);
    expect(additions.cases.map((c) => c.type)).toEqual([...V4_ADDITIONS]);
    for (const type of V4_ADDITIONS) {
      expect(RUN_EVENT_TYPES as readonly string[]).toContain(type);
    }
    // v3 carried 28 types; v4 carries those plus these 24.
    expect(RUN_EVENT_TYPES).toHaveLength(52);
  });

  it("the refusals are not all one shape", () => {
    // Non-vacuity. Twenty-four copies of "unknown field" would exercise one
    // branch of the payload validator and read as full coverage.
    const codes = new Set(additions.cases.map((c) => c.expectedIssue.code));
    expect(codes.size).toBeGreaterThanOrEqual(6);
    expect(codes).toContain("field_not_allowed");
    expect(codes).toContain("invalid_enum");
  });

  for (const testCase of additions.cases) {
    it(`${testCase.type}: the kinded payload is accepted`, () => {
      const result = validateRunEvent(testCase.valid);
      expect(result.ok ? [] : result.issues).toEqual([]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.type).toBe(testCase.type);
    });

    it(`${testCase.type}: the refused payload fails with exactly ${testCase.expectedIssue.code}`, () => {
      const result = validateRunEvent(testCase.invalid);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // EXACTLY one issue, and it is the intended one. Asserting "some issue
      // mentions this code" would pass when an earlier guard refused first for
      // an unrelated reason, which is not this event type's payload rule being
      // reached at all.
      expect(result.issues.map((i) => ({ path: i.path, code: i.code }))).toEqual([
        { path: testCase.expectedIssue.path, code: testCase.expectedIssue.code },
      ]);
    });
  }
});
