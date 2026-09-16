/**
 * Repo-wide invariant: every exported validator refuses a hostile own key,
 * and refuses it by FAILING rather than by throwing.
 *
 * This check exists because of a defect class that appeared three separate
 * times in this repository, each time in a different file, each time fixed by
 * name without anyone going looking for its siblings:
 *
 *   mayIssue("toString", ...)                  threw (PERMITTED[role] found
 *                                              Object.prototype.toString)
 *   validateRemoteDecisionState({kind:"toString"})  threw ("in" walks the chain)
 *   statusIsSupportedBy([Object.create({status:"supported"})])  returned TRUE
 *
 * The last one manufactured an unearned pass. Fixing instances one at a time
 * is how the third survived the first two fixes, so the property is asserted
 * here across every validator at once, including validators not yet written.
 *
 * `__proto__` is the probe because JSON.parse creates it as a genuine OWN
 * property, so it crosses a serialization boundary intact and reaches a
 * validator looking exactly like ordinary data.
 */
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packages = readdirSync(join(root, "packages"))
  .filter((dir) => existsSync(join(root, "packages", dir, "package.json")))
  .map((dir) => ({
    dir,
    name: JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8")).name,
  }));
const packageDirs = new Map(packages.map(({ dir, name }) => [name, dir]));

/**
 * Hostile shapes, one per way a validator reaches for a key.
 *
 * A single `__proto__` probe is NOT enough, and finding that out is why this
 * list exists: every validator rejects an unknown top-level field anyway, so a
 * `__proto__`-only probe passes even with the forbidden-key guard disabled. It
 * confirms unknown-field handling and calls it prototype safety.
 *
 * The defects this check is meant to catch lived at DISCRIMINATOR lookups —
 * `KEYS[kind]`, `PERMITTED[role]` — which are only reached once the
 * discriminator is present and string-typed. So the probes below carry
 * inherited property names in the discriminator position, where an ordinary
 * object lookup finds Object.prototype's member instead of undefined.
 */
function hostileInputs() {
  const inherited = ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"];
  const shapes = [["own __proto__ key", JSON.parse('{"__proto__":{"polluted":true},"a":1}')]];
  for (const name of inherited) {
    // The discriminator field is spelled differently across packages; cover the
    // ones actually used so the probe reaches each package's lookup.
    for (const field of ["kind", "type", "status", "provenance", "outcome"]) {
      shapes.push([`${field}=${name}`, { [field]: name }]);
    }
  }
  return shapes;
}

/**
 * Exported boolean AUTHORITY GUARDS, probed explicitly.
 *
 * This registry exists because the check above documented three defects and
 * exercised NONE of the two functions it named. Its selector is /^validate/,
 * and neither `mayIssue` nor `statusIsSupportedBy` begins with "validate", so
 * the file cited them in its own header while never calling them. A check whose
 * comment describes coverage it does not have is worse than one that claims
 * nothing, because it retires the concern.
 *
 * A boolean guard cannot fail closed by returning a ValidationResult, so the
 * contract is different from a validator's: for every hostile input it must
 * return exactly `false`, never `true` and never throw. Each entry also carries
 * a POSITIVE CONTROL, because a guard that returns false unconditionally
 * satisfies every hostile case here and is useless.
 *
 * Add a guard here when you export one. The registry is the contract.
 */
/**
 * One committed Oracle vector, by directory name.
 *
 * The oracle-records guards below need a WHOLE valid research request, and a
 * copy of one typed into this file would be a second definition of the contract
 * that drifts the moment the schema moves. Reading the committed vector means
 * the positive control below runs against the same bytes the cross-language
 * suite pins, so a schema change breaks this check loudly instead of leaving it
 * asserting something about a record shape that no longer exists.
 */
function oracleVector(name) {
  return JSON.parse(
    readFileSync(join(root, "packages", "oracle-records", "vectors", name, "input.json"), "utf8"),
  );
}

/** Deep clone with ONE field replaced at a JSON pointer. */
function oracleWithout(value, pointer) {
  const copy = JSON.parse(JSON.stringify(value));
  const segments = pointer.split("/").slice(1);
  const last = segments.pop();
  let node = copy;
  for (const segment of segments) node = node[segment];
  delete node[last];
  return copy;
}

const ORACLE_REQUEST = oracleVector("research-request-1-admitted");
const ORACLE_CITATION = oracleVector("source-citation-1-delivered");
const ORACLE_SOURCE = oracleVector("source-record-1-repository-read");
const ORACLE_HANDLES = [
  {
    sourceId: ORACLE_SOURCE.sourceId,
    runRef: ORACLE_SOURCE.runRef,
    workspaceRef: ORACLE_SOURCE.workspaceRef,
    presentationIndex: ORACLE_SOURCE.presentationIndex,
  },
];
const ORACLE_BINDING = oracleVector("context-binding-1-complete");
const ORACLE_CLAIM = oracleVector("claim-record-1-observed");
const ORACLE_PROPOSAL = oracleVector("decision-proposal-1-request-observation");
const ORACLE_OUTCOME = oracleVector("outcome-record-1-helpful-disproved");
/** The S3 job-shape allowlist PROP-03 maps against. One kind, one shape. */
/** The work orders a host authorized, and the report bundle, for the guards below. */
const ORACLE_AUTHORIZED_WORK = [
  {
    workRef: ORACLE_OUTCOME.authorizedWorkRef,
    runRef: ORACLE_OUTCOME.runRef,
    workspaceRef: ORACLE_OUTCOME.workspaceRef,
  },
];
const ORACLE_BUNDLE = {
  report: oracleVector("research-report-1-partial"),
  claims: [oracleVector("claim-record-1-observed"), oracleVector("claim-record-2-hypothesis")],
  assessments: [oracleVector("claim-assessment-1-supported")],
  proposal: null,
  delivered: [
    {
      sourceId: ORACLE_SOURCE.sourceId,
      runRef: ORACLE_SOURCE.runRef,
      workspaceRef: ORACLE_SOURCE.workspaceRef,
      presentationIndex: ORACLE_SOURCE.presentationIndex,
    },
  ],
};
/**
 * One BOUND claim from the fixture bundle, for the evidenceIsMissing control.
 *
 * Resolved lazily through the package's own resolver rather than typed here: a
 * hand-built BoundClaim would be a second definition of the shape, and it would
 * agree with a broken resolver.
 */
let ORACLE_BOUND_CLAIM = () => undefined;
/** The same claim with every cited span unresolved, i.e. evidence genuinely missing. */
let ORACLE_MISSING_CLAIM = () => undefined;
function bindOracleBoundClaim(mod) {
  ORACLE_MISSING_CLAIM = () => {
    const bound = ORACLE_BOUND_CLAIM();
    if (bound === undefined) return undefined;
    return {
      ...bound,
      assessment: undefined,
      unresolvedSourceIds: bound.claim.sourceSpans.map((span) => span.sourceId),
    };
  };
  ORACLE_BOUND_CLAIM = () => {
    const resolved = mod.resolveReportBundle(ORACLE_BUNDLE);
    if (resolved.outcome !== "RESOLVED") return undefined;
    return resolved.claims.find((c) => c.state === "BOUND");
  };
}
const ORACLE_JOB_SHAPES = [
  { kind: ORACLE_PROPOSAL.payload.kind, jobShapeRef: ORACLE_PROPOSAL.payload.proposedJobShapeRef },
];
const ORACLE_MANIFEST = JSON.parse(
  readFileSync(
    join(root, "packages", "oracle-records", "vectors", "bound-context-manifest.json"),
    "utf8",
  ),
);
/**
 * The identity an admission host would have stored for ORACLE_REQUEST.
 *
 * `requestDigest` is deliberately NOT computed here: a control that derives the
 * expected digest from the function under test would agree with it however
 * wrong both were. It is the pinned digest from the committed vector.
 */
const ORACLE_PRIOR_IDENTITY = {
  schemaVersion: 1,
  idempotencyKey: ORACLE_REQUEST.hostResolved.lineage.idempotencyKey,
  requestId: ORACLE_REQUEST.hostResolved.requestId,
  requestDigest: readFileSync(
    join(root, "packages", "oracle-records", "vectors", "research-request-1-admitted", "digest.txt"),
    "utf8",
  ).trim(),
};

