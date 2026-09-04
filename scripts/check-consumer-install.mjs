#!/usr/bin/env node
/**
 * These packages are installable, and what they export survives being installed.
 *
 * Everything else in this gate runs inside the workspace, where TypeScript
 * resolves `@getsimpledirect/vinci-contracts` through tsconfig path aliases and
 * project references to the SOURCE. A consumer gets none of that. It gets a
 * tarball, `main`, `types`, `exports` and `files` — and a package can pass every
 * other check here while being unusable the moment it is installed: a `files`
 * list missing `dist`, a `types` path pointing at a file that was never emitted,
 * a declaration importing a path that only resolves inside the monorepo.
 *
 * So this check does what a consumer does. It packs every package with
 * `npm pack` (which runs `prepack`, so the tarball holds a real build), installs
 * the tarballs into an empty directory outside this repository, and then both
 * TYPE-CHECKS and RUNS a small program that imports across all four layers.
 *
 * Both halves are necessary and neither substitutes for the other:
 *   - `tsc --noEmit` alone proves declarations resolve, and would pass if every
 *     runtime file were missing.
 *   - Running alone proves the JavaScript loads, and would pass if the types
 *     were nonsense. `tsx` and `node --strip-types` both erase types WITHOUT
 *     checking them, which has already fooled someone in this repository into
 *     believing a fabricated API shape worked.
 *
 * Not part of `npm run gate`: it installs from the network and takes minutes.
 * CI runs it on pull requests via `npm run check:pack`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertExpectedInventory, readManifests, root } from "./lib/inventory.mjs";

const scratch = mkdtempSync(join(tmpdir(), "vinci-consumer-"));
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// The inventory must match what is committed, not merely clear a floor. A floor
// of five let a deleted package through: nine packages install cleanly and
// report success, and nothing says the tenth was never tested.
const packages = assertExpectedInventory(readManifests());

// Build the whole workspace FIRST, in dependency order.
//
// `npm pack` runs each package's own `prepack`, which is `tsc` for that package
// alone — and that compile resolves its dependencies through node_modules to
// their `types`, i.e. to a dist/ that a per-package build does not produce. So
// packing approvals before contracts has been built fails with TS2307 on
// @getsimpledirect/vinci-contracts.
//
// This was invisible locally and CI found it on the first run: a developed tree
// already has dist/ everywhere from the last gate, so the per-package builds
// resolved against leftovers. A clean checkout has none, which is the state a
// release actually runs in.
console.log("  building the workspace in dependency order (npm pack's prepack needs it)");
try {
  run("npx", ["tsc", "--build", ...packages.map((d) => `packages/${d}/tsconfig.json`)], root);
} catch (error) {
  console.error("  workspace build failed before packing:\n");
  console.error(String(error.stdout ?? "") + String(error.stderr ?? "") || String(error));
  process.exit(1);
}

console.log(`  packing ${packages.length} packages into ${scratch}`);
const tarballs = {};
for (const dir of packages) {
  const packageDir = join(root, "packages", dir);
  const name = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).name;
  const out = run("npm", ["pack", "--pack-destination", scratch, "--silent"], packageDir).trim();
  const file = out.split("\n").pop().trim();
  if (!file.endsWith(".tgz")) {
    console.error(`  ${dir}: npm pack produced no tarball (got ${JSON.stringify(out)})`);
    process.exit(1);
  }
  tarballs[name] = join(scratch, file);
}

// The fixture is deliberately NOT a workspace and NOT inside this repository:
// a fixture under the repo root would inherit its tsconfig, its node_modules and
// its path aliases, and would then prove nothing about a real consumer.
const fixture = mkdtempSync(join(tmpdir(), "vinci-fixture-"));
writeFileSync(
  join(fixture, "package.json"),
  JSON.stringify(
    {
      name: "consumer-fixture",
      private: true,
      type: "module",
      dependencies: Object.fromEntries(
        Object.entries(tarballs).map(([name, path]) => [name, `file:${path}`]),
      ),
      devDependencies: { typescript: "5.9.3" },
    },
    null,
    2,
  ),
);
// THE README'S EXAMPLES ARE COMPILED, against the installed packages.
//
// A reviewer found the SessionBinding example still constructing a binding
// without the two version fields this same branch made required — with a
// `// Valid: true` comment beside it that had become false. Nothing could have
// caught that: prose is not compiled, and the one thing that reads these blocks
// is a person copying one into their editor.
//
// This is also the second time in this repository: README examples with
// fabricated API shapes once "ran fine" under a type-stripping runner, which
// checks nothing. Compiling them against the INSTALLED packages is the only
// version of this check worth having — compiling against source would pass on
// APIs a consumer cannot reach.
const readme = readFileSync(join(root, "README.md"), "utf8");
const examples = [...readme.matchAll(/```typescript\n([\s\S]*?)```/g)].map((match) => match[1]);

// Non-vacuity: a regex that silently stops matching would report every example
// as passing. The count only ever goes up as documentation grows.
if (examples.length < 6) {
  console.error(`  found only ${examples.length} typescript examples in README.md`);
  console.error("  the extractor is broken, not the documentation");
  process.exit(1);
}
const exampleFiles = examples.map((source, index) => {
  const file = `readme-example-${index}.ts`;
  writeFileSync(join(fixture, file), source);
  return file;
});

writeFileSync(
  join(fixture, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        // What a modern consumer actually sets. No paths, no references, no
        // rootDir into this repository.
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      include: ["consumer.ts", ...exampleFiles],
    },
    null,
    2,
  ),
);

// EVERY package is imported, not a representative few.
//
// The first version of this file imported three packages and hand-wrote the
// list. A test mutation that removed "dist" from evidence's `files` — shipping
// a tarball with no build in it — passed clean, because nothing in the fixture
// ever loaded evidence. npm had installed it as a transitive dependency and
// left it there, unopened. A check that covers a subset it chose by hand
// reports on the subset and is read as reporting on the whole.
//
// The list is DERIVED from what was packed, so a package added tomorrow is
// covered tomorrow without anyone remembering to add it here.
const everyPackage = Object.keys(tarballs).sort();
const namespaceImports = everyPackage
  .map((name, index) => `import * as ns${index} from "${name}";`)
  .join("\n");
// INVARIANT, not luck: every package here exports at least one RUNTIME value
// (a const vocabulary, a validator, a constructor). A types-only package would
// have an empty namespace at runtime and this assertion would fail it wrongly.
// If one is ever added, the fix is to check that its declarations resolve
// rather than that its namespace is non-empty — do not weaken this into a check
// that passes for a package shipping no build at all, which is precisely what
// it caught.
const namespaceChecks = everyPackage
  .map(
    (name, index) =>
      `if (Object.keys(ns${index}).length === 0) throw new Error("${name} installed but exports nothing at runtime");`,
  )
  .join("\n");

// Plus one program crossing every layer: 0 (contracts), 1 (policy),
// 3 (remote-protocol), using real values rather than only resolving names.
writeFileSync(
  join(fixture, "consumer.ts"),
  `${namespaceImports}
import { RISK_LEVELS, isCanonicalTimestamp, type RiskLevel } from "@getsimpledirect/vinci-contracts";
import { RETENTION_CLASSES } from "@getsimpledirect/vinci-policy";
import {
  matchEndpointToRole, selectForRole, violatesIndependence, roleById, endpointById,
  validateModelEndpointSpec,
} from "@getsimpledirect/vinci-model-classes";
import {
  validateSessionBinding, REMOTE_PROTOCOL_VERSION, SESSION_BINDING_SCHEMA_META,
  validateReviewPublicationAttribution, parseReviewPublicationAttributionJson,
  verifyReviewPublicationAttributionSignature, validateReviewPublicationReference,
} from "@getsimpledirect/vinci-remote-protocol";
import { checkValidatedExecutionSpecWithinOrder } from "@getsimpledirect/vinci-work-orders/dist/within-order.js";

const level: RiskLevel = RISK_LEVELS[0];
if (level !== "critical") throw new Error("RISK_LEVELS is not ordered most-severe-first");
if (!RETENTION_CLASSES.includes("zdr_0d")) throw new Error("RETENTION_CLASSES lost a member");
if (!isCanonicalTimestamp("2026-08-24T00:00:00.000Z")) throw new Error("timestamp check broke");

const good = validateSessionBinding({
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  schemaVersion: SESSION_BINDING_SCHEMA_META.version,
  sessionId: "sess-1", runId: "run-1", workspaceId: "ws-1", organizationId: null,
  hostDeviceId: "dev-1", policyId: "pol-1", policyVersion: 1, retentionClass: "zdr_0d",
});
if (!good.ok) throw new Error("a valid binding was refused: " + JSON.stringify(good));

// The guard must still refuse from outside the workspace. A validator that
// passes everything looks identical to one that works, from the accept side.
const skewed = validateSessionBinding({
  protocolVersion: REMOTE_PROTOCOL_VERSION + 1,
  schemaVersion: SESSION_BINDING_SCHEMA_META.version,
  sessionId: "sess-1", runId: "run-1", workspaceId: "ws-1", organizationId: null,
  hostDeviceId: "dev-1", policyId: "pol-1", policyVersion: 1, retentionClass: "zdr_0d",
});
if (skewed.ok) throw new Error("protocol skew was accepted by an installed build");

// The new review-publication surface must survive packing, including its
// strict JSON entry point and cryptographic helper — source-path tests cannot
// prove that any of these exports reached dist/index.js in the tarball.
const reviewAttribution = {
  schemaVersion: 1,
  purpose: "guard_review.publish",
  audience: "vinci-acceptance",
  actor: { kind: "verifier", verifierId: "verifier-01JTEST", independent: true },
  binding: { protocolVersion: 1, organizationId: "organization-1", workspaceId: "workspace-1", runId: "review-run-1", sessionId: "session-1" },
  subject: {
    provider: "github", repositoryNodeId: "R_kgDOExample", pullRequestNumber: 10,
    headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    headTreeSha: "cccccccccccccccccccccccccccccccccccccccc",
  },
  verdict: "GO",
  recordSetDigest: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  idempotencyKey: "review-publication-01JTEST",
  issuedAt: "2026-09-04T12:00:00.000Z",
  expiresAt: "2026-09-04T12:10:00.000Z",
  issuerKeyId: "vgc-platform-key-1",
  signature: { alg: "Ed25519", value: "MvkxKoVgn7zs8g6j4_PjXfFLMznHv2VsJuUvC_m3wCndIgIFTq5Olr9JdnEVr7jfynjCArps98WH2PRQFvMcDw" },
} as const;
const checkedReview = validateReviewPublicationAttribution(reviewAttribution, "2026-09-04T12:05:00.000Z");
if (!checkedReview.ok) throw new Error("installed review attribution validator refused the golden value");
if (!parseReviewPublicationAttributionJson(JSON.stringify(reviewAttribution), "2026-09-04T12:05:00.000Z").ok) {
  throw new Error("installed strict review attribution JSON parser refused the golden value");
}
const installedDeep = parseReviewPublicationAttributionJson(
  "[".repeat(1_100) + "0" + "]".repeat(1_100),
  "2026-09-04T12:05:00.000Z",
);
if (installedDeep.ok) {
  throw new Error("installed strict review parser accepted excessive depth");
}
if (!("issues" in installedDeep) || !installedDeep.issues.some((entry) => entry.code === "too_deep")) {
  throw new Error("installed strict review parser did not fail closed on excessive depth");
}
const installedYearZero = validateReviewPublicationAttribution({
  ...reviewAttribution,
  issuedAt: "0000-01-01T00:00:00.000Z",
  expiresAt: "0000-01-01T00:10:00.000Z",
}, "0000-01-01T00:05:00.000Z");
if (installedYearZero.ok) {
  throw new Error("installed review validator accepted a timestamp outside the shared year domain");
}
if (!("issues" in installedYearZero) || !installedYearZero.issues.some((entry) => entry.code === "invalid_timestamp")) {
  throw new Error("installed review validator accepted a timestamp outside the shared year domain");
}
const installedCyclicActor: Record<string, unknown> = {
  kind: "verifier", verifierId: null, independent: true,
};
installedCyclicActor.verifierId = installedCyclicActor;
const installedCyclic = validateReviewPublicationAttribution({
  ...reviewAttribution,
  actor: installedCyclicActor,
}, "2026-09-04T12:05:00.000Z");
if (installedCyclic.ok) throw new Error("installed review validator accepted a cyclic direct object");
if (!verifyReviewPublicationAttributionSignature(checkedReview.value, "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo")) {
  throw new Error("installed review attribution signature helper refused the golden signature");
}
if (!validateReviewPublicationReference("grv_01JTEST@sha256:ddd88ffea6e4cfd88caa0ace345f31954d8d72c530f0fde9a4ed6638f7abc378").ok) {
  throw new Error("installed compact review reference parser refused the golden pointer");
}

// The comparison helper is package-private by convention, but this package has
// no exports map and ships dist/, so a consumer can deep-import it. It must not
// turn a malformed path into success merely because its documented caller is
// supposed to validate first. Both directions execute the packed JavaScript.
const deepOrder = {
  expiresAt: "2026-08-24T12:00:00.000Z",
  grantedAuthority: [
    "repo:github.com/getsimpledirect/vinci-contracts",
    "branch:feat/*",
    "promotion:pull_request",
    "path:src/",
  ],
};
const deepSpec = {
  resourceBounds: { deadline: "2026-08-23T14:00:00.000Z" },
  tools: [],
  repository: { host: "github.com", owner: "getsimpledirect", name: "vinci-contracts" },
  targetBranch: "feat/installed-probe",
  promotion: "pull_request",
  paths: ["src/index.ts"],
};
if (!checkValidatedExecutionSpecWithinOrder(deepSpec as never, deepOrder as never).ok) {
  throw new Error("the installed deep helper refused a covered path");
}
const malformedDeepPath = checkValidatedExecutionSpecWithinOrder(
  { ...deepSpec, paths: ["../../etc/shadow"] } as never,
  deepOrder as never,
);
if (!("issues" in malformedDeepPath)) {
  throw new Error("the installed deep helper widened authority for a malformed path");
}
if (!malformedDeepPath.issues.some(
  (candidate) => candidate.path === "/paths/0" && candidate.code === "path_grant_dotdot_segment",
)) {
  throw new Error("the installed deep helper returned the wrong malformed-path refusal");
}

// The Model Role ABI must DECIDE from outside the workspace, not merely import.
// This is the check 0.2.0 would have failed: it shipped eight of sixteen
// modules, so matchEndpointToRole was absent from every published artifact
// while the package still installed and imported cleanly. An ABI that is
// present but cannot rule is the same defect one layer down.
const abiRole = roleById("teacher-trajectory-producer");
const abiEndpoint = endpointById("forte-deepinfra");
if (!abiRole || !abiEndpoint) throw new Error("the installed registry lost a role or a lane");

const NOW_ABI = "2026-08-31T00:00:00.000Z";

// This role requires evidence_citation from the HARNESS, which an inference endpoint
// cannot supply. Withholding eligibility until a caller attests it is the fix for
// fail-open #9, where the requirement was moved into a field nothing read and four
// production lanes became eligible for a role nobody could satisfy.
if (matchEndpointToRole(abiRole, abiEndpoint, NOW_ABI).verdict === "eligible") {
  throw new Error("an unattested harness requirement was granted by an installed build");
}

// ...and it must still GRANT once the harness is attested, or the guard above is just
// a matcher that refuses everything. Both directions, through the published surface.
if (
  matchEndpointToRole(abiRole, abiEndpoint, NOW_ABI, ["evidence_citation"]).verdict !==
  "eligible"
) {
  throw new Error("a fully declared and attested lane was not eligible from an installed build");
}

// Both directions, because a matcher that refuses everything passes the accept
// side of every test and is worthless. These three are fail-CLOSED assertions:
// each was a real fail-open in this package's history.
const hostileEndpoint = Object.create(null);
if (matchEndpointToRole(abiRole, hostileEndpoint, NOW_ABI).verdict === "eligible") {
  throw new Error("an unreadable endpoint was granted eligibility by an installed build");
}
if (violatesIndependence(hostileEndpoint, abiEndpoint) !== true) {
  throw new Error("independence was granted against an unreadable endpoint");
}

// The iteration bound: a real Array claiming four billion entries must refuse,
// not exhaust the heap. Array.isArray is true for it, which is why a shape
// check alone did not catch this.
const hugeSupply = Object.assign([], { length: 2 ** 32 - 1 });
const hugeSelection = selectForRole(abiRole, hugeSupply, NOW_ABI);
if (hugeSelection.eligible.length !== 0 || hugeSelection.unevaluable.length !== 1) {
  throw new Error("the endpoint-list bound did not survive installation");
}

// ---------------------------------------------------------------------------
// FAIL-OPEN BATTERY, run against the INSTALLED build.
//
// These probes used to live as loose files in /tmp. They drifted out of sync
// with the schema and went vacuous WITHOUT SAYING SO: every spec they built was
// rejected as malformed in the defensive preamble, so each probe measured
// "refused as invalid" and never reached the guard it named. It still looked
// healthy, because refusal blocks and blocking is the safe direction. They also
// hardcoded a path to a worktree that still existed at a different commit, so
// running them validated code nobody was reviewing.
//
// Living here fixes both. The fixture is built from the package's own exports,
// so a schema change breaks this loudly instead of quietly, and the target is
// whatever was actually packed.
const K = (value: unknown) => ({ kind: "known", value });
const UNKNOWN = { kind: "unknown" };
const probeSpec = (
  endpointId: string,
  sourceClass: unknown,
  weightsDigest?: string,
  serving?: unknown,
): ns4.ModelEndpointSpec =>
  ({
  schemaVersion: 1,
  endpointId,
  capabilityProfile: { capabilities: ["text"], contextLimit: 1000, toolSupport: false },
  declaredCapabilities: [],
  credentials: { source: { kind: "managed-credential", credentialId: "c" } },
  inferenceIsExternal: K(false),
  approvedForProtectedData: K(false),
  rights: {
    trainingAllowed: K(false),
    evaluationAllowed: K(false),
    redistributionAllowed: K(false),
    outputRetainedByProvider: K(false),
    policySnapshotDigest: K("d"),
  },
  validFrom: "2026-01-01T00:00:00.000Z",
  expiresAt: "2027-01-01T00:00:00.000Z",
  sourceClass,
  serving: serving ?? { kind: "vinci_hosted" },
  weightsDigest: weightsDigest === undefined ? UNKNOWN : K(weightsDigest),
  tokenizerDigest: K("t"),
  architectureDigest: K("a"),
  servingImageDigest: K("i"),
    quantizationDigest: UNKNOWN,
  }) as unknown as ns4.ModelEndpointSpec;

// A probe that cannot build a VALID spec proves nothing about any guard. This is
// the assertion whose absence let the /tmp battery report success for weeks.
const probeValidation = validateModelEndpointSpec(probeSpec("probe-a", "open_weight", "W-A"));
if (!probeValidation.ok) {
  throw new Error(
    "fail-open probes construct an INVALID spec, so their verdicts mean nothing: " +
      JSON.stringify((probeValidation as { readonly issues?: unknown }).issues),
  );
}

// Both directions. A guard that refuses everything passes every fail-closed test
// and is useless, so the grant case is asserted first.
if (violatesIndependence(probeSpec("a", "open_weight", "W-A"), probeSpec("b", "open_weight", "W-B")) !== false) {
  throw new Error("two endpoints with DIFFERENT weights were not independent");
}
if (violatesIndependence(probeSpec("a", "open_weight", "W-A"), probeSpec("b", "open_weight", "W-A")) !== true) {
  throw new Error("two endpoints with THE SAME weights were treated as independent");
}

// Absence must never grant, in every shape it has actually arrived in.
const mustBlock: [string, ns4.ModelEndpointSpec, ns4.ModelEndpointSpec][] = [
  ["both digests unknown", probeSpec("a", "open_weight", undefined), probeSpec("b", "open_weight", undefined)],
  ["one digest unknown", probeSpec("a", "open_weight", "W-A"), probeSpec("b", "open_weight", undefined)],
  ["null sourceClass", probeSpec("a", null, "W-A"), probeSpec("b", "open_weight", "W-B")],
  ["unknown sourceClass", probeSpec("a", "not_a_class", "W-A"), probeSpec("b", "open_weight", "W-B")],
  [
    "same weights across different serving",
    probeSpec("a", "open_weight", "W-A", {
      kind: "third_party_api",
      provider: "deepinfra",
      model: "m",
      modelRevision: K("r"),
      jurisdiction: K("us"),
    }),
    probeSpec("b", "open_weight", "W-A"),
  ],
];
for (const [label, left, right] of mustBlock) {
  if (violatesIndependence(left, right) !== true) {
    throw new Error("independence was granted from an installed build: " + label);
  }
}

// A class instance is not a plain object, and once passed a check written for one.
class SpecInstance {
  constructor(fields: unknown) {
    Object.assign(this, fields);
  }
}
if (
  violatesIndependence(
    new SpecInstance(probeSpec("a", "open_weight", "W-A")) as unknown as ns4.ModelEndpointSpec,
    new SpecInstance(probeSpec("b", "open_weight", "W-A")) as unknown as ns4.ModelEndpointSpec,
  ) !== true
) {
  throw new Error("a class-instance spec escaped the independence guard");
}

// Read-once: a field that answers differently on a second read must not be able
// to grant. The decision value must be the value recorded.
const twoFaced = probeSpec("g", "open_weight", "W-A");
let digestReads = 0;
Object.defineProperty(twoFaced, "sourceClass", {
  enumerable: true,
  get() {
    digestReads += 1;
    return digestReads === 1 ? "open_weight" : "frontier_api";
  },
});
if (violatesIndependence(twoFaced, probeSpec("b", "open_weight", "W-A")) !== true) {
  throw new Error("a two-faced accessor was granted independence by an installed build");
}

// The harness guard's own fail-open: Array.isArray is TRUE for a Proxy wrapping
// an array, and reading length twice let a requirement vanish between the check
// and its use.
let harnessLengthReads = 0;
const twoFacedHarness = new Proxy(["repository_editing", "long_horizon_recovery"], {
  get(target, property, receiver) {
    if (property === "length") {
      harnessLengthReads += 1;
      return harnessLengthReads === 1 ? 2 : 0;
    }
    return Reflect.get(target, property, receiver);
  },
});
const proxyRole = roleById("mle-implementation-worker");
const proxyEndpoint = endpointById("forte-deepinfra");
if (!proxyRole || !proxyEndpoint) throw new Error("the installed registry lost the proxy-probe fixtures");
if (
  matchEndpointToRole(
    { ...proxyRole, requiredHarnessCapabilities: twoFacedHarness } as unknown as ns4.ModelRoleSpec,
    proxyEndpoint,
    NOW_ABI,
    ["irrelevant"] as unknown as readonly ns4.HarnessCapability[],
  ).verdict === "eligible"
) {
  throw new Error("a two-faced harness length granted eligibility from an installed build");
}

// An attestation that claims to contain everything, but contains nothing.
if (
  matchEndpointToRole(
    proxyRole,
    proxyEndpoint,
    NOW_ABI,
    Object.assign([], { includes: () => true }) as unknown as readonly ns4.HarnessCapability[],
  ).verdict === "eligible"
) {
  throw new Error("a lying attestation granted eligibility from an installed build");
}

${namespaceChecks}

console.log(\`  consumer imported all ${everyPackage.length} packages across layers 0-3, types checked, guards still refuse, Model Role ABI still decides\`);
`,
);

// Non-vacuity on the coverage itself: every packed package must appear in the
// program that is about to be compiled. If the generation above ever silently
// produces fewer imports than there are tarballs, this fails rather than
// reporting a clean install of a subset.
const consumerSource = readFileSync(join(fixture, "consumer.ts"), "utf8");
const uncovered = Object.keys(tarballs).filter((name) => !consumerSource.includes(`"${name}"`));
if (uncovered.length > 0) {
  console.error(`  packed but never imported by the fixture: ${uncovered.join(", ")}`);
  console.error("  a package nothing loads can ship broken and pass this check");
  process.exit(1);
}

try {
  console.log("  installing tarballs into a clean fixture");
  run("npm", ["install", "--no-audit", "--no-fund", "--silent"], fixture);

  console.log(
    `  type-checking the consumer and ${exampleFiles.length} README examples `
      + "against the PUBLISHED declarations",
  );
  run(join(fixture, "node_modules", ".bin", "tsc"), ["--project", "tsconfig.json"], fixture);

  console.log("  running the consumer against the PUBLISHED javascript");
  // Compiled first, then executed: stripping types would not check them.
  run(join(fixture, "node_modules", ".bin", "tsc"), ["consumer.ts", "--target", "ES2022",
    "--module", "NodeNext", "--moduleResolution", "NodeNext", "--outDir", "built"], fixture);
  process.stdout.write(run("node", [join(fixture, "built", "consumer.js")], fixture));
} catch (error) {
  console.error("  consumer install FAILED — these packages do not work when installed:\n");
  console.error(String(error.stdout ?? "") + String(error.stderr ?? "") || String(error));
  console.error(`\n  fixture left in place for inspection: ${fixture}`);
  process.exit(1);
}

rmSync(scratch, { recursive: true, force: true });
rmSync(fixture, { recursive: true, force: true });
console.log("  packed, installed, type-checked and executed outside the workspace");
