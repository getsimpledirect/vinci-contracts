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
  "mayIssue(role, 'pause')",
  "mayIssue('owner', command)",
  "isGrantStrictlyNarrower(a, b)",
  "isDecisionEffective(decision)",
  "canAdvanceDelivery(a, b)",
  "isEffectiveDeliveryState(state)",
  "isOrganizationWorkspace(value)",
  "terminalStateOfVerification(value)",
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
];


/**
 * Exported functions deliberately NOT probed as authority guards, each with a
 * reason. The point is that adding an export forces a decision: a new export
 * that is neither a validator, nor a registered guard, nor listed here fails
 * the gate rather than silently going unexamined.
 */
const NOT_AUTHORITY_GUARDS = {
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
  "@getsimpledirect/vinci-run-events.isRunEventType": "enum membership",
  "@getsimpledirect/vinci-run-events.isCanonicalTimestamp": "pure string/regex predicate",
  "@getsimpledirect/vinci-contracts.isActorKind": "enum membership",
  "@getsimpledirect/vinci-contracts.isRunState": "enum membership",
  "@getsimpledirect/vinci-contracts.isTerminal": "enum membership",
  "@getsimpledirect/vinci-contracts.isTerminalState": "enum membership",
  "@getsimpledirect/vinci-contracts.isVerdictStatus": "enum membership",
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
  "@getsimpledirect/vinci-device-auth.revoke": "state transition over an already-validated record",
  "@getsimpledirect/vinci-session-stream.nextSeqIsValid": "predicate over safe integers; answers whether next is the unused sequence after prev",
  "@getsimpledirect/vinci-worker-capabilities.isTrustLevel": "enum membership",
  "@getsimpledirect/vinci-worker-capabilities.compareTrustLevels": "comparison over members of the ordered trust vocabulary",
  "@getsimpledirect/vinci-worker-capabilities.derivedTrustLevel": "derivation over an already-validated capability matrix",
  "@getsimpledirect/vinci-worker-capabilities.permittedRemoteCommands": "UI projection over an already-validated capability matrix",
  "@getsimpledirect/vinci-worker-capabilities.trustLevelLabel": "total label lookup over the trust vocabulary",
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