const AUTHORITY_GUARDS = [
  {
    pkg: "@getsimpledirect/vinci-device-auth",
    export: "isCredentialActiveAt",
    label: "isCredentialActiveAt(credential, at)",
    call: (fn, hostile) => fn(hostile, "2026-08-26T12:00:00.000Z"),
    control: (fn) =>
      fn({ kind: "device", id: "c", deviceId: "d", keyHash: "a".repeat(64), prefix: "p", clientType: "work", scopes: ["inference"], createdAt: "2026-08-26T11:00:00.000Z", revokedAt: null, expiresAt: "2026-08-26T12:10:00.000Z", publicKey: null }, "2026-08-26T12:00:00.000Z") === true
      && fn({ kind: "device", id: "c", deviceId: "d", keyHash: "a".repeat(64), prefix: "p", clientType: "work", scopes: ["inference"], createdAt: "2026-08-26T11:00:00.000Z", revokedAt: "2026-08-26T12:00:00.000Z", expiresAt: null, publicKey: null }, "2026-08-26T12:00:00.000Z") === false
      && fn({ kind: "device", id: "c", deviceId: "d", keyHash: "a".repeat(64), prefix: "p", clientType: "work", scopes: ["inference"], createdAt: "2026-08-26T11:00:00.000Z", revokedAt: null, expiresAt: "2026-08-26T12:00:00.000Z", publicKey: null }, "2026-08-26T12:00:00.000Z") === false,
  },
  {
    pkg: "@getsimpledirect/vinci-device-auth",
    export: "isKeyUsableAt",
    label: "isKeyUsableAt(entry with hostile status, now, role)",
    call: (fn, hostile) => fn({ schemaVersion: 1, keyId: "key-1", role: "platform-issuer", key: { kind: "Ed25519", keyId: "key-1", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, validFrom: "2026-08-26T11:00:00.000Z", refreshAfter: "2026-08-26T12:01:00.000Z", status: hostile }, "2026-08-26T12:00:00.000Z", "platform-issuer"),
    control: (fn) =>
      fn({ schemaVersion: 1, keyId: "key-1", role: "platform-issuer", key: { kind: "Ed25519", keyId: "key-1", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, validFrom: "2026-08-26T11:00:00.000Z", refreshAfter: "2026-08-26T12:01:00.000Z", status: "active" }, "2026-08-26T12:00:00.000Z", "platform-issuer") === true
      && fn({ schemaVersion: 1, keyId: "key-1", role: "platform-issuer", key: { kind: "Ed25519", keyId: "key-1", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, validFrom: "2026-08-26T11:00:00.000Z", refreshAfter: "2026-08-26T12:01:00.000Z", status: "revoked" }, "2026-08-26T12:00:00.000Z", "platform-issuer") === false,
  },
  {
    pkg: "@getsimpledirect/vinci-device-auth",
    export: "isKeyUsableAt",
    label: "isKeyUsableAt(entry with hostile role, now, role)",
    call: (fn, hostile) => fn({ schemaVersion: 1, keyId: "key-1", role: hostile, key: { kind: "Ed25519", keyId: "key-1", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, validFrom: "2026-08-26T11:00:00.000Z", refreshAfter: "2026-08-26T12:01:00.000Z", status: "active" }, "2026-08-26T12:00:00.000Z", "platform-issuer"),
    control: (fn) =>
      fn({ schemaVersion: 1, keyId: "key-1", role: "platform-issuer", key: { kind: "Ed25519", keyId: "key-1", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, validFrom: "2026-08-26T11:00:00.000Z", refreshAfter: "2026-08-26T12:01:00.000Z", status: "active" }, "2026-08-26T12:00:00.000Z", "platform-issuer") === true
      && fn({ schemaVersion: 1, keyId: "key-1", role: "device-signer", key: { kind: "Ed25519", keyId: "key-1", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, validFrom: "2026-08-26T11:00:00.000Z", refreshAfter: "2026-08-26T12:01:00.000Z", status: "active" }, "2026-08-26T12:00:00.000Z", "platform-issuer") === false,
  },
  {
    pkg: "@getsimpledirect/vinci-device-auth",
    export: "isKeyUsableAt",
    label: "isKeyUsableAt(entry, now, hostile role)",
    call: (fn, hostile) => fn({ schemaVersion: 1, keyId: "key-1", role: "platform-issuer", key: { kind: "Ed25519", keyId: "key-1", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, validFrom: "2026-08-26T11:00:00.000Z", refreshAfter: "2026-08-26T12:01:00.000Z", status: "active" }, "2026-08-26T12:00:00.000Z", hostile),
    control: (fn) =>
      fn({ schemaVersion: 1, keyId: "key-1", role: "platform-issuer", key: { kind: "Ed25519", keyId: "key-1", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, validFrom: "2026-08-26T11:00:00.000Z", refreshAfter: "2026-08-26T12:01:00.000Z", status: "active" }, "2026-08-26T12:00:00.000Z", "platform-issuer") === true
      && fn({ schemaVersion: 1, keyId: "key-1", role: "platform-issuer", key: { kind: "Ed25519", keyId: "key-1", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, validFrom: "2026-08-26T11:00:00.000Z", refreshAfter: "2026-08-26T12:01:00.000Z", status: "active" }, "2026-08-26T12:00:00.000Z", "device-signer") === false,
  },
  {
    pkg: "@getsimpledirect/vinci-device-auth",
    export: "isSnapshotNewer",
    label: "isSnapshotNewer(candidate, currentVersion)",
    call: (fn, hostile) => fn(hostile, 1),
    control: (fn) => fn(2, 1) === true && fn(1, 1) === false && fn(0, 1) === false,
  },
  {
    pkg: "@getsimpledirect/vinci-device-auth",
    export: "isSnapshotNewer",
    label: "isSnapshotNewer(2, currentVersion)",
    call: (fn, hostile) => fn(2, hostile),
    control: (fn) => fn(2, 1) === true && fn(2, 2) === false,
  },
  {
    pkg: "@getsimpledirect/vinci-session-stream",
    export: "frameMatchesBinding",
    label: "frameMatchesBinding(frame, binding)",
    call: (fn, hostile) => fn(hostile, {
      protocolVersion: 1,
      organizationId: null,
      workspaceId: "workspace-1",
      runId: "run-1",
      sessionId: "session-1",
    }),
    control: (fn) => {
      const frame = {
        protocolVersion: 1,
        organizationId: null,
        workspaceId: "workspace-1",
        runId: "run-1",
        sessionId: "session-1",
      };
      return fn(frame, { ...frame }) === true
        && fn(frame, { ...frame, runId: "run-2" }) === false;
    },
  },
  {
    pkg: "@getsimpledirect/vinci-session-stream",
    export: "frameMatchesBinding",
    label: "frameMatchesBinding(validFrame, binding)",
    call: (fn, hostile) => fn({
      protocolVersion: 1,
      organizationId: null,
      workspaceId: "workspace-1",
      runId: "run-1",
      sessionId: "session-1",
    }, hostile),
    control: (fn) => {
      const frame = {
        protocolVersion: 1,
        organizationId: "organization-1",
        workspaceId: "workspace-1",
        runId: "run-1",
        sessionId: "session-1",
      };
      return fn(frame, { ...frame }) === true
        && fn(frame, { ...frame, organizationId: null }) === false;
    },
  },
  {
    pkg: "@getsimpledirect/vinci-worker-capabilities",
    export: "renderableRemoteCommands",
    label: "renderableRemoteCommands(matrix, 'approver')",
    // The guard returns a command list; "granted a yes" means it offered at
    // least one command, so the probe projects the list to that boolean.
    call: (fn, hostile) => fn(hostile, "approver").length > 0,
    control: (fn) =>
      fn({ activityStream: true, questions: true, steering: true, approvals: "native", pause: true, restrictToReadOnly: true, abort: true, filesystemEnforcement: false, networkEnforcement: false, structuredEvidence: false, nativeReceipts: false, safeResume: false, independentVerification: false }, "approver").includes("approve_pending_approval")
      && !fn({ activityStream: true, questions: true, steering: true, approvals: "native", pause: true, restrictToReadOnly: true, abort: true, filesystemEnforcement: false, networkEnforcement: false, structuredEvidence: false, nativeReceipts: false, safeResume: false, independentVerification: false }, "collaborator").includes("approve_pending_approval")
      && fn({ activityStream: true, questions: true, steering: true, approvals: "native", pause: true, restrictToReadOnly: true, abort: true, filesystemEnforcement: false, networkEnforcement: false, structuredEvidence: false, nativeReceipts: false, safeResume: false, independentVerification: false }, "viewer").length === 0,
  },
  {
    pkg: "@getsimpledirect/vinci-worker-capabilities",
    export: "renderableRemoteCommands",
    label: "renderableRemoteCommands(matrix, role)",
    call: (fn, hostile) => fn({ activityStream: true, questions: true, steering: true, approvals: "native", pause: true, restrictToReadOnly: true, abort: true, filesystemEnforcement: false, networkEnforcement: false, structuredEvidence: false, nativeReceipts: false, safeResume: false, independentVerification: false }, hostile).length > 0,
    control: (fn) => fn({ activityStream: true, questions: true, steering: true, approvals: "native", pause: true, restrictToReadOnly: true, abort: true, filesystemEnforcement: false, networkEnforcement: false, structuredEvidence: false, nativeReceipts: false, safeResume: false, independentVerification: false }, "owner").includes("pause") && fn({ activityStream: true, questions: true, steering: true, approvals: "native", pause: true, restrictToReadOnly: true, abort: true, filesystemEnforcement: false, networkEnforcement: false, structuredEvidence: false, nativeReceipts: false, safeResume: false, independentVerification: false }, "viewer").length === 0,
  },
  {
    pkg: "@getsimpledirect/vinci-remote-protocol",
    export: "mayIssue",
    label: "mayIssue(role, 'pause')",
    call: (fn, hostile) => fn(hostile, "pause"),
    control: (fn) => fn("owner", "pause") === true && fn("viewer", "pause") === false,
  },
  {
    pkg: "@getsimpledirect/vinci-remote-protocol",
    export: "mayIssue",
    label: "mayIssue('owner', command)",
    call: (fn, hostile) => fn("owner", hostile),
    control: (fn) => fn("owner", "abort") === true && fn("collaborator", "abort") === false,
  },
  {
    pkg: "@getsimpledirect/vinci-remote-protocol",
    export: "assertedRoleMatchesGrant",
    label: "assertedRoleMatchesGrant(assertedRole, 'owner')",
    call: (fn, hostile) => fn(hostile, "owner"),
    control: (fn) => fn("owner", "owner") === true && fn("approver", "owner") === false,
  },
  {
    pkg: "@getsimpledirect/vinci-remote-protocol",
    export: "assertedRoleMatchesGrant",
    label: "assertedRoleMatchesGrant('owner', grantedRole)",
    call: (fn, hostile) => fn("owner", hostile),
    control: (fn) => fn("owner", "owner") === true && fn("owner", "viewer") === false,
  },
  {
    pkg: "@getsimpledirect/vinci-remote-protocol",
    export: "validateAuthorityCommandEnvelope",
    label: "validateAuthorityCommandEnvelope(envelope).ok",
    call: (fn, hostile) => fn(hostile, "2026-08-26T12:05:00.000Z").ok,
    control: (fn) => fn({
      schemaVersion: 1,
      commandId: "cmd-1",
      binding: { protocolVersion: 1, organizationId: null, workspaceId: "ws-1", runId: "run-1", sessionId: "sess-1" },
      command: "pause",
      params: {},
      assertedRole: "owner",
      sequence: 0,
      idempotencyKey: "idem-1",
      issuedAt: "2026-08-26T12:00:00.000Z",
      expiresAt: "2026-08-26T12:10:00.000Z",
      signerKeyId: "key-1",
      signature: { alg: "Ed25519", value: "AQID" },
    }, "2026-08-26T12:05:00.000Z").ok === true,
  },
  {
    pkg: "@getsimpledirect/vinci-remote-protocol",
    export: "bindingRefMatches",
    label: "bindingRefMatches(ref, binding)",
    call: (fn, hostile) => fn(hostile, { protocolVersion: 1, schemaVersion: 1, organizationId: null, workspaceId: "ws-1", runId: "run-1", sessionId: "sess-1", hostDeviceId: "dev-1", policyId: "pol-1", policyVersion: 1, retentionClass: "zdr_0d" }),
    control: (fn) => fn(
      { protocolVersion: 1, organizationId: null, workspaceId: "ws-1", runId: "run-1", sessionId: "sess-1" },
      { protocolVersion: 1, schemaVersion: 1, organizationId: null, workspaceId: "ws-1", runId: "run-1", sessionId: "sess-1", hostDeviceId: "dev-1", policyId: "pol-1", policyVersion: 1, retentionClass: "zdr_0d" },
    ) === true,
  },
  {
    pkg: "@getsimpledirect/vinci-remote-protocol",
    export: "bindingRefMatches",
    label: "bindingRefMatches(validRef, binding)",
    call: (fn, hostile) => fn({ protocolVersion: 1, organizationId: null, workspaceId: "ws-1", runId: "run-1", sessionId: "sess-1" }, hostile),
    control: (fn) => fn(
      { protocolVersion: 1, organizationId: null, workspaceId: "ws-1", runId: "run-1", sessionId: "sess-1" },
      { protocolVersion: 1, schemaVersion: 1, organizationId: null, workspaceId: "ws-1", runId: "run-1", sessionId: "sess-1", hostDeviceId: "dev-1", policyId: "pol-1", policyVersion: 1, retentionClass: "zdr_0d" },
    ) === true,
  },
  {
    pkg: "@getsimpledirect/vinci-evidence",
    export: "statusIsSupportedBy",
    label: "statusIsSupportedBy('VERIFIED_PASS', results)",
    call: (fn, hostile) => fn("VERIFIED_PASS", hostile),
    control: (fn) =>
      fn("VERIFIED_PASS", [{ status: "supported" }]) === true
      && fn("VERIFIED_PASS", [{ status: "unknown" }]) === false
      && fn("VERIFIED_PASS", []) === false,
  },
  {
    pkg: "@getsimpledirect/vinci-contracts",
    export: "actorFieldsAreConsistent",
    label: "actorFieldsAreConsistent(actor)",
    call: (fn, hostile) => fn(hostile),
    control: (fn) =>
      fn({ kind: "worker", workerId: "w" }) === true
      && fn({ kind: "verifier", verifierId: "v", independent: true }) === true
      && fn({ kind: "verifier", verifierId: "v", workerId: "w" }) === false
      && fn({ kind: "worker", workerId: "w", independent: true }) === false,
  },
  {
    pkg: "@getsimpledirect/vinci-approvals",
    export: "isGrantStrictlyNarrower",
    label: "isGrantStrictlyNarrower(a, b)",
    call: (fn, hostile) => fn(hostile, hostile),
    control: (fn) =>
      fn({ kind: "deny" }, { kind: "allow-automatically" }) === true
      && fn({ kind: "allow-automatically" }, { kind: "deny" }) === false,
  },
  {
    pkg: "@getsimpledirect/vinci-approvals",
    export: "isDecisionEffective",
    label: "isDecisionEffective(decision)",
    call: (fn, hostile) => fn(hostile),
    control: (fn) =>
      fn({ deliveryState: { kind: "accepted-by-governor" } }) === true
      && fn({ deliveryState: { kind: "queued-locally" } }) === false,
  },
  {
    pkg: "@getsimpledirect/vinci-approvals",
    export: "canAdvanceDelivery",
    label: "canAdvanceDelivery(a, b)",
    call: (fn, hostile) => fn(hostile, hostile),
    control: (fn) =>
      fn("queued-locally", "delivered") === true
      && fn("acted-upon-by-worker", "queued-locally") === false,
  },
  {
    pkg: "@getsimpledirect/vinci-approvals",
    export: "isEffectiveDeliveryState",
    label: "isEffectiveDeliveryState(state)",
    call: (fn, hostile) => fn(hostile),
    control: (fn) =>
      fn({ kind: "accepted-by-governor" }) === true
      && fn({ kind: "queued-locally" }) === false,
  },
  {
    pkg: "@getsimpledirect/vinci-contracts",
    export: "isOrganizationWorkspace",
    label: "isOrganizationWorkspace(value)",
    call: (fn, hostile) => fn(hostile),
    control: (fn) =>
      fn({ kind: "organization", organizationId: "o", workspaceId: "w" }) === true
      && fn({ kind: "personal", workspaceId: "w" }) === false,
  },
  {
    pkg: "@getsimpledirect/vinci-contracts",
    export: "terminalStateOfVerification",
    label: "terminalStateOfVerification(value)",
    call: (fn, hostile) => fn(hostile),
    control: (fn) =>
      fn({ kind: "not-issued", reason: "FAILED" }) === undefined
      && fn({ kind: "issued", staled: false, status: "VERIFIED_PASS" }) !== undefined,
  },
  {
    // The only path to the Worker's COMPLETED. A hostile triple must reach
    // null (still live / not a triple) or UNVERIFIED, never COMPLETED — and
    // never throw. A yes here is any non-null return, which is deliberately
    // strict: UNVERIFIED for a hostile object would also count as a yes, so
    // the guard must return null for anything that is not a real triple.
    pkg: "@getsimpledirect/vinci-contracts",
    export: "deriveLegacyTerminal",
    label: "deriveLegacyTerminal(triple)",
    call: (fn, hostile) => fn(hostile),
    control: (fn) =>
      fn({ execution: "ARTIFACT_PRODUCED", assurance: "VERIFIED_PASS", promotion: "APPLIED", evidence: "VERIFIED" }) === "COMPLETED"
      && fn({ execution: "ARTIFACT_PRODUCED", assurance: "SELF_CHECKED", promotion: "APPLIED", evidence: "VERIFIED" }) === "UNVERIFIED"
      && fn({ execution: "RUNNING", assurance: "NOT_EVALUATED", promotion: "NOT_ELIGIBLE", evidence: "NOT_ATTEMPTED" }) === null,
  },
  {
    pkg: "@getsimpledirect/vinci-contracts",
    export: "isOutcomeTriple",
    label: "isOutcomeTriple(value)",
    call: (fn, hostile) => fn(hostile),
    control: (fn) =>
      fn({ execution: "RUNNING", assurance: "NOT_EVALUATED", promotion: "NOT_ELIGIBLE", evidence: "NOT_ATTEMPTED" }) === true
      && fn({ execution: "RUNNING", assurance: "RUNNING", promotion: "NOT_ELIGIBLE", evidence: "NOT_ATTEMPTED" }) === false,
  },
  {
    pkg: "@getsimpledirect/vinci-contracts",
    export: "canTransition",
    label: "canTransition(dimension, 'PENDING', 'LEASED')",
    call: (fn, hostile) => fn(hostile, "PENDING", "LEASED"),
    control: (fn) => fn("execution", "PENDING", "LEASED") === true && fn("execution", "PENDING", "RUNNING") === false,
  },
  {
    pkg: "@getsimpledirect/vinci-contracts",
    export: "canTransition",
    label: "canTransition('execution', from, 'LEASED')",
    call: (fn, hostile) => fn("execution", hostile, "LEASED"),
    control: (fn) => fn("execution", "PENDING", "LEASED") === true && fn("execution", "RUNNING", "LEASED") === false,
  },
  {
    pkg: "@getsimpledirect/vinci-contracts",
    export: "canTransition",
    label: "canTransition('execution', 'PENDING', to)",
    call: (fn, hostile) => fn("execution", "PENDING", hostile),
    control: (fn) => fn("execution", "PENDING", "LEASED") === true && fn("execution", "PENDING", "FAILED") === false,
  },
  {
    pkg: "@getsimpledirect/vinci-work-orders",
    export: "pathRootCovers",
    label: "pathRootCovers(hostileParent, child)",
    call: (fn, hostile) => fn(hostile, { root: "src/x.ts", kind: "file" }),
    control: (fn) =>
      fn({ root: "src/", kind: "directory" }, { root: "src/x.ts", kind: "file" }) === true
      && fn({ root: "src/x.ts", kind: "file" }, { root: "src/", kind: "directory" }) === false
      // A hand-built empty root would cover everything through startsWith("").
      && fn({ root: "", kind: "directory" }, { root: "src/x.ts", kind: "file" }) === false,
  },
  {
    pkg: "@getsimpledirect/vinci-work-orders",
    export: "pathRootCovers",
    label: "pathRootCovers(parent, hostileChild)",
    call: (fn, hostile) => fn({ root: "src/", kind: "directory" }, hostile),
    control: (fn) =>
      fn({ root: "src/", kind: "directory" }, { root: "src/", kind: "directory" }) === true
      && fn({ root: "src/", kind: "directory" }, { root: "docs/", kind: "directory" }) === false,
  },
  {
    pkg: "@getsimpledirect/vinci-work-orders",
    export: "mayInterrupt",
    label: "mayInterrupt(budget, spend)",
    call: (fn, hostile) => fn(hostile, { workOrderId: "wo-1", interruptionsUsed: 0, decisionsUsed: 0 }),
    control: (fn) =>
      fn({ interruptions: 2, decisions: 2, onExhaustion: "block" },
         { workOrderId: "wo-1", interruptionsUsed: 0, decisionsUsed: 0 }) === true
      && fn({ interruptions: 2, decisions: 2, onExhaustion: "block" },
            { workOrderId: "wo-1", interruptionsUsed: 2, decisionsUsed: 0 }) === false,
  },
  {
    pkg: "@getsimpledirect/vinci-work-orders",
    export: "mayInterrupt",
    label: "mayInterrupt(budget, hostileSpend)",
    call: (fn, hostile) => fn({ interruptions: 2, decisions: 2, onExhaustion: "block" }, hostile),
    control: (fn) =>
      fn({ interruptions: 1, decisions: 1, onExhaustion: "escalate" },
         { workOrderId: "wo-1", interruptionsUsed: 0, decisionsUsed: 0 }) === true
      && fn({ interruptions: 1, decisions: 1, onExhaustion: "escalate" },
            { workOrderId: "wo-1", interruptionsUsed: 5, decisionsUsed: 0 }) === false,
  },
  {
    pkg: "@getsimpledirect/vinci-work-orders",
    export: "mayRequireDecision",
    label: "mayRequireDecision(budget, spend)",
    call: (fn, hostile) => fn(hostile, { workOrderId: "wo-1", interruptionsUsed: 0, decisionsUsed: 0 }),
    control: (fn) =>
      fn({ interruptions: 2, decisions: 2, onExhaustion: "block" },
         { workOrderId: "wo-1", interruptionsUsed: 0, decisionsUsed: 0 }) === true
      && fn({ interruptions: 2, decisions: 2, onExhaustion: "block" },
            { workOrderId: "wo-1", interruptionsUsed: 0, decisionsUsed: 2 }) === false,
  },
  {
    pkg: "@getsimpledirect/vinci-work-orders",
    export: "mayRequireDecision",
    label: "mayRequireDecision(budget, hostileSpend)",
    call: (fn, hostile) => fn({ interruptions: 2, decisions: 2, onExhaustion: "block" }, hostile),
    control: (fn) =>
      fn({ interruptions: 1, decisions: 1, onExhaustion: "block" },
         { workOrderId: "wo-1", interruptionsUsed: 0, decisionsUsed: 0 }) === true
      && fn({ interruptions: 1, decisions: 1, onExhaustion: "block" },
            { workOrderId: "wo-1", interruptionsUsed: 0, decisionsUsed: 9 }) === false,
  },
  {
    pkg: "@getsimpledirect/vinci-contracts",
    export: "plainActor",
    label: "plainActor(actor)",
    call: (fn, hostile) => fn(hostile),
    // A snapshot function answers with null or an object, never `true`, so the
    // never-true probe alone would be satisfied by a function that always
    // returned null. The control pins both directions.
    control: (fn) =>
      fn({ kind: "worker", workerId: "w" })?.kind === "worker"
      && fn({ kind: "verifier", verifierId: "v", independent: true })?.independent === true
      && fn({ kind: "user", userId: "u" })?.kind === "user"
      && fn({ kind: "policy", policyId: "p", policyVersion: 3 })?.kind === "policy"
      // Foreign field, and the missing-identity cases: a worker with no
      // workerId and an anonymous verifier asserting its own independence.
      && fn({ kind: "verifier", verifierId: "v", workerId: "w" }) === null
      && fn({ kind: "worker" }) === null
      && fn({ kind: "verifier", independent: true }) === null
      && fn({ kind: "worker", workerId: "   " }) === null
      && fn({ kind: "verifier", verifierId: "v", independent: "yes" }) === null,
  },
  {
    pkg: "@getsimpledirect/vinci-evidence",
    export: "countsAgainstSubmittedWork",
    label: "countsAgainstSubmittedWork(outcome)",
    call: (fn, hostile) => fn(hostile),
    control: (fn) =>
      fn({ outcome: "contradicts", failureOwner: "submitted_work" }) === true
      && fn({ outcome: "invalid", failureOwner: "submitted_work" }) === true
      && fn({ outcome: "contradicts", failureOwner: "vinci_harness" }) === false
      && fn({ outcome: "supports" }) === false,
  },
  {
    pkg: "@getsimpledirect/vinci-evidence",
    export: "isProvenanceConsistent",
    label: "isProvenanceConsistent(provenance, actor)",
    call: (fn, hostile) => fn(hostile, { kind: "worker", workerId: "w" }),
    control: (fn) =>
      fn("worker_provided", { kind: "worker", workerId: "w" }) === true
      && fn("worker_provided", { kind: "user", userId: "u" }) === false,
  },
  {
    pkg: "@getsimpledirect/vinci-evidence",
    export: "isProvenanceConsistent",
    label: "isProvenanceConsistent('worker_provided', actor)",
    call: (fn, hostile) => fn("worker_provided", hostile),
    control: (fn) =>
      fn("worker_provided", { kind: "worker", workerId: "w" }) === true
      && fn("independent_verifier", { kind: "verifier", verifierId: "v", independent: true }) === true
      // Identity-less actors must not satisfy any provenance.
      && fn("worker_provided", { kind: "worker" }) === false
      && fn("independent_verifier", { kind: "verifier", independent: true }) === false,
  },
  {
    pkg: "@getsimpledirect/vinci-evidence",
    export: "statusIsSupportedBy",
    label: "statusIsSupportedBy(status, [supported])",
    call: (fn, hostile) => fn(hostile, [{ status: "supported" }]),
    control: (fn) =>
      fn("VERIFIED_PASS", [{ status: "supported" }]) === true
      && fn("BLOCKED", [{ status: "supported" }]) === true,
  },
  {
    pkg: "@getsimpledirect/vinci-model-classes",
    export: "matchEndpointToRole",
    label: "matchEndpointToRole(hostile role, endpoint, now)",
    call: (fn, hostile) => fn(hostile, {
      schemaVersion: 1,
      endpointId: "test-ep",
      capabilityProfile: { capabilities: ["text"], contextLimit: 128000, toolSupport: true },
      declaredCapabilities: ["structured_tool_use"],
      credentials: { source: { kind: "managed-credential", credentialId: "test-c" } },
      inferenceIsExternal: { kind: "known", value: true },
      approvedForProtectedData: { kind: "known", value: true },
      rights: {
        trainingAllowed: { kind: "known", value: true },
        evaluationAllowed: { kind: "known", value: true },
        redistributionAllowed: { kind: "known", value: false },
        outputRetainedByProvider: { kind: "known", value: false },
        policySnapshotDigest: { kind: "known", value: "test-digest" }
      },
      validFrom: "2026-08-01T00:00:00.000Z",
      expiresAt: "2027-08-01T00:00:00.000Z",
      sourceClass: "vinci_pretrained",
      weightsDigest: { kind: "known", value: "test-weights" },
      tokenizerDigest: { kind: "known", value: "test-tok" },
      architectureDigest: { kind: "known", value: "test-arch" },
      servingImageDigest: { kind: "known", value: "test-image" },
      quantizationDigest: { kind: "unknown" }
    }, "2026-08-26T12:00:00.000Z").verdict === "eligible",
    control: (fn) => {
      const validRole = {
        schemaVersion: 1,
        roleId: "test-role",
        taskClass: "test",
        requiredCapabilities: ["structured_tool_use"],
        requiredHarnessCapabilities: [],
        minimumContextTokens: 64000,
        riskClass: "low",
        dataPolicy: {
          externalProviderAllowed: true,
          outputRetentionAllowed: false,
          processesProtectedData: false
        },
        qualityPolicy: { minimumVerifiedSuccessRate: 0.9, maximumFalseClaimRate: 0.02 },
        economicPolicy: { maximumCostPerVerifiedSuccessUsd: 3.5, maximumP95WallSeconds: 120 },
        fallbackRoleIds: []
      };
      const ep = {
        schemaVersion: 1,
        endpointId: "test-ep",
        capabilityProfile: { capabilities: ["text"], contextLimit: 128000, toolSupport: true },
        declaredCapabilities: ["structured_tool_use"],
        credentials: { source: { kind: "managed-credential", credentialId: "test-c" } },
        inferenceIsExternal: { kind: "known", value: true },
        approvedForProtectedData: { kind: "known", value: true },
        rights: {
          trainingAllowed: { kind: "known", value: true },
          evaluationAllowed: { kind: "known", value: true },
          redistributionAllowed: { kind: "known", value: false },
          outputRetainedByProvider: { kind: "known", value: false },
          policySnapshotDigest: { kind: "known", value: "test-digest" }
        },
        validFrom: "2026-08-01T00:00:00.000Z",
        expiresAt: "2027-08-01T00:00:00.000Z",
        sourceClass: "vinci_pretrained",
        weightsDigest: { kind: "known", value: "test-weights" },
        tokenizerDigest: { kind: "known", value: "test-tok" },
        architectureDigest: { kind: "known", value: "test-arch" },
        servingImageDigest: { kind: "known", value: "test-image" },
        quantizationDigest: { kind: "unknown" }
      };
      return fn(validRole, ep, "2026-08-26T12:00:00.000Z").verdict === "eligible"
        && fn({ ...validRole, requiredCapabilities: ["vision"] }, ep, "2026-08-26T12:00:00.000Z").verdict === "ineligible"
        && fn({ ...validRole, requiredCapabilities: ["unknown-capability"] }, ep, "2026-08-26T12:00:00.000Z").verdict === "unevaluable"
        && fn({ ...validRole, requiredCapabilities: "invalid" }, ep, "2026-08-26T12:00:00.000Z").verdict === "unevaluable";
    }
  },
  {
    pkg: "@getsimpledirect/vinci-model-classes",
    export: "matchEndpointToRole",
    label: "matchEndpointToRole(role, hostile endpoint, now)",
    call: (fn, hostile) => fn({
      schemaVersion: 1,
      roleId: "test-role",
      taskClass: "test",
      requiredCapabilities: ["structured_tool_use"],
        requiredHarnessCapabilities: [],
      minimumContextTokens: 64000,
      riskClass: "low",
      dataPolicy: {
        externalProviderAllowed: true,
        outputRetentionAllowed: false,
        processesProtectedData: false
      },
      qualityPolicy: { minimumVerifiedSuccessRate: 0.9, maximumFalseClaimRate: 0.02 },
      economicPolicy: { maximumCostPerVerifiedSuccessUsd: 3.5, maximumP95WallSeconds: 120 },
      fallbackRoleIds: []
    }, hostile, "2026-08-26T12:00:00.000Z").verdict === "eligible",
    control: (fn) => {
      const validRole = {
        schemaVersion: 1,
        roleId: "test-role",
        taskClass: "test",
        requiredCapabilities: ["structured_tool_use"],
        requiredHarnessCapabilities: [],
        minimumContextTokens: 64000,
        riskClass: "low",
        dataPolicy: {
          externalProviderAllowed: true,
          outputRetentionAllowed: false,
          processesProtectedData: false
        },
        qualityPolicy: { minimumVerifiedSuccessRate: 0.9, maximumFalseClaimRate: 0.02 },
        economicPolicy: { maximumCostPerVerifiedSuccessUsd: 3.5, maximumP95WallSeconds: 120 },
        fallbackRoleIds: []
      };
      const ep = {
        schemaVersion: 1,
        endpointId: "test-ep",
        capabilityProfile: { capabilities: ["text"], contextLimit: 128000, toolSupport: true },
        declaredCapabilities: ["structured_tool_use"],
        credentials: { source: { kind: "managed-credential", credentialId: "test-c" } },
        inferenceIsExternal: { kind: "known", value: true },
        approvedForProtectedData: { kind: "known", value: true },
        rights: {
          trainingAllowed: { kind: "known", value: true },
          evaluationAllowed: { kind: "known", value: true },
          redistributionAllowed: { kind: "known", value: false },
          outputRetainedByProvider: { kind: "known", value: false },
          policySnapshotDigest: { kind: "known", value: "test-digest" }
        },
        validFrom: "2026-08-01T00:00:00.000Z",
        expiresAt: "2027-08-01T00:00:00.000Z",
        sourceClass: "vinci_pretrained",
        weightsDigest: { kind: "known", value: "test-weights" },
        tokenizerDigest: { kind: "known", value: "test-tok" },
        architectureDigest: { kind: "known", value: "test-arch" },
        servingImageDigest: { kind: "known", value: "test-image" },
        quantizationDigest: { kind: "unknown" }
      };
      return fn(validRole, ep, "2026-08-26T12:00:00.000Z").verdict === "eligible"
        && fn(validRole, { ...ep, declaredCapabilities: [] }, "2026-08-26T12:00:00.000Z").verdict === "ineligible"
        && fn(validRole, { ...ep, declaredCapabilities: "invalid" }, "2026-08-26T12:00:00.000Z").verdict === "unevaluable";
    }
  },

  { pkg: "@getsimpledirect/vinci-model-classes", export: "selectForRole", label: "selectForRole(hostile role, valid endpoints, now)", call: (fn, hostile) => fn(hostile, [], "2026-08-26T12:00:00.000Z").eligible.length > 0, control: (fn) => fn({ schemaVersion: 1, roleId: "r", taskClass: "t", requiredCapabilities: [],
        requiredHarnessCapabilities: [],
        minimumContextTokens: 1000, riskClass: "low", dataPolicy: { externalProviderAllowed: true, outputRetentionAllowed: true, processesProtectedData: false }, qualityPolicy: { minimumVerifiedSuccessRate: 0.5, maximumFalseClaimRate: 0.1 }, economicPolicy: { maximumCostPerVerifiedSuccessUsd: 1.0, maximumP95WallSeconds: 10 }, fallbackRoleIds: [] }, [{ schemaVersion: 1, endpointId: "e", capabilityProfile: { capabilities: ["text"], contextLimit: 200000, toolSupport: true }, declaredCapabilities: [], credentials: { source: { kind: "managed-credential", credentialId: "c" } }, inferenceIsExternal: { kind: "known", value: false }, approvedForProtectedData: { kind: "known", value: true }, rights: { trainingAllowed: { kind: "known", value: true }, evaluationAllowed: { kind: "known", value: true }, redistributionAllowed: { kind: "known", value: true }, outputRetainedByProvider: { kind: "known", value: false }, policySnapshotDigest: { kind: "known", value: "d" } }, validFrom: "2020-01-01T00:00:00.000Z", expiresAt: null, sourceClass: "vinci_pretrained", weightsDigest: { kind: "known", value: "w" }, tokenizerDigest: { kind: "known", value: "t" }, architectureDigest: { kind: "known", value: "a" }, servingImageDigest: { kind: "known", value: "i" }, quantizationDigest: { kind: "unknown" } }], "2026-08-26T12:00:00.000Z").eligible.length > 0 && fn({ schemaVersion: 1, roleId: "r", taskClass: "t", requiredCapabilities: [],
        requiredHarnessCapabilities: [],
        minimumContextTokens: 1000, riskClass: "low", dataPolicy: { externalProviderAllowed: true, outputRetentionAllowed: false, processesProtectedData: false }, qualityPolicy: { minimumVerifiedSuccessRate: 0.5, maximumFalseClaimRate: 0.1 }, economicPolicy: { maximumCostPerVerifiedSuccessUsd: 1.0, maximumP95WallSeconds: 10 }, fallbackRoleIds: [] }, [{ schemaVersion: 1, endpointId: "e", capabilityProfile: { capabilities: ["text"], contextLimit: 200000, toolSupport: true }, declaredCapabilities: [], credentials: { source: { kind: "managed-credential", credentialId: "c" } }, inferenceIsExternal: { kind: "known", value: false }, approvedForProtectedData: { kind: "known", value: true }, rights: { trainingAllowed: { kind: "known", value: true }, evaluationAllowed: { kind: "known", value: true }, redistributionAllowed: { kind: "known", value: true }, outputRetainedByProvider: { kind: "known", value: true }, policySnapshotDigest: { kind: "known", value: "d" } }, validFrom: "2020-01-01T00:00:00.000Z", expiresAt: null, sourceClass: "vinci_pretrained", weightsDigest: "w", tokenizerDigest: "t", architectureDigest: "a", servingImageDigest: { kind: "known", value: "i" }, quantizationDigest: { kind: "unknown" } }], "2026-08-26T12:00:00.000Z").eligible.length === 0 && fn({ schemaVersion: 1, roleId: "r", taskClass: "t", requiredCapabilities: [],
        requiredHarnessCapabilities: [],
        minimumContextTokens: 1000, riskClass: "low", dataPolicy: { externalProviderAllowed: true, outputRetentionAllowed: false, processesProtectedData: false }, qualityPolicy: { minimumVerifiedSuccessRate: 0.5, maximumFalseClaimRate: 0.1 }, economicPolicy: { maximumCostPerVerifiedSuccessUsd: 1.0, maximumP95WallSeconds: 10 }, fallbackRoleIds: [] }, [{ schemaVersion: 1, endpointId: "e", capabilityProfile: { capabilities: ["text"], contextLimit: 200000, toolSupport: true }, declaredCapabilities: [], credentials: { source: { kind: "managed-credential", credentialId: "c" } }, inferenceIsExternal: { kind: "known", value: false }, approvedForProtectedData: { kind: "known", value: true }, rights: { trainingAllowed: { kind: "known", value: true }, evaluationAllowed: { kind: "known", value: true }, redistributionAllowed: { kind: "known", value: true }, outputRetainedByProvider: { kind: "known", value: true }, policySnapshotDigest: { kind: "known", value: "d" } }, validFrom: "2020-01-01T00:00:00.000Z", expiresAt: null, sourceClass: "vinci_pretrained", weightsDigest: "w", tokenizerDigest: "t", architectureDigest: "a", servingImageDigest: { kind: "known", value: "i" }, quantizationDigest: { kind: "unknown" } }], "2026-08-26T12:00:00.000Z").ineligible.length === 1 },
  { pkg: "@getsimpledirect/vinci-model-classes", export: "selectForRole", label: "selectForRole(valid role, hostile endpoints, now)", call: (fn, hostile) => fn({ schemaVersion: 1, roleId: "r", taskClass: "t", requiredCapabilities: [],
        requiredHarnessCapabilities: [],
        minimumContextTokens: 1000, riskClass: "low", dataPolicy: { externalProviderAllowed: true, outputRetentionAllowed: false, processesProtectedData: false }, qualityPolicy: { minimumVerifiedSuccessRate: 0.5, maximumFalseClaimRate: 0.1 }, economicPolicy: { maximumCostPerVerifiedSuccessUsd: 1.0, maximumP95WallSeconds: 10 }, fallbackRoleIds: [] }, hostile, "2026-08-26T12:00:00.000Z").eligible.length > 0, control: (fn) => fn({ schemaVersion: 1, roleId: "r", taskClass: "t", requiredCapabilities: [],
        requiredHarnessCapabilities: [],
        minimumContextTokens: 1000, riskClass: "low", dataPolicy: { externalProviderAllowed: true, outputRetentionAllowed: true, processesProtectedData: false }, qualityPolicy: { minimumVerifiedSuccessRate: 0.5, maximumFalseClaimRate: 0.1 }, economicPolicy: { maximumCostPerVerifiedSuccessUsd: 1.0, maximumP95WallSeconds: 10 }, fallbackRoleIds: [] }, [{ schemaVersion: 1, endpointId: "e", capabilityProfile: { capabilities: ["text"], contextLimit: 200000, toolSupport: true }, declaredCapabilities: [], credentials: { source: { kind: "managed-credential", credentialId: "c" } }, inferenceIsExternal: { kind: "known", value: false }, approvedForProtectedData: { kind: "known", value: true }, rights: { trainingAllowed: { kind: "known", value: true }, evaluationAllowed: { kind: "known", value: true }, redistributionAllowed: { kind: "known", value: true }, outputRetainedByProvider: { kind: "known", value: false }, policySnapshotDigest: { kind: "known", value: "d" } }, validFrom: "2020-01-01T00:00:00.000Z", expiresAt: null, sourceClass: "vinci_pretrained", weightsDigest: { kind: "known", value: "w" }, tokenizerDigest: { kind: "known", value: "t" }, architectureDigest: { kind: "known", value: "a" }, servingImageDigest: { kind: "known", value: "i" }, quantizationDigest: { kind: "unknown" } }], "2026-08-26T12:00:00.000Z").eligible.length > 0 && fn({ schemaVersion: 1, roleId: "r", taskClass: "t", requiredCapabilities: [],
        requiredHarnessCapabilities: [],
        minimumContextTokens: 1000, riskClass: "low", dataPolicy: { externalProviderAllowed: true, outputRetentionAllowed: false, processesProtectedData: false }, qualityPolicy: { minimumVerifiedSuccessRate: 0.5, maximumFalseClaimRate: 0.1 }, economicPolicy: { maximumCostPerVerifiedSuccessUsd: 1.0, maximumP95WallSeconds: 10 }, fallbackRoleIds: [] }, [{ schemaVersion: 1, endpointId: "e", capabilityProfile: { capabilities: ["text"], contextLimit: 200000, toolSupport: true }, declaredCapabilities: [], credentials: { source: { kind: "managed-credential", credentialId: "c" } }, inferenceIsExternal: { kind: "known", value: false }, approvedForProtectedData: { kind: "known", value: true }, rights: { trainingAllowed: { kind: "known", value: true }, evaluationAllowed: { kind: "known", value: true }, redistributionAllowed: { kind: "known", value: true }, outputRetainedByProvider: { kind: "known", value: true }, policySnapshotDigest: { kind: "known", value: "d" } }, validFrom: "2020-01-01T00:00:00.000Z", expiresAt: null, sourceClass: "vinci_pretrained", weightsDigest: "w", tokenizerDigest: "t", architectureDigest: "a", servingImageDigest: { kind: "known", value: "i" }, quantizationDigest: { kind: "unknown" } }], "2026-08-26T12:00:00.000Z").eligible.length === 0 && fn({ schemaVersion: 1, roleId: "r", taskClass: "t", requiredCapabilities: [],
        requiredHarnessCapabilities: [],
        minimumContextTokens: 1000, riskClass: "low", dataPolicy: { externalProviderAllowed: true, outputRetentionAllowed: false, processesProtectedData: false }, qualityPolicy: { minimumVerifiedSuccessRate: 0.5, maximumFalseClaimRate: 0.1 }, economicPolicy: { maximumCostPerVerifiedSuccessUsd: 1.0, maximumP95WallSeconds: 10 }, fallbackRoleIds: [] }, [{ schemaVersion: 1, endpointId: "e", capabilityProfile: { capabilities: ["text"], contextLimit: 200000, toolSupport: true }, declaredCapabilities: [], credentials: { source: { kind: "managed-credential", credentialId: "c" } }, inferenceIsExternal: { kind: "known", value: false }, approvedForProtectedData: { kind: "known", value: true }, rights: { trainingAllowed: { kind: "known", value: true }, evaluationAllowed: { kind: "known", value: true }, redistributionAllowed: { kind: "known", value: true }, outputRetainedByProvider: { kind: "known", value: true }, policySnapshotDigest: { kind: "known", value: "d" } }, validFrom: "2020-01-01T00:00:00.000Z", expiresAt: null, sourceClass: "vinci_pretrained", weightsDigest: "w", tokenizerDigest: "t", architectureDigest: "a", servingImageDigest: { kind: "known", value: "i" }, quantizationDigest: { kind: "unknown" } }], "2026-08-26T12:00:00.000Z").ineligible.length === 1 },
  { pkg: "@getsimpledirect/vinci-model-classes", export: "violatesIndependence", label: "violatesIndependence(hostile producer, valid reviewer)", call: (fn, hostile) => fn(hostile, { schemaVersion: 1, endpointId: "v", capabilityProfile: { capabilities: ["text"], contextLimit: 1000, toolSupport: false }, declaredCapabilities: [], credentials: { source: { kind: "managed-credential", credentialId: "c" } }, inferenceIsExternal: { kind: "known", value: false }, approvedForProtectedData: { kind: "known", value: false }, rights: { trainingAllowed: { kind: "known", value: false }, evaluationAllowed: { kind: "known", value: false }, redistributionAllowed: { kind: "known", value: false }, outputRetainedByProvider: { kind: "known", value: false }, policySnapshotDigest: { kind: "known", value: "d" } }, validFrom: "2026-01-01T00:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z", sourceClass: "vinci_pretrained", serving: { kind: "vinci_hosted" }, weightsDigest: { kind: "known", value: "w" }, tokenizerDigest: { kind: "known", value: "t" }, architectureDigest: { kind: "known", value: "a" }, servingImageDigest: { kind: "known", value: "i" }, quantizationDigest: { kind: "unknown" } }) === false, control: (fn) => fn({ schemaVersion: 1, endpointId: "a", capabilityProfile: { capabilities: ["text"], contextLimit: 1000, toolSupport: false }, declaredCapabilities: [], credentials: { source: { kind: "managed-credential", credentialId: "c" } }, inferenceIsExternal: { kind: "known", value: false }, approvedForProtectedData: { kind: "known", value: false }, rights: { trainingAllowed: { kind: "known", value: false }, evaluationAllowed: { kind: "known", value: false }, redistributionAllowed: { kind: "known", value: false }, outputRetainedByProvider: { kind: "known", value: false }, policySnapshotDigest: { kind: "known", value: "d" } }, validFrom: "2026-01-01T00:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z", sourceClass: "vinci_pretrained", serving: { kind: "vinci_hosted" }, weightsDigest: { kind: "known", value: "w" }, tokenizerDigest: { kind: "known", value: "ta" }, architectureDigest: { kind: "known", value: "aa" }, servingImageDigest: { kind: "known", value: "ia" }, quantizationDigest: { kind: "unknown" } }, { schemaVersion: 1, endpointId: "b", capabilityProfile: { capabilities: ["text"], contextLimit: 1000, toolSupport: false }, declaredCapabilities: [], credentials: { source: { kind: "managed-credential", credentialId: "c" } }, inferenceIsExternal: { kind: "known", value: false }, approvedForProtectedData: { kind: "known", value: false }, rights: { trainingAllowed: { kind: "known", value: false }, evaluationAllowed: { kind: "known", value: false }, redistributionAllowed: { kind: "known", value: false }, outputRetainedByProvider: { kind: "known", value: false }, policySnapshotDigest: { kind: "known", value: "d" } }, validFrom: "2026-01-01T00:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z", sourceClass: "vinci_pretrained", serving: { kind: "vinci_hosted" }, weightsDigest: { kind: "known", value: "wb" }, tokenizerDigest: { kind: "known", value: "ta" }, architectureDigest: { kind: "known", value: "aa" }, servingImageDigest: { kind: "known", value: "ia" }, quantizationDigest: { kind: "unknown" } }) === false },
  { pkg: "@getsimpledirect/vinci-model-classes", export: "violatesIndependence", label: "violatesIndependence(valid producer, hostile reviewer)", call: (fn, hostile) => fn({ schemaVersion: 1, endpointId: "p", capabilityProfile: { capabilities: ["text"], contextLimit: 1000, toolSupport: false }, declaredCapabilities: [], credentials: { source: { kind: "managed-credential", credentialId: "c" } }, inferenceIsExternal: { kind: "known", value: false }, approvedForProtectedData: { kind: "known", value: false }, rights: { trainingAllowed: { kind: "known", value: false }, evaluationAllowed: { kind: "known", value: false }, redistributionAllowed: { kind: "known", value: false }, outputRetainedByProvider: { kind: "known", value: false }, policySnapshotDigest: { kind: "known", value: "d" } }, validFrom: "2026-01-01T00:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z", sourceClass: "vinci_pretrained", serving: { kind: "vinci_hosted" }, weightsDigest: { kind: "known", value: "w" }, tokenizerDigest: { kind: "known", value: "t" }, architectureDigest: { kind: "known", value: "a" }, servingImageDigest: { kind: "known", value: "i" }, quantizationDigest: { kind: "unknown" } }, hostile) === false, control: (fn) => fn({ schemaVersion: 1, endpointId: "p", capabilityProfile: { capabilities: ["text"], contextLimit: 1000, toolSupport: false }, declaredCapabilities: [], credentials: { source: { kind: "managed-credential", credentialId: "c" } }, inferenceIsExternal: { kind: "known", value: false }, approvedForProtectedData: { kind: "known", value: false }, rights: { trainingAllowed: { kind: "known", value: false }, evaluationAllowed: { kind: "known", value: false }, redistributionAllowed: { kind: "known", value: false }, outputRetainedByProvider: { kind: "known", value: false }, policySnapshotDigest: { kind: "known", value: "d" } }, validFrom: "2026-01-01T00:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z", sourceClass: "vinci_pretrained", serving: { kind: "vinci_hosted" }, weightsDigest: { kind: "known", value: "wp" }, tokenizerDigest: { kind: "known", value: "t" }, architectureDigest: { kind: "known", value: "a" }, servingImageDigest: { kind: "known", value: "i" }, quantizationDigest: { kind: "unknown" } }, { schemaVersion: 1, endpointId: "r", capabilityProfile: { capabilities: ["text"], contextLimit: 1000, toolSupport: false }, declaredCapabilities: [], credentials: { source: { kind: "managed-credential", credentialId: "c" } }, inferenceIsExternal: { kind: "known", value: false }, approvedForProtectedData: { kind: "known", value: false }, rights: { trainingAllowed: { kind: "known", value: false }, evaluationAllowed: { kind: "known", value: false }, redistributionAllowed: { kind: "known", value: false }, outputRetainedByProvider: { kind: "known", value: false }, policySnapshotDigest: { kind: "known", value: "d" } }, validFrom: "2026-01-01T00:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z", sourceClass: "vinci_pretrained", serving: { kind: "vinci_hosted" }, weightsDigest: { kind: "known", value: "wr" }, tokenizerDigest: { kind: "known", value: "t" }, architectureDigest: { kind: "known", value: "a" }, servingImageDigest: { kind: "known", value: "i" }, quantizationDigest: { kind: "unknown" } }) === false && fn({ schemaVersion: 1, endpointId: "p", capabilityProfile: { capabilities: ["text"], contextLimit: 1000, toolSupport: false }, declaredCapabilities: [], credentials: { source: { kind: "managed-credential", credentialId: "c" } }, inferenceIsExternal: { kind: "known", value: false }, approvedForProtectedData: { kind: "known", value: false }, rights: { trainingAllowed: { kind: "known", value: false }, evaluationAllowed: { kind: "known", value: false }, redistributionAllowed: { kind: "known", value: false }, outputRetainedByProvider: { kind: "known", value: false }, policySnapshotDigest: { kind: "known", value: "d" } }, validFrom: "2026-01-01T00:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z", sourceClass: "vinci_pretrained", serving: { kind: "vinci_hosted" }, weightsDigest: { kind: "known", value: "wp" }, tokenizerDigest: { kind: "known", value: "t" }, architectureDigest: { kind: "known", value: "a" }, servingImageDigest: { kind: "known", value: "i" }, quantizationDigest: { kind: "unknown" } }, { schemaVersion: 1, endpointId: "p", capabilityProfile: { capabilities: ["text"], contextLimit: 1000, toolSupport: false }, declaredCapabilities: [], credentials: { source: { kind: "managed-credential", credentialId: "c" } }, inferenceIsExternal: { kind: "known", value: false }, approvedForProtectedData: { kind: "known", value: false }, rights: { trainingAllowed: { kind: "known", value: false }, evaluationAllowed: { kind: "known", value: false }, redistributionAllowed: { kind: "known", value: false }, outputRetainedByProvider: { kind: "known", value: false }, policySnapshotDigest: { kind: "known", value: "d" } }, validFrom: "2026-01-01T00:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z", sourceClass: "vinci_pretrained", serving: { kind: "vinci_hosted" }, weightsDigest: { kind: "known", value: "wp" }, tokenizerDigest: { kind: "known", value: "t" }, architectureDigest: { kind: "known", value: "a" }, servingImageDigest: { kind: "known", value: "i" }, quantizationDigest: { kind: "unknown" } }) === true && fn({ schemaVersion: 1, endpointId: "p", capabilityProfile: { capabilities: ["text"], contextLimit: 1000, toolSupport: false }, declaredCapabilities: [], credentials: { source: { kind: "managed-credential", credentialId: "c" } }, inferenceIsExternal: { kind: "known", value: false }, approvedForProtectedData: { kind: "known", value: false }, rights: { trainingAllowed: { kind: "known", value: false }, evaluationAllowed: { kind: "known", value: false }, redistributionAllowed: { kind: "known", value: false }, outputRetainedByProvider: { kind: "known", value: false }, policySnapshotDigest: { kind: "known", value: "d" } }, validFrom: "2026-01-01T00:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z", sourceClass: "vinci_pretrained", serving: { kind: "vinci_hosted" }, weightsDigest: { kind: "known", value: "wshared" }, tokenizerDigest: { kind: "known", value: "t" }, architectureDigest: { kind: "known", value: "a" }, servingImageDigest: { kind: "known", value: "i" }, quantizationDigest: { kind: "unknown" } }, { schemaVersion: 1, endpointId: "r", capabilityProfile: { capabilities: ["text"], contextLimit: 1000, toolSupport: false }, declaredCapabilities: [], credentials: { source: { kind: "managed-credential", credentialId: "c" } }, inferenceIsExternal: { kind: "known", value: false }, approvedForProtectedData: { kind: "known", value: false }, rights: { trainingAllowed: { kind: "known", value: false }, evaluationAllowed: { kind: "known", value: false }, redistributionAllowed: { kind: "known", value: false }, outputRetainedByProvider: { kind: "known", value: false }, policySnapshotDigest: { kind: "known", value: "d" } }, validFrom: "2026-01-01T00:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z", sourceClass: "vinci_pretrained", serving: { kind: "vinci_hosted" }, weightsDigest: { kind: "known", value: "wshared" }, tokenizerDigest: { kind: "known", value: "t" }, architectureDigest: { kind: "known", value: "a" }, servingImageDigest: { kind: "known", value: "i" }, quantizationDigest: { kind: "unknown" } }) === true },

  // attestedHarnessCapabilities is the ONLY thing permitted to feed
  // matchEndpointToRole's attestedHarnessCapabilities argument, so a hostile
  // attestation that made it return a non-empty list would hand a role an
  // eligibility the harness never demonstrated. Its "yes" is a NON-EMPTY list,
  // not `true` — the empty list is the fail-closed answer — so `call` reduces
  // the answer the same way the selectForRole entries above do. Both argument
  // positions are probed: a hostile `now` must not revive an expired
  // attestation any more than a hostile record may invent a capability.
  {
    pkg: "@getsimpledirect/vinci-run",
    export: "attestedHarnessCapabilities",
    label: "attestedHarnessCapabilities(hostile attestation, now)",
    call: (fn, hostile) => fn(hostile, "2026-08-23T12:00:00.000Z").length > 0,
    control: (fn) => {
      const D = "a".repeat(64);
      const attestation = {
        schemaVersion: 2, attestationId: "att-1", runtimeBuild: "worker@1.2.3", environmentDigest: D,
        workerPrincipalId: "principal-1",
        capabilities: [
          { id: "repository_editing", version: 1, status: "PASS", selfTestDigest: D, observedEntrypoint: "installed_package" },
          { id: "shell_execution", version: 1, status: "PASS", selfTestDigest: D, observedEntrypoint: "working_tree" },
        ],
        createdAt: "2026-08-23T00:00:00.000Z", expiresAt: "2026-08-24T00:00:00.000Z",
        issuedBy: { kind: "worker", workerId: "w-1" },
      };
      // A pinned checkout — what a production worker actually is — establishes
      // its capability, which v1 made impossible and is the whole point of the
      // v2 axis. Kept as a separate record so the mixed one above still shows
      // a working_tree entry contributing nothing beside an attestable one.
      const pinned = {
        ...attestation,
        capabilities: [{
          id: "repository_editing", version: 1, status: "PASS", selfTestDigest: D,
          observedEntrypoint: "pinned_checkout",
          checkoutPin: { commitId: "0".repeat(39) + "1", treeId: "f".repeat(39) + "e" },
        }],
      };
      // A pinned_checkout WITHOUT its pin evidence is invalid, so it grants
      // nothing: the label alone never counts.
      const unpinned = {
        ...attestation,
        capabilities: [{
          id: "repository_editing", version: 1, status: "PASS", selfTestDigest: D,
          observedEntrypoint: "pinned_checkout",
        }],
      };
      // Establishes the capability while valid; establishes NOTHING once
      // expired; and never counts a capability observed on a working tree.
      const live = fn(attestation, "2026-08-23T12:00:00.000Z");
      const expired = fn(attestation, "2026-08-25T00:00:00.000Z");
      return live.length === 1 && live[0] === "repository_editing" && expired.length === 0
        && fn(pinned, "2026-08-23T12:00:00.000Z").length === 1
        && fn(unpinned, "2026-08-23T12:00:00.000Z").length === 0;
    },
  },
  {
    pkg: "@getsimpledirect/vinci-run",
    export: "attestedHarnessCapabilities",
    label: "attestedHarnessCapabilities(attestation, hostile now)",
    call: (fn, hostile) => {
      const D = "a".repeat(64);
      return fn({
        schemaVersion: 2, attestationId: "att-1", runtimeBuild: "worker@1.2.3", environmentDigest: D,
        workerPrincipalId: "principal-1",
        capabilities: [{ id: "repository_editing", version: 1, status: "PASS", selfTestDigest: D, observedEntrypoint: "installed_package" }],
        createdAt: "2026-08-23T00:00:00.000Z", expiresAt: "2026-08-24T00:00:00.000Z",
        issuedBy: { kind: "worker", workerId: "w-1" },
      }, hostile).length > 0;
    },
    control: (fn) => {
      const D = "a".repeat(64);
      const attestation = {
        schemaVersion: 2, attestationId: "att-1", runtimeBuild: "worker@1.2.3", environmentDigest: D,
        workerPrincipalId: "principal-1",
        capabilities: [{ id: "repository_editing", version: 1, status: "PASS", selfTestDigest: D, observedEntrypoint: "installed_package" }],
        createdAt: "2026-08-23T00:00:00.000Z", expiresAt: "2026-08-24T00:00:00.000Z",
        issuedBy: { kind: "worker", workerId: "w-1" },
      };
      return fn(attestation, "2026-08-23T12:00:00.000Z").length === 1
        && fn(attestation, "2026-08-24T00:00:00.000Z").length === 0;
    },
  },
  // --- oracle-records ------------------------------------------------------
  //
  // Four decisions this package makes that a hostile input must never be able
  // to win. Each `call` reduces the outcome union to the ONE arm that grants
  // something, so a refusal reads as `false` to the probe above; each `control`
  // proves both that the legitimate operation still works and that the guard
  // says no to a specific, legitimate-looking wrong answer. A guard that
  // refused everything would satisfy the hostile probes and fail its control.
  {
    pkg: "@getsimpledirect/vinci-oracle-records",
    export: "admitResearchRequest",
    label: "admitResearchRequest(draft).outcome === ADMITTED",
    call: (fn, hostile) => fn(hostile).outcome === "ADMITTED",
    control: (fn) =>
      fn(ORACLE_REQUEST).outcome === "ADMITTED"
      && fn(oracleWithout(ORACLE_REQUEST, "/policyRef")).outcome === "INCOMPLETE"
      && fn(oracleWithout(ORACLE_REQUEST, "/hostResolved/missionOwner")).outcome === "INCOMPLETE",
  },
  {
    pkg: "@getsimpledirect/vinci-oracle-records",
    export: "resolveIdempotency",
    label: "resolveIdempotency(hostile prior, request).outcome === SAME_REQUEST",
    call: (fn, hostile) => fn(hostile, ORACLE_REQUEST).outcome === "SAME_REQUEST",
    control: (fn) =>
      fn(ORACLE_PRIOR_IDENTITY, ORACLE_REQUEST).outcome === "SAME_REQUEST"
      && fn({ ...ORACLE_PRIOR_IDENTITY, requestDigest: "0".repeat(64) }, ORACLE_REQUEST).outcome
        === "KEY_CONFLICT",
  },
  {
    pkg: "@getsimpledirect/vinci-oracle-records",
    export: "resolveIdempotency",
    label: "resolveIdempotency(prior, hostile request).outcome === SAME_REQUEST",
    call: (fn, hostile) => fn(ORACLE_PRIOR_IDENTITY, hostile).outcome === "SAME_REQUEST",
    control: (fn) =>
      fn(ORACLE_PRIOR_IDENTITY, ORACLE_REQUEST).outcome === "SAME_REQUEST"
      && fn(ORACLE_PRIOR_IDENTITY, { ...ORACLE_REQUEST, workspaceRef: "ws-somebody-else" }).outcome
        === "KEY_CONFLICT",
  },
  {
    pkg: "@getsimpledirect/vinci-oracle-records",
    export: "resolveCitations",
    label: "resolveCitations(hostile citations, delivered).outcome === RESOLVED",
    call: (fn, hostile) => fn(hostile, ORACLE_HANDLES).outcome === "RESOLVED",
    control: (fn) =>
      fn([ORACLE_CITATION], ORACLE_HANDLES).outcome === "RESOLVED"
      && fn(
        [{ ...ORACLE_CITATION, payload: { ...ORACLE_CITATION.payload, sourceId: "oracle-source-99" } }],
        ORACLE_HANDLES,
      ).outcome === "UNRESOLVED",
  },
  {
    pkg: "@getsimpledirect/vinci-oracle-records",
    export: "resolveCitations",
    label: "resolveCitations(citations, hostile delivered).outcome === RESOLVED",
    call: (fn, hostile) => fn([ORACLE_CITATION], hostile).outcome === "RESOLVED",
    control: (fn) =>
      fn([ORACLE_CITATION], ORACLE_HANDLES).outcome === "RESOLVED"
      && fn([ORACLE_CITATION], [{ ...ORACLE_HANDLES[0], runRef: "run-somebody-else" }]).outcome
        === "UNRESOLVED",
  },
  {
    pkg: "@getsimpledirect/vinci-oracle-records",
    export: "resolveContextBinding",
    label: "resolveContextBinding(hostile binding, manifest, runRef).outcome === BOUND",
    call: (fn, hostile) => fn(hostile, ORACLE_MANIFEST, ORACLE_BINDING.runRef).outcome === "BOUND",
    control: (fn) =>
      fn(ORACLE_BINDING, ORACLE_MANIFEST, ORACLE_BINDING.runRef).outcome === "BOUND"
      && fn({ ...ORACLE_BINDING, contextManifestDigest: "0".repeat(64) }, ORACLE_MANIFEST,
        ORACLE_BINDING.runRef).outcome === "MANIFEST_MISMATCH",
  },
  {
    pkg: "@getsimpledirect/vinci-oracle-records",
    export: "resolveContextBinding",
    label: "resolveContextBinding(binding, hostile manifest, runRef).outcome === BOUND",
    call: (fn, hostile) => fn(ORACLE_BINDING, hostile, ORACLE_BINDING.runRef).outcome === "BOUND",
    control: (fn) =>
      fn(ORACLE_BINDING, ORACLE_MANIFEST, ORACLE_BINDING.runRef).outcome === "BOUND"
      && fn(ORACLE_BINDING, { ...ORACLE_MANIFEST, runId: 7 }, ORACLE_BINDING.runRef).outcome
        === "REFUSED"
      && fn(ORACLE_BINDING, { ...ORACLE_MANIFEST, runId: "run-somebody-else" },
        ORACLE_BINDING.runRef).outcome === "MANIFEST_MISMATCH",
  },
  {
    pkg: "@getsimpledirect/vinci-oracle-records",
    export: "resolveContextBinding",
    label: "resolveContextBinding(binding, manifest, hostile runRef).outcome === BOUND",
    // THE ANCHOR ARGUMENT, probed in its own right. The run check used to
    // compare the binding to the manifest -- two untrusted inputs -- so a
    // forger writing the same wrong run into both passed.
    call: (fn, hostile) => fn(ORACLE_BINDING, ORACLE_MANIFEST, hostile).outcome === "BOUND",
    control: (fn) =>
      fn(ORACLE_BINDING, ORACLE_MANIFEST, ORACLE_BINDING.runRef).outcome === "BOUND"
      && fn(ORACLE_BINDING, ORACLE_MANIFEST, "run-somebody-else").outcome === "MANIFEST_MISMATCH",
  },
  {
    pkg: "@getsimpledirect/vinci-oracle-records",
    export: "isSupportedSchemaVersion",
    label: "isSupportedSchemaVersion(version)",
    call: (fn, hostile) => fn(hostile),
    control: (fn) => fn(1) === true && fn(2) === false && fn("1") === false,
  },
  // CLM-01's decision, and the one this package exists for. The `call` reduces
  // the five-status answer to the ONE status that grants something, so every
  // hostile shape must read as false. The control proves the other direction
  // three ways: a completed run over real spans DOES earn SUPPORTED, a timeout
  // is CHECK_UNAVAILABLE, and a completed run over empty material is
  // INSUFFICIENT_EVIDENCE rather than either.
  {
    pkg: "@getsimpledirect/vinci-oracle-records",
    export: "statusForReviewerOutcome",
    label: "statusForReviewerOutcome(outcome) === SUPPORTED",
    call: (fn, hostile) => fn(hostile) === "SUPPORTED",
    control: (fn) =>
      fn({ kind: "COMPLETED", finding: "SUPPORTS", reviewedSpans: ORACLE_CLAIM.sourceSpans })
        === "SUPPORTED"
      && fn({ kind: "TIMED_OUT", detail: "the reviewer exceeded its wall clock" })
        === "CHECK_UNAVAILABLE"
      && fn({ kind: "COMPLETED", finding: "SUPPORTS", reviewedSpans: [] })
        === "INSUFFICIENT_EVIDENCE",
  },
  {
    pkg: "@getsimpledirect/vinci-oracle-records",
    export: "mapProposalToJobShape",
    label: "mapProposalToJobShape(hostile proposal, allowlist).outcome === MAPPED",
    call: (fn, hostile) => fn(hostile, ORACLE_JOB_SHAPES).outcome === "MAPPED",
    control: (fn) =>
      fn(ORACLE_PROPOSAL, ORACLE_JOB_SHAPES).outcome === "MAPPED"
      && fn(
        { ...ORACLE_PROPOSAL, payload: { ...ORACLE_PROPOSAL.payload, kind: "ESCALATE" } },
        ORACLE_JOB_SHAPES,
      ).outcome === "UNMAPPED",
  },
  {
    pkg: "@getsimpledirect/vinci-oracle-records",
    export: "mapProposalToJobShape",
    label: "mapProposalToJobShape(proposal, hostile allowlist).outcome === MAPPED",
    call: (fn, hostile) => fn(ORACLE_PROPOSAL, hostile).outcome === "MAPPED",
    control: (fn) =>
      fn(ORACLE_PROPOSAL, ORACLE_JOB_SHAPES).outcome === "MAPPED"
      && fn(ORACLE_PROPOSAL, []).outcome === "UNMAPPED",
  },
  {
    pkg: "@getsimpledirect/vinci-oracle-records",
    export: "resolveOutcomeCredits",
    label: "resolveOutcomeCredits(hostile outcomes, authorizedWork).outcome === CREDITED",
    call: (fn, hostile) => fn(hostile, ORACLE_AUTHORIZED_WORK).outcome === "CREDITED",
    control: (fn) =>
      fn([ORACLE_OUTCOME], ORACLE_AUTHORIZED_WORK).outcome === "CREDITED"
      && fn([ORACLE_OUTCOME, { ...ORACLE_OUTCOME, outcomeId: "oracle-outcome-99" }],
        ORACLE_AUTHORIZED_WORK).outcome === "DOUBLE_CREDITED"
      && fn([{ ...ORACLE_OUTCOME, authorizedWorkRef: "wo-invented" }],
        ORACLE_AUTHORIZED_WORK).outcome === "UNAUTHORIZED_WORK",
  },
  {
    pkg: "@getsimpledirect/vinci-oracle-records",
    export: "resolveOutcomeCredits",
    label: "resolveOutcomeCredits(outcomes, hostile authorizedWork).outcome === CREDITED",
    // The ANCHOR argument, probed in its own right. A hostile authorized-work
    // set must never let a credit through: it is the whole reason the rule
    // stopped being keyed on a string the record writes.
    call: (fn, hostile) => fn([ORACLE_OUTCOME], hostile).outcome === "CREDITED",
    control: (fn) =>
      fn([ORACLE_OUTCOME], ORACLE_AUTHORIZED_WORK).outcome === "CREDITED"
      && fn([ORACLE_OUTCOME], []).outcome === "UNAUTHORIZED_WORK",
  },
  {
    pkg: "@getsimpledirect/vinci-oracle-records",
    export: "evidenceIsMissing",
    label: "evidenceIsMissing(boundClaim) === false",
    // The permissive answer is FALSE -- "this claim rests on evidence that
    // resolved" -- which is what puts it under "What the evidence establishes".
    // So `false` is the yes, and no hostile shape may produce it.
    call: (fn, hostile) => fn(hostile) === false,
    control: (fn) => {
      const bound = ORACLE_BOUND_CLAIM();
      if (bound === undefined) return false;
      return (
        fn(bound) === false
        && fn({ ...bound, unresolvedSourceIds: bound.claim.sourceSpans.map((s) => s.sourceId) })
          === true
      );
    },
  },
  // The INNER argument positions. The outer-position probe never reached them,
  // and six inner shapes threw out of a function whose own contract says a
  // guard must refuse rather than throw.
  {
    pkg: "@getsimpledirect/vinci-oracle-records",
    export: "evidenceIsMissing",
    label: "evidenceIsMissing({ claim: hostile }) === false",
    call: (fn, hostile) => fn({ claim: hostile, unresolvedSourceIds: [] }) === false,
    control: (fn) => {
      const bound = ORACLE_BOUND_CLAIM();
      return bound !== undefined && fn(bound) === false && fn({ ...bound, claim: undefined }) === true;
    },
  },
  {
    pkg: "@getsimpledirect/vinci-oracle-records",
    export: "evidenceIsMissing",
    label: "evidenceIsMissing({ claim: { sourceSpans: hostile } }) === false",
    call: (fn, hostile) =>
      fn({ claim: { sourceSpans: hostile }, unresolvedSourceIds: [] }) === false,
    control: (fn) => {
      const bound = ORACLE_BOUND_CLAIM();
      if (bound === undefined) return false;
      // No assessment in the control, so `cited` comes from the claim's spans
      // alone -- otherwise a bound assessment's reviewed spans supply the
      // evidence and an empty claim span list is correctly NOT missing.
      return (
        fn(bound) === false
        && fn({ ...bound, assessment: undefined, claim: { ...bound.claim, sourceSpans: [] } })
          === true
      );
    },
  },
  {
    pkg: "@getsimpledirect/vinci-oracle-records",
    export: "evidenceIsMissing",
    label: "evidenceIsMissing({ assessment: hostile }) manufactures evidence",
    // The property in THIS position is not "a hostile assessment yields false"
    // -- a claim whose own spans resolved still has evidence, whatever the
    // assessment is, and answering false there is correct. What must not happen
    // is a hostile assessment turning a claim with NO resolvable evidence into
    // one that has some. So the base is a claim whose every cited span is
    // unresolved, and the hostile value goes in beside it.
    call: (fn, hostile) => {
      const missing = ORACLE_MISSING_CLAIM();
      return missing !== undefined && fn({ ...missing, assessment: hostile }) === false;
    },
    control: (fn) => {
      const missing = ORACLE_MISSING_CLAIM();
      const bound = ORACLE_BOUND_CLAIM();
      if (missing === undefined || bound === undefined) return false;
      return (
        // The base really is missing, so the probes above have something to flip.
        fn(missing) === true
        // And a REAL assessment reviewing a delivered source does supply
        // evidence, so this position can still answer false.
        && fn({
          ...missing,
          assessment: { ...bound.assessment, reviewedSpans: bound.claim.sourceSpans },
          unresolvedSourceIds: [],
        }) === false
      );
    },
  },
  {
    pkg: "@getsimpledirect/vinci-oracle-records",
    export: "evidenceIsMissing",
    label: "evidenceIsMissing({ unresolvedSourceIds: hostile }) === false",
    // The wrong-type case that failed OPEN: a non-array coerced to the empty
    // set, which reads as "nothing is unresolved".
    call: (fn, hostile) => {
      const bound = ORACLE_BOUND_CLAIM();
      return bound !== undefined && fn({ ...bound, unresolvedSourceIds: hostile }) === false;
    },
    control: (fn) => {
      const bound = ORACLE_BOUND_CLAIM();
      if (bound === undefined) return false;
      const allUnresolved = bound.claim.sourceSpans.map((s) => s.sourceId);
      return fn(bound) === false && fn({ ...bound, unresolvedSourceIds: allUnresolved }) === true;
    },
  },
  {
    pkg: "@getsimpledirect/vinci-oracle-records",
    export: "resolveReportBundle",
    label: "resolveReportBundle(bundle) binds a claim",
    // "Granted a yes" for this one is not RESOLVED — a well-formed bundle whose
    // bindings all fail is still RESOLVED, with the failures named. The yes is
    // BINDING a claim, which is what lets a status be printed.
    call: (fn, hostile) => {
      const result = fn(hostile);
      return result.outcome === "RESOLVED" && result.claims.some((c) => c.state === "BOUND");
    },
    control: (fn) => {
      const bound = fn(ORACLE_BUNDLE);
      if (bound.outcome !== "RESOLVED" || !bound.claims.some((c) => c.state === "BOUND")) return false;
      // A CONSISTENT LIE: report and assessment agree on a digest that is not
      // the claim's. Nothing binds, and the record set is otherwise valid.
      const lying = fn({
        ...ORACLE_BUNDLE,
        report: {
          ...ORACLE_BUNDLE.report,
          claims: ORACLE_BUNDLE.report.claims.map((c) => ({ ...c, claimDigest: "5e".repeat(32) })),
        },
        assessments: ORACLE_BUNDLE.assessments.map((a) => ({ ...a, claimDigest: "5e".repeat(32) })),
      });
      return lying.outcome === "RESOLVED" && !lying.claims.some((c) => c.state === "BOUND");
    },
  },
];

/**
 * Names that MUST appear in AUTHORITY_GUARDS above.
 *
 * Without this, the registry is a list nobody checks: deleting both mayIssue
 * entries dropped coverage from 105 probes to 63 and the gate still exited 0,
 * green. Silent coverage loss is the same failure as a vacuous test — the
 * check reports success for work it did not do.
 *
 * These are LABELS, not pkg.export names, and that distinction is the whole
 * point. Keying by function name meant a function probed in two argument
 * positions only needed ONE of them to survive: deleting a single mayIssue
 * entry dropped probes from 315 to 294 and exited 0, because the remaining
 * entry still satisfied "remote-protocol.mayIssue". Every probe is now named
 * individually, so losing an argument position is as visible as losing a
 * function.
 *
 * A reviewer also corrected a claim that used to sit here: deleting a UNIQUE
 * entry was already caught, by the export-triage sweep rather than by this
 * list. Only the duplicated-position case slipped. The premise was wrong even
 * though the conclusion held.
 */
const REQUIRED_GUARDS = [
  "isCredentialActiveAt(credential, at)",
  "admitResearchRequest(draft).outcome === ADMITTED",
  "resolveIdempotency(hostile prior, request).outcome === SAME_REQUEST",
  "resolveIdempotency(prior, hostile request).outcome === SAME_REQUEST",
  "resolveCitations(hostile citations, delivered).outcome === RESOLVED",
  "resolveCitations(citations, hostile delivered).outcome === RESOLVED",
  "resolveContextBinding(hostile binding, manifest, runRef).outcome === BOUND",
  "resolveContextBinding(binding, hostile manifest, runRef).outcome === BOUND",
  "resolveContextBinding(binding, manifest, hostile runRef).outcome === BOUND",
  "isSupportedSchemaVersion(version)",
  "statusForReviewerOutcome(outcome) === SUPPORTED",
  "mapProposalToJobShape(hostile proposal, allowlist).outcome === MAPPED",
  "mapProposalToJobShape(proposal, hostile allowlist).outcome === MAPPED",
  "resolveOutcomeCredits(hostile outcomes, authorizedWork).outcome === CREDITED",
  "resolveOutcomeCredits(outcomes, hostile authorizedWork).outcome === CREDITED",
  "resolveReportBundle(bundle) binds a claim",
  "evidenceIsMissing(boundClaim) === false",
  "evidenceIsMissing({ claim: hostile }) === false",
  "evidenceIsMissing({ claim: { sourceSpans: hostile } }) === false",
  "evidenceIsMissing({ assessment: hostile }) manufactures evidence",
  "evidenceIsMissing({ unresolvedSourceIds: hostile }) === false",
  "isKeyUsableAt(entry with hostile status, now, role)",
  "isKeyUsableAt(entry with hostile role, now, role)",
  "isKeyUsableAt(entry, now, hostile role)",
  "isSnapshotNewer(candidate, currentVersion)",
  "isSnapshotNewer(2, currentVersion)",
  "frameMatchesBinding(frame, binding)",
  "frameMatchesBinding(validFrame, binding)",
  "mayIssue(role, 'pause')",
  "mayIssue('owner', command)",
  "assertedRoleMatchesGrant(assertedRole, 'owner')",
  "assertedRoleMatchesGrant('owner', grantedRole)",
  "validateAuthorityCommandEnvelope(envelope).ok",
  "bindingRefMatches(ref, binding)",
  "bindingRefMatches(validRef, binding)",
  "isGrantStrictlyNarrower(a, b)",
  "isDecisionEffective(decision)",
  "canAdvanceDelivery(a, b)",
  "isEffectiveDeliveryState(state)",
  "isOrganizationWorkspace(value)",
  "terminalStateOfVerification(value)",
  "deriveLegacyTerminal(triple)",
  "isOutcomeTriple(value)",
  "canTransition(dimension, 'PENDING', 'LEASED')",
  "canTransition('execution', from, 'LEASED')",
  "canTransition('execution', 'PENDING', to)",
  "plainActor(actor)",
  "actorFieldsAreConsistent(actor)",
  "countsAgainstSubmittedWork(outcome)",
  "isProvenanceConsistent(provenance, actor)",
  "isProvenanceConsistent('worker_provided', actor)",
  "mayInterrupt(budget, spend)",
  "mayInterrupt(budget, hostileSpend)",
  "mayRequireDecision(budget, spend)",
  "mayRequireDecision(budget, hostileSpend)",
  "statusIsSupportedBy('VERIFIED_PASS', results)",
  "statusIsSupportedBy(status, [supported])",
  "matchEndpointToRole(hostile role, endpoint, now)",
  "matchEndpointToRole(role, hostile endpoint, now)",
  "attestedHarnessCapabilities(hostile attestation, now)",
  "attestedHarnessCapabilities(attestation, hostile now)",
];


/**
 * Exported functions deliberately NOT probed as authority guards, each with a
 * reason. The point is that adding an export forces a decision: a new export
 * that is neither a validator, nor a registered guard, nor listed here fails
 * the gate rather than silently going unexamined.
 */
const NOT_AUTHORITY_GUARDS = {
  "@getsimpledirect/vinci-model-classes.endpointById": "pure lookup: finds an entry by id in a frozen array and returns it or undefined. It grants nothing — the record it returns is itself subject to matchEndpointToRole, which IS probed, so a hostile id can at most retrieve a declaration that must still pass the guard",
  "@getsimpledirect/vinci-device-auth.decodeCanonicalBase64Url": "pure encoding predicate: returns the decoded bytes of canonical unpadded base64url or undefined; grants nothing",
  "@getsimpledirect/vinci-approvals.applyApprovalDecision": "state transition over an already-validated decision",
  "@getsimpledirect/vinci-approvals.createApprovalDecision": "constructor; its output is validated",
  "@getsimpledirect/vinci-approvals.collectActorUnknownFields": "helper used inside a validator, after the snapshot",
  "@getsimpledirect/vinci-approvals.notificationSafeProjection": "projection, not a predicate; has its own redaction suite",
  "@getsimpledirect/vinci-approvals.assertSchemaMetaComplete": "build-time assertion, not runtime input",
  "@getsimpledirect/vinci-contracts.assertSchemaMetaComplete": "build-time assertion, not runtime input",
  "@getsimpledirect/vinci-contracts.isCanonicalTimestamp": "pure string/regex predicate",
  "@getsimpledirect/vinci-contracts.isDigest": "pure string/regex predicate",
  "@getsimpledirect/vinci-contracts.isEnumToken": "pure string/regex predicate",
  "@getsimpledirect/vinci-contracts.isIdentifier": "pure string/regex predicate",
  "@getsimpledirect/vinci-contracts.isNonBlankText": "pure string predicate",
  "@getsimpledirect/vinci-contracts.isSessionRole": "enum membership",
  // Total function: returns a string for every input and never throws.
  // Its own no-throw property is pinned by unit tests, including the
  // null-prototype case that made String() throw in the first place.
  "@getsimpledirect/vinci-contracts.safeLabel": "total value-to-label function, never a decision",
  "@getsimpledirect/vinci-contracts.ownData": "single own-data property read; never a decision",
  // Checked id constructors. Each validates with isIdentifier and returns a
  // branded string or null. They answer "is this a well-formed identifier",
  // never "may this happen", and their refusal path is pinned by unit tests.
  "@getsimpledirect/vinci-contracts.toOrganizationId": "checked id constructor; returns a branded string or null",
  "@getsimpledirect/vinci-contracts.toWorkspaceId": "checked id constructor; returns a branded string or null",
  "@getsimpledirect/vinci-contracts.toRunId": "checked id constructor; returns a branded string or null",
  "@getsimpledirect/vinci-contracts.toWorkerId": "checked id constructor; returns a branded string or null",
  "@getsimpledirect/vinci-contracts.toAgentId": "checked id constructor; returns a branded string or null",
  "@getsimpledirect/vinci-contracts.toDeviceId": "checked id constructor; returns a branded string or null",
  "@getsimpledirect/vinci-contracts.toUserId": "checked id constructor; returns a branded string or null",
  "@getsimpledirect/vinci-contracts.toApprovalId": "checked id constructor; returns a branded string or null",
  "@getsimpledirect/vinci-contracts.toArtifactId": "checked id constructor; returns a branded string or null",
  "@getsimpledirect/vinci-contracts.toEvidenceId": "checked id constructor; returns a branded string or null",
  "@getsimpledirect/vinci-contracts.toReceiptId": "checked id constructor; returns a branded string or null",
  "@getsimpledirect/vinci-contracts.toPolicyId": "checked id constructor; returns a branded string or null",
  // Arithmetic over an already-validated budget and spend. It answers "how
  // much is left", not "may this happen" — the guards above answer that, and
  // they validate before calling it.
  "@getsimpledirect/vinci-work-orders.attentionRemaining": "computes remaining counts; not a permission",
  "@getsimpledirect/vinci-work-orders.amendWorkOrder": "constructor over validated inputs; its output is validated",
  "@getsimpledirect/vinci-work-orders.classifyMateriality": "total classification over typed contract changes",
  "@getsimpledirect/vinci-work-orders.verificationIsStaleAfter": "projection from a validated amendment, not an authority decision",
  "@getsimpledirect/vinci-work-orders.workOrderDigest": "encoder over a record it validates first; throws on an invalid one",
  "@getsimpledirect/vinci-work-orders.executionSpecDigest": "encoder over a record it validates first; throws on an invalid one",
  "@getsimpledirect/vinci-work-orders.isPlainBranchName": "pure string/regex predicate",
  "@getsimpledirect/vinci-work-orders.parsePathRoot": "returns a typed parse result, not a boolean; pure string grammar, refuses every non-string as empty",
  "@getsimpledirect/vinci-work-orders.parsePathGrant": "returns a typed parse result or null, not a boolean; pure string grammar over parsePathRoot",
  "@getsimpledirect/vinci-work-orders.describePathRootRefusal": "total function from a refusal reason to its message",
  "@getsimpledirect/vinci-work-orders.sha256Hex": "pure hash of a string",
  "@getsimpledirect/vinci-work-orders.checkExecutionSpecWithinOrder": "returns a ValidationResult, not a boolean; validates both inputs through the probed validators before comparing grants",
  "@getsimpledirect/vinci-work-orders.bindExecutionSpec": "returns a ValidationResult, not a boolean; both inputs go through the probed validators (validateExecutionSpec, validateWorkOrder) before any comparison",
  "@getsimpledirect/vinci-contracts.isStrictlyAfter": "pure string predicate over two canonical timestamps",
  // Takes an ALREADY-SNAPSHOTTED PlainRecord and is a thin Object.hasOwn.
  // Returning true for an accessor is correct — the key is own-present — so
  // registering it as an authority guard was a classification error on my
  // part, not a defect in it.
  "@getsimpledirect/vinci-contracts.hasField": "own-key accessor over an inert snapshot, used inside validators",
  // Constructors/among-ours enum predicates: membership tests against OUR
  // frozen arrays via includes, which coerces nothing and invokes nothing.
  "@getsimpledirect/vinci-device-auth.isClientType": "enum membership",
  "@getsimpledirect/vinci-device-auth.isDeviceScope": "enum membership",
  "@getsimpledirect/vinci-device-auth.isEnforcedRole": "enum membership",
  "@getsimpledirect/vinci-device-auth.isPairingState": "enum membership",
  "@getsimpledirect/vinci-device-auth.isRole": "enum membership",
  "@getsimpledirect/vinci-device-auth.isScope": "enum membership",
  "@getsimpledirect/vinci-device-auth.isShippingClientType": "enum membership",
  "@getsimpledirect/vinci-evidence.isFailureOwner": "enum membership",
  "@getsimpledirect/vinci-remote-protocol.isSessionRole": "enum membership",
  "@getsimpledirect/vinci-remote-protocol.isReversibleBraking": "enum membership",
  "@getsimpledirect/vinci-remote-protocol.isTerminal": "enum membership",
  "@getsimpledirect/vinci-remote-protocol.authorityCommandSigningPayload": "canonical byte encoder over an already-validated envelope; performs no authority decision",
  "@getsimpledirect/vinci-remote-protocol.githubActionAttributionSigningPayload": "canonical byte encoder over an already-validated envelope; performs no authority decision",
  "@getsimpledirect/vinci-remote-protocol.githubActionAttributionDigest": "digest encoder over an already-validated envelope",
  "@getsimpledirect/vinci-remote-protocol.githubActionAttributionPointer": "compact pointer encoder over an already-validated envelope",
  "@getsimpledirect/vinci-remote-protocol.parseReviewPublicationAttributionJson": "strict JSON ingress returning a ValidationResult; duplicate, encoding and hostile-key refusals are pinned by its cross-language suite",
  "@getsimpledirect/vinci-remote-protocol.reviewPublicationAttributionSigningPayload": "canonical byte encoder over an already-validated attribution; performs no authority decision",
  "@getsimpledirect/vinci-remote-protocol.reviewPublicationAttributionDigest": "digest encoder over an already-validated attribution",
  "@getsimpledirect/vinci-remote-protocol.verifyReviewPublicationAttributionSignature": "raw cryptographic check only; key role/status and server binding remain mandatory external authority decisions",
  "@getsimpledirect/vinci-remote-protocol.formatReviewPublicationReference": "strict compact-reference formatter returning a ValidationResult; it grants nothing",
  "@getsimpledirect/vinci-run-events.isRunEventType": "enum membership",
  "@getsimpledirect/vinci-run-events.isCanonicalTimestamp": "pure string/regex predicate",
  "@getsimpledirect/vinci-contracts.isActorKind": "enum membership",
  "@getsimpledirect/vinci-contracts.isRunState": "enum membership",
  "@getsimpledirect/vinci-contracts.isTerminal": "enum membership",
  "@getsimpledirect/vinci-contracts.isTerminalState": "enum membership",
  "@getsimpledirect/vinci-contracts.isVerdictStatus": "enum membership",
  "@getsimpledirect/vinci-contracts.isExecutionState": "enum membership",
  "@getsimpledirect/vinci-contracts.isAssuranceState": "enum membership",
  "@getsimpledirect/vinci-contracts.isPromotionState": "enum membership",
  "@getsimpledirect/vinci-contracts.isEvidenceState": "enum membership",
  "@getsimpledirect/vinci-contracts.isWorkerTerminalState": "enum membership",
  "@getsimpledirect/vinci-contracts.isStateDimension": "enum membership",
  "@getsimpledirect/vinci-contracts.legalTransitionsFrom": "enumeration helper: returns a (possibly empty) list of successor states, never a decision; canTransition is the probed guard over the same table",
  "@getsimpledirect/vinci-contracts.isConsequentialActionClass": "enum membership",
  "@getsimpledirect/vinci-policy.isAutonomyRung": "enum membership",
  "@getsimpledirect/vinci-policy.compareAutonomyRungs": "ordinal comparison over typed enum members; not a permission",
  "@getsimpledirect/vinci-contracts.terminalStateOf": "total map lookup, returns undefined for unknown",
  "@getsimpledirect/vinci-contracts.toPlainRecord": "IS the snapshot boundary; has its own suite",
  "@getsimpledirect/vinci-contracts.canonicalize": "encoder, not a guard; golden vectors pin its bytes",
  "@getsimpledirect/vinci-receipts.canonicalize": "re-export of contracts.canonicalize",
  "@getsimpledirect/vinci-run-events.canonicalize": "re-export of contracts.canonicalize",
  "@getsimpledirect/vinci-contracts.ok": "result constructor",
  "@getsimpledirect/vinci-contracts.fail": "result constructor",
  "@getsimpledirect/vinci-policy.ok": "result constructor",
  "@getsimpledirect/vinci-policy.fail": "result constructor",
  "@getsimpledirect/vinci-policy.assertSchemaMetaComplete": "build-time assertion, not runtime input",
  "@getsimpledirect/vinci-policy.evaluatePolicyDecision": "structured policy evaluator; fail-closed hostile inputs are pinned by its unit suite",
  "@getsimpledirect/vinci-run-events.payloadSpecIsComplete": "build-time assertion over OUR spec",
  // NULLARY. Both take no arguments, so there is no hostile input to probe:
  // they read RUN_EVENT_TYPES and PAYLOAD_FIELDS — this package's own frozen
  // declarations — and return a projection of them. Nothing a caller supplies
  // reaches either one, and neither decides anything.
  "@getsimpledirect/vinci-run-events.vocabularyVector": "nullary projection of OUR frozen vocabulary; no caller input reaches it",
  "@getsimpledirect/vinci-run-events.emitVocabularyVector": "nullary encoder of vocabularyVector's output; the committed vector's bytes are pinned by vocabulary-vector.test.ts",
  "@getsimpledirect/vinci-evidence.blamesSubmittedWork": "enum membership over FAILURE_OWNERS",
  "@getsimpledirect/vinci-evidence.verdictAssessmentFor": "constructor; its output is validated",
  "@getsimpledirect/vinci-receipts.receiptDigest": "encoder over an already-validated record",
  "@getsimpledirect/vinci-receipts.attentionPerVerifiedOutcome": "pure aggregation over already-validated receipts; not a permission",
  "@getsimpledirect/vinci-run-events.eventDigest": "encoder over an already-validated record",
  "@getsimpledirect/vinci-receipts.verificationAgainst": "requires current state; covered by receipts suite",
  "@getsimpledirect/vinci-run-events.verifyAppend": "covered by the run-events suite",
  "@getsimpledirect/vinci-device-auth.parseKeyHash": "parser returning a ValidationResult",
  "@getsimpledirect/vinci-device-auth.credentialIdentityDigest": "digest encoder over an already-validated credential",
  "@getsimpledirect/vinci-device-auth.relayAccessTokenSigningPayload": "canonical encoder over an already-validated token",
  "@getsimpledirect/vinci-device-auth.revocationSnapshotSigningPayload": "canonical encoder over an already-validated snapshot",
  "@getsimpledirect/vinci-device-auth.revoke": "state transition over an already-validated record",
  "@getsimpledirect/vinci-session-stream.nextSeqIsValid": "predicate over safe integers; answers whether next is the unused sequence after prev",
  "@getsimpledirect/vinci-worker-capabilities.isTrustLevel": "enum membership",
  "@getsimpledirect/vinci-worker-capabilities.compareTrustLevels": "comparison over members of the ordered trust vocabulary",
  "@getsimpledirect/vinci-worker-capabilities.derivedTrustLevel": "derivation over an already-validated capability matrix",
  "@getsimpledirect/vinci-worker-capabilities.permittedRemoteCommands": "UI projection over an already-validated capability matrix",
  "@getsimpledirect/vinci-worker-capabilities.trustLevelLabel": "total label lookup over the trust vocabulary",
  "@getsimpledirect/vinci-model-classes.endpointById": "pure lookup by id over a frozen array; returns a record or undefined; grants nothing",
  "@getsimpledirect/vinci-model-classes.roleById": "pure lookup by id over a frozen array; returns a record or undefined; grants nothing",
  // vinci-run. The six digest functions and their two helpers are IDENTITY, not
  // authority: each validates first and THROWS on an invalid record rather than
  // returning a digest, so hostile input cannot obtain a stable identity for
  // something that is not a contract object. attestedHarnessCapabilities IS an
  // authority function and is probed in AUTHORITY_GUARDS above, in both
  // argument positions.
  "@getsimpledirect/vinci-run.agentDigest": "identity, not authority: validates and throws rather than digesting an invalid agent; returns a hex string that grants nothing",
  "@getsimpledirect/vinci-run.environmentDigest": "identity, not authority: validates and throws rather than digesting an invalid environment",
  "@getsimpledirect/vinci-run.runDigest": "identity, not authority: validates and throws rather than digesting an invalid run",
  "@getsimpledirect/vinci-run.contextManifestDigest": "identity, not authority: validates and throws rather than digesting an invalid context manifest",
  "@getsimpledirect/vinci-run.harnessAttestationDigest": "identity, not authority: validates and throws rather than digesting an invalid attestation. What the attestation ESTABLISHES is decided by attestedHarnessCapabilities, which is probed",
  "@getsimpledirect/vinci-run.humanCorrectionDigest": "identity, not authority: validates and throws rather than digesting an invalid correction",
  "@getsimpledirect/vinci-run.digestValidated": "takes an already-computed ValidationResult and throws unless it is ok; it is the shared body of the six digest functions above, not a decision of its own",
  "@getsimpledirect/vinci-run.sha256Hex": "pure hash of a string; no input shape can make it answer a question",
  "@getsimpledirect/vinci-run.projectRunState": "projection over an already-validated event log: it reports a state and any anomalies, and grants nothing. Its refusal behaviour (TERMINAL is absorbing; a later event is reported, not folded away) is covered by src/run.test.ts",
  "@getsimpledirect/vinci-run.terminalEvidenceMissing": "projection over an already-validated event log: it reports which announced artifacts were never persisted. It withholds nothing and permits nothing",
  // vinci-oracle-records. The four digest functions and their two helpers are
  // IDENTITY, not authority, on the same terms as vinci-run's: each validates
  // first and THROWS rather than digesting an invalid record. The four
  // DECISIONS this package makes -- admission, idempotency, citation
  // resolution and manifest binding -- are probed in AUTHORITY_GUARDS above,
  // in every argument position, each with a positive control.
  "@getsimpledirect/vinci-oracle-records.attestedEnvelopeDigest": "identity, not authority: validates and throws rather than digesting an invalid envelope",
  "@getsimpledirect/vinci-oracle-records.researchRequestDigest": "identity, not authority: validates and throws rather than digesting an invalid request. What an admitted request MEANS is decided by admitResearchRequest, which is probed",
  "@getsimpledirect/vinci-oracle-records.oracleContextBindingDigest": "identity, not authority: validates and throws rather than digesting an invalid context binding",
  "@getsimpledirect/vinci-oracle-records.sourceRecordDigest": "identity, not authority: validates and throws rather than digesting an invalid source record",
  "@getsimpledirect/vinci-oracle-records.sourceCitationDigest": "identity, not authority: validates and throws rather than digesting an invalid citation. Whether that citation RESOLVES is decided by resolveCitations, which is probed",
  "@getsimpledirect/vinci-oracle-records.digestValidated": "takes an already-computed ValidationResult and throws unless it is ok; the shared body of the digest functions above, not a decision of its own",
  "@getsimpledirect/vinci-oracle-records.sha256Hex": "pure hash of a string; no input shape can make it answer a question",
  "@getsimpledirect/vinci-oracle-records.deliveredHandle": "projection over an already-validated source record: it copies the four identity fields a citation may refer to and grants nothing. Whether a handle resolves is resolveCitations' decision",
  "@getsimpledirect/vinci-oracle-records.parseOracleRecordJson": "strict JSON ingress returning a ValidationResult; it decides only whether a document is unambiguous, and every record it produces still goes through a probed validator",
  "@getsimpledirect/vinci-oracle-records.checkSchemaVersion": "appends an issue to a caller-supplied array and returns nothing; it cannot answer yes. The question it asks is exported as isSupportedSchemaVersion, which IS probed",
  "@getsimpledirect/vinci-oracle-records.claimRecordDigest": "identity, not authority: validates and throws rather than digesting an invalid claim",
  "@getsimpledirect/vinci-oracle-records.claimAssessmentDigest": "identity, not authority: validates and throws rather than digesting an invalid assessment. WHICH status an assessment earns is decided by statusForReviewerOutcome, which is probed",
  "@getsimpledirect/vinci-oracle-records.researchReportDigest": "identity, not authority: validates and throws rather than digesting an invalid report",
  "@getsimpledirect/vinci-oracle-records.decisionProposalDigest": "identity, not authority: validates and throws rather than digesting an invalid proposal. Whether a proposal may be carried into a job shape is decided by mapProposalToJobShape, which is probed in both argument positions",
  "@getsimpledirect/vinci-oracle-records.outcomeRecordDigest": "identity, not authority: validates and throws rather than digesting an invalid outcome. Whether an outcome takes an accepted-work credit is decided by resolveOutcomeCredits, which is probed",
  // The FIRST version of this waiver said REP-01 "is asserted in
  // src/render-markdown.test.ts", and that sentence was load-bearing and wrong:
  // the only hostile-prose test there mutated a field that WAS sanitized, so it
  // exercised the path that worked while three unsanitized interpolations
  // shipped. A waiver may not rest on a test's existence. This one rests on a
  // property of the CODE that a probe here could not check anyway: the document
  // is `Rendered[]`, a branded type, and `safe()` is the only way a
  // caller-supplied value becomes one, so an unguarded interpolation does not
  // compile. src/render-markdown.test.ts now also sweeps every string field of
  // a whole render input and requires the line count to be unchanged.
  // REVISED TWICE. The first version rested on a test's existence and the test
  // was exercising the wrong path. The second rested on the injection
  // chokepoint -- true, and it did not cover the defect found next: an unearned
  // SUPPORTED rendered because this function DECIDED THE BINDING itself, which
  // is not an injection question at all. It no longer decides anything: the
  // binding moved to resolveReportBundle, which IS registered as an authority
  // guard above and probed in the argument position that matters. What is left
  // here is formatting, and the two properties below are about formatting.
  "@getsimpledirect/vinci-oracle-records.renderMarkdownReport": "a formatter over records resolveReportBundle has already validated AND BOUND: it decides nothing, and it cannot print a status for an assessment the resolver did not bind, because the resolver returns one only for a BOUND claim. It cannot be probed as a guard because every answer it gives is a string; the binding decision it used to make is probed as resolveReportBundle, and its formatting properties are a compile-time chokepoint (the document is a branded Rendered[], safe() its only producer) plus a behavioural sweep over every string field in src/render-markdown.test.ts",
  "@getsimpledirect/vinci-oracle-records.outcomeCreditAnchor": "projection over an already-validated outcome: it returns the work ref the record CLAIMS and grants nothing. It is NOT the anchor -- the anchor is the authorizedWork argument resolveOutcomeCredits takes from host state, and this function only says which work order a record is claiming so the resolver can look it up. Whether an outcome takes a credit is resolveOutcomeCredits' decision, which is probed in both argument positions",
  "@getsimpledirect/vinci-oracle-records.runTerminalLabel": "total projection over an already-validated report's run terminal: it names the run-events vocabulary member the record carries and decides nothing",
};

/**
 * Per-entry waivers and yes-detection.
 *
 * Both of these were keyed by `pkg.export`, which is not a unique identity:
 * AUTHORITY_GUARDS holds TWO entries for evidence.isProvenanceConsistent, one
 * feeding hostile input to the PROVENANCE argument and one to the ACTOR
 * argument. An accessor-shaped object is legitimate only in the actor position,
 * yet a name-keyed waiver excused both — so a regression returning true for an
 * object-valued PROVENANCE would have been concealed by a waiver written for a
 * different argument entirely. Identity is now the entry's unique `label`.
 *
 * `isYes` exists because "granted a yes" is not always `=== true`. plainActor
 * returns a snapshot object or null, so the `value === true` check could never
 * fire for it and its nineteen hostile probes were INERT — running, passing,
 * and testing nothing. For that guard a yes is a non-null snapshot.
 */
/**
 * What counts as a guard "granting a yes", uniformly.
 *
 * Anything that is not `false`, `null` or `undefined`. Not a per-guard list,
 * and the difference matters: this WAS a name list, it named plainActor, and it
 * missed terminalStateOfVerification — which returns a TerminalState string, so
 * `value === true` could never fire and all nineteen of its hostile probes were
 * inert. Running, passing, testing nothing.
 *
 * That is the second time this exact defect has appeared. The first fix added
 * one name to a list, which closed the instance and left the class open for
 * whichever guard was registered next. A rule that reads the value rather than
 * the guard's name cannot go stale when someone adds a guard, which is the only
 * property that has actually held anywhere in this repository.
 *
 * Erring toward counting things as a yes is the safe direction: it can only
 * produce a false failure that a human then examines, never a silent pass.
 */
function grantsYes(value) {
  return value !== false && value !== null && value !== undefined;
}

/**
 * label -> hostile shapes that guard may legitimately accept.
 *
 * An accessor is not hostile to a guard that snapshots through toPlainRecord:
 * serialization invokes the getter exactly once and stores the result as data,
 * so there is no second read for it to answer differently, and the validator
 * accepts the same value. The waiver is per-ARGUMENT-POSITION, never per name.
 */
const LEGITIMATE_SHAPES = {
  // A snapshot version is itself a number. The generic numeric probe (7) is
  // legitimate in the candidate position and is newer than the fixed 1.
  "isSnapshotNewer(candidate, currentVersion)": ["a number"],
  "plainActor(actor)": ["an object whose kind is an accessor"],
  "actorFieldsAreConsistent(actor)": ["an object whose kind is an accessor"],
  "isProvenanceConsistent('worker_provided', actor)": ["an object whose kind is an accessor"],
  // Deliberately absent: "isProvenanceConsistent(provenance, actor)", whose
  // hostile input lands in the PROVENANCE argument, where an object is never
  // legitimate.
};

/** Hostile scalars, arrays and prototype tricks a guard must survive. */
function hostileValues() {
  const sneakyEvery = [];
  sneakyEvery.every = () => true;
  sneakyEvery.length = 3;
  return [
    ["inherited name toString", "toString"],
    ["inherited name constructor", "constructor"],
    ["inherited name valueOf", "valueOf"],
    ["inherited name __proto__", "__proto__"],
    ["null", null],
    ["undefined", undefined],
    ["a number", 7],
    ["a symbol", Symbol("owner")],
    ["a null-prototype object", Object.create(null)],
    ["a throwing-get proxy", new Proxy({}, { get() { throw new Error("trap"); } })],
    ["an object with throwing toString", { toString() { throw new Error("ts"); } }],
    // Array containers: the vacuous pass arrived through these.
    ["a sparse array new Array(1)", new Array(1)],
    ["a sparse array new Array(5)", new Array(5)],
    ["an array with its own every()", sneakyEvery],
    ["an array of one inherited-status object", [Object.create({ status: "supported" })]],
    ["an array of one throwing getter", [{ get status() { throw new Error("g"); } }]],
    ["a proxy array with throwing length", new Proxy([], { get(t, k) { if (k === "length") throw new Error("len"); return t[k]; } })],
    ["a proxy array with throwing gOPD", new Proxy([{}], { getOwnPropertyDescriptor() { throw new Error("gopd"); } })],
    ["an array claiming a huge length", Object.assign([], { length: 2 ** 32 - 1 })],
    // No own keys at all; everything on the prototype. This one reversed
    // actorFieldsAreConsistent's answer.
    ["an object whose fields are all inherited", Object.create({ kind: "verifier", verifierId: "v", independent: true })],
    ["an object whose kind is an accessor", { get kind() { return "worker"; }, workerId: "w" }],
  ];
}

let checked = 0;
let validators = 0;
let guardProbes = 0;
let failed = false;
const skipped = [];

for (const { dir, name: pkg } of packages) {
  const entry = join(root, "packages", dir, "dist", "index.js");
  if (!existsSync(entry)) {
    skipped.push(pkg);
    continue;
  }
  const mod = await import(pathToFileURL(entry).href);
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value !== "function" || !/^validate/.test(name)) continue;
    validators++;
    for (const [shape, hostile] of hostileInputs()) {
      checked++;
      let outcome;
      try {
        const result = value(hostile);
        outcome =
          result && typeof result === "object" && "ok" in result
            ? result.ok
              ? "ACCEPTED"
              : "rejected"
            : "not-a-ValidationResult";
      } catch (error) {
        outcome = `THREW: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (outcome !== "rejected") {
        console.error(`  ${pkg}.${name} on ${shape}: ${outcome} — expected a fail-closed rejection`);
        failed = true;
      }
    }
  }
}

// --- authority guards -------------------------------------------------------
for (const guard of AUTHORITY_GUARDS) {
  const dir = packageDirs.get(guard.pkg);
  if (dir === undefined) {
    console.error(`  ${guard.pkg}.${guard.export}: package is not present — the registry is stale`);
    failed = true;
    continue;
  }
  const entry = join(root, "packages", dir, "dist", "index.js");
  if (!existsSync(entry)) continue;
  const mod = await import(pathToFileURL(entry).href);
  if (guard.pkg === "@getsimpledirect/vinci-oracle-records") bindOracleBoundClaim(mod);
  const fn = mod[guard.export];
  if (typeof fn !== "function") {
    console.error(`  ${guard.pkg}.${guard.export}: not exported — the registry is stale`);
    failed = true;
    continue;
  }
  // Positive control FIRST. A guard that denies everything passes every
  // hostile case below, so without this the whole section proves nothing.
  let controlHeld = false;
  try {
    controlHeld = guard.control(fn) === true;
  } catch (error) {
    console.error(`  ${guard.label}: positive control THREW: ${error?.message ?? error}`);
  }
  if (!controlHeld) {
    console.error(`  ${guard.label}: POSITIVE CONTROL FAILED — guard denies legitimate input`);
    failed = true;
  }
  for (const [shape, hostile] of hostileValues()) {
    guardProbes++;
    let value;
    let threw;
    try {
      value = guard.call(fn, hostile);
      threw = undefined;
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error);
    }

    // THE AUTHORITY PROPERTY: hostile input must never yield a yes. Waived
    // ONLY where the shape is not actually hostile to that guard — see
    // SNAPSHOTTING_GUARDS. Never waived for a shape that can lie twice.
    const legitimate = (LEGITIMATE_SHAPES[guard.label] ?? []).includes(shape);
    const grantedYes = threw === undefined && grantsYes(value);
    if (threw === undefined && grantedYes && !legitimate) {
      console.error(`  ${guard.label} on ${shape}: granted a yes (${JSON.stringify(value)}) — hostile input must be refused`);
      failed = true;
    }
    // The robustness property: a guard must refuse hostile input, not throw.
    if (threw !== undefined) {
      console.error(`  ${guard.label} on ${shape}: THREW: ${threw} — a guard must refuse, not throw`);
      failed = true;
    }
  }
}

// --- entry labels must be unique, since waivers are keyed by them ---
const labelCounts = new Map();
for (const guard of AUTHORITY_GUARDS) {
  labelCounts.set(guard.label, (labelCounts.get(guard.label) ?? 0) + 1);
}
for (const [label, count] of labelCounts) {
  if (count > 1) {
    console.error(`  duplicate guard label ${JSON.stringify(label)} (x${count}) — waivers are keyed by label`);
    failed = true;
  }
}
for (const label of Object.keys(LEGITIMATE_SHAPES)) {
  if (!labelCounts.has(label)) {
    console.error(`  LEGITIMATE_SHAPES names ${JSON.stringify(label)}, which is not a registered guard label`);
    failed = true;
  }
}

// --- the registry must not silently shrink ---------------------------------
// Package-QUALIFIED, because two packages may export the same name. A bare
// name meant registering (or waiving) one package's export silently covered
// another's — the same identity confusion that lets a check claim coverage it
// does not have.
// TWO sets, because the two questions are different. Required-guard coverage is
// per PROBE (a function probed in two argument positions needs both), while the
// triage sweep asks only whether a given EXPORT is accounted for at all.
const registeredLabels = new Set(AUTHORITY_GUARDS.map((g) => g.label));
const registeredExports = new Set(AUTHORITY_GUARDS.map((g) => `${g.pkg}.${g.export}`));
for (const name of REQUIRED_GUARDS) {
  if (!registeredLabels.has(name)) {
    console.error(`  ${name} is required to be an authority guard but is not in the registry`);
    failed = true;
  }
}

// --- every exported function must be triaged --------------------------------
for (const { dir, name: pkg } of packages) {
  const entry = join(root, "packages", dir, "dist", "index.js");
  if (!existsSync(entry)) continue;
  const mod = await import(pathToFileURL(entry).href);
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value !== "function") continue;
    if (/^validate/.test(name)) continue;
    if (registeredExports.has(`${pkg}.${name}`)) continue;
    if (Object.hasOwn(NOT_AUTHORITY_GUARDS, `${pkg}.${name}`)) continue;
    console.error(
      `  ${pkg}.${name} is exported but neither probed nor listed in NOT_AUTHORITY_GUARDS — `
        + "add it to the registry or say why it is not a guard",
    );
    failed = true;
  }
}

// Pollution would be global and silent, so check the actual consequence too.
if ({}.polluted !== undefined) {
  console.error("  Object.prototype was polluted while running this check");
  failed = true;
}

if (skipped.length > 0) {
  // Never let an unbuilt package read as a clean pass.
  console.error(`  not built, so NOT CHECKED: ${skipped.join(", ")}`);
  failed = true;
}

// Never print a success summary on a run that failed. A green-sounding line
// under a list of errors is how a failing check gets read as a passing one.
if (failed) {
  console.error(
    `  FAILED: ${validators} validators x ${checked / (validators || 1)} shapes, plus ${guardProbes} authority-guard probes; see above`,
  );
  process.exit(1);
}
console.log(
  `  ${validators} validators x ${checked / (validators || 1)} shapes = ${checked} probes, plus ${guardProbes} authority-guard probes with positive controls — none granted a yes`,
);
