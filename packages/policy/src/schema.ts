import {
  fail,
  ok,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@vinci/contracts";
import {
  POLICY_ALLOWED_REASON_CODES,
  POLICY_DECISION_OPTION_KINDS,
  POLICY_DENIED_REASON_CODES,
  POLICY_UNDETERMINED_REASON_CODES,
  type PolicyDecision,
} from "./decision.ts";
import {
  CREDENTIAL_LIFETIMES,
  DNS_POLICIES,
  EXTERNAL_SIDE_EFFECT_CLASSES,
  NETWORK_PROTOCOLS,
  POLICY_MANIFEST_SECTION_NAMES,
  PRIVATE_NETWORK_ACCESS_POLICIES,
  RETENTION_CLASSES,
  SYMLINK_HANDLING,
  type PolicyManifest,
} from "./manifest.ts";

export const POLICY_MANIFEST_SCHEMA_META = {
  id: "vinci.policy-manifest",
  version: 1,
  compatibility: "additive-only",
  /**
   * Preserved everywhere except under `/credentials`, where an unrecognised
   * field is rejected because it may be secret material. See
   * `strictObjectValue` and docs/E0-decisions.md D4.
   */
  unknownFields: "preserve",
  malformedData: "fail-closed",
  migration: "none",
} as const satisfies SchemaMeta;

export const POLICY_DECISION_SCHEMA_META = {
  id: "vinci.policy-decision",
  version: 1,
  compatibility: "additive-only",
  unknownFields: "preserve",
  malformedData: "fail-closed",
  migration: "none",
} as const satisfies SchemaMeta;

type JsonObject = Record<string, unknown>;
type UnknownFields = Record<string, unknown>;

const CREDENTIAL_MATERIAL_FIELD_NAMES = [
  "secret",
  "secretValue",
  "value",
  "token",
  "accessToken",
  "refreshToken",
  "password",
  "apiKey",
  "privateKey",
  "credential",
  "credentialValue",
  "material",
] as const;

function pointer(path: string, field: string): string {
  const escaped = field.replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${escaped}`;
}

function addIssue(
  issues: ValidationIssue[],
  path: string,
  code: string,
  message: string,
): void {
  issues.push({ path: path || "/", code, message });
}

function objectValue(
  value: unknown,
  path: string,
  knownFields: readonly string[],
  issues: ValidationIssue[],
  unknownFields: UnknownFields,
): JsonObject | undefined {
  if (value === undefined) {
    addIssue(issues, path, "required_field", `${path.slice(path.lastIndexOf("/") + 1)} is required`);
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    addIssue(issues, path, "invalid_type", "expected an object");
    return undefined;
  }
  const result = value as JsonObject;
  const known = new Set(knownFields);
  for (const [field, fieldValue] of Object.entries(result)) {
    if (!known.has(field)) unknownFields[pointer(path, field)] = fieldValue;
  }
  return result;
}

/**
 * Like `objectValue`, but REJECTS unrecognised fields instead of preserving
 * them.
 *
 * This is the second exception to D4's "unknown fields are preserved" rule,
 * and it exists only under `/credentials`. Everywhere else, preserving an
 * unknown field is right: it lets an older consumer round-trip a newer
 * producer's record without losing data.
 *
 * Under `/credentials` it is exactly backwards. An unrecognised field there
 * may be secret material, and preserving it puts the secret inside a record
 * that FR-6.5 says is exported and SR-3 says must never carry secrets — so
 * preserving is strictly worse than dropping, and dropping is worse than
 * refusing the policy outright.
 *
 * A denylist of known secret-ish names cannot do this job. It is only as good
 * as the imagination of whoever wrote it, and misses `clientSecret`,
 * `secretAccessKey`, `connectionString` and every name a future provider
 * invents. An allowlist fails closed on all of them by construction.
 */
function strictObjectValue(
  value: unknown,
  path: string,
  knownFields: readonly string[],
  issues: ValidationIssue[],
): JsonObject | undefined {
  if (value === undefined) {
    addIssue(issues, path, "required_field", `${path.slice(path.lastIndexOf("/") + 1)} is required`);
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    addIssue(issues, path, "invalid_type", "expected an object");
    return undefined;
  }
  const result = value as JsonObject;
  const known = new Set(knownFields);
  for (const field of Object.keys(result)) {
    if (known.has(field)) continue;
    addIssue(
      issues,
      pointer(path, field),
      "credential_material_forbidden",
      "unrecognised field in a credential section; policies may contain references and safe metadata only, and an unknown field here may be secret material",
    );
  }
  return result;
}

function requiredString(value: unknown, path: string, issues: ValidationIssue[]): value is string {
  if (value === undefined) {
    addIssue(issues, path, "required_field", `${path.slice(path.lastIndexOf("/") + 1)} is required`);
    return false;
  }
  if (typeof value !== "string" || value.length === 0) {
    addIssue(issues, path, "invalid_string", "expected a non-empty string");
    return false;
  }
  return true;
}

function requiredBoolean(value: unknown, path: string, issues: ValidationIssue[]): value is boolean {
  if (value === undefined) {
    addIssue(issues, path, "required_field", `${path.slice(path.lastIndexOf("/") + 1)} is required`);
    return false;
  }
  if (typeof value !== "boolean") {
    addIssue(issues, path, "invalid_type", "expected a boolean");
    return false;
  }
  return true;
}

function nonNegativeInteger(value: unknown, path: string, issues: ValidationIssue[]): value is number {
  if (value === undefined) {
    addIssue(issues, path, "required_field", `${path.slice(path.lastIndexOf("/") + 1)} is required`);
    return false;
  }
  if (!Number.isInteger(value) || (value as number) < 0) {
    addIssue(issues, path, "invalid_integer", "expected a non-negative integer");
    return false;
  }
  return true;
}

function positiveInteger(value: unknown, path: string, issues: ValidationIssue[]): value is number {
  if (value === undefined) {
    addIssue(issues, path, "required_field", `${path.slice(path.lastIndexOf("/") + 1)} is required`);
    return false;
  }
  if (!Number.isInteger(value) || (value as number) < 1) {
    addIssue(issues, path, "invalid_integer", "expected a positive integer");
    return false;
  }
  return true;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  path: string,
  issues: ValidationIssue[],
): value is T[number] {
  if (value === undefined) {
    addIssue(issues, path, "required_field", `${path.slice(path.lastIndexOf("/") + 1)} is required`);
    return false;
  }
  if (typeof value !== "string" || !values.includes(value)) {
    addIssue(issues, path, "invalid_enum", `expected one of: ${values.join(", ")}`);
    return false;
  }
  return true;
}

function stringArray(value: unknown, path: string, issues: ValidationIssue[]): value is readonly string[] {
  if (!Array.isArray(value)) {
    addIssue(
      issues,
      path,
      value === undefined ? "required_field" : "invalid_type",
      value === undefined ? `${path.slice(path.lastIndexOf("/") + 1)} is required` : "expected an array",
    );
    return false;
  }
  let valid = true;
  value.forEach((entry, index) => {
    if (!requiredString(entry, pointer(path, String(index)), issues)) valid = false;
  });
  return valid;
}

function enumArray<const T extends readonly string[]>(
  value: unknown,
  values: T,
  path: string,
  issues: ValidationIssue[],
): value is readonly T[number][] {
  if (!Array.isArray(value)) {
    addIssue(
      issues,
      path,
      value === undefined ? "required_field" : "invalid_type",
      value === undefined ? `${path.slice(path.lastIndexOf("/") + 1)} is required` : "expected an array",
    );
    return false;
  }
  let valid = true;
  value.forEach((entry, index) => {
    if (!enumValue(entry, values, pointer(path, String(index)), issues)) valid = false;
  });
  return valid;
}

function objectArray(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  visit: (entry: unknown, entryPath: string) => void,
): void {
  if (!Array.isArray(value)) {
    addIssue(
      issues,
      path,
      value === undefined ? "required_field" : "invalid_type",
      value === undefined ? `${path.slice(path.lastIndexOf("/") + 1)} is required` : "expected an array",
    );
    return;
  }
  value.forEach((entry, index) => visit(entry, pointer(path, String(index))));
}

function validateResources(
  value: unknown,
  issues: ValidationIssue[],
  unknown: UnknownFields,
): void {
  const path = "/resources";
  const object = objectValue(
    value,
    path,
    ["allowedKinds", "maximumCpuCores", "maximumMemoryBytes", "maximumStorageBytes"],
    issues,
    unknown,
  );
  if (!object) return;
  stringArray(object.allowedKinds, `${path}/allowedKinds`, issues);
  nonNegativeInteger(object.maximumCpuCores, `${path}/maximumCpuCores`, issues);
  nonNegativeInteger(object.maximumMemoryBytes, `${path}/maximumMemoryBytes`, issues);
  nonNegativeInteger(object.maximumStorageBytes, `${path}/maximumStorageBytes`, issues);
}

function validateFilesystem(
  value: unknown,
  issues: ValidationIssue[],
  unknown: UnknownFields,
): void {
  const path = "/filesystem";
  const object = objectValue(
    value,
    path,
    [
      "readOnlyRoots",
      "writableRoots",
      "deniedRoots",
      "temporaryWorkspace",
      "protectedPaths",
      "maximumChangedFileCount",
      "maximumChangedByteVolume",
      "symlinkHandling",
      "generatedArtifactPaths",
    ],
    issues,
    unknown,
  );
  if (!object) return;
  stringArray(object.readOnlyRoots, `${path}/readOnlyRoots`, issues);
  stringArray(object.writableRoots, `${path}/writableRoots`, issues);
  stringArray(object.deniedRoots, `${path}/deniedRoots`, issues);
  requiredString(object.temporaryWorkspace, `${path}/temporaryWorkspace`, issues);
  stringArray(object.protectedPaths, `${path}/protectedPaths`, issues);
  nonNegativeInteger(object.maximumChangedFileCount, `${path}/maximumChangedFileCount`, issues);
  nonNegativeInteger(object.maximumChangedByteVolume, `${path}/maximumChangedByteVolume`, issues);
  enumValue(object.symlinkHandling, SYMLINK_HANDLING, `${path}/symlinkHandling`, issues);
  stringArray(object.generatedArtifactPaths, `${path}/generatedArtifactPaths`, issues);
}

function validateApplications(
  value: unknown,
  issues: ValidationIssue[],
  unknown: UnknownFields,
): void {
  const path = "/applications";
  const object = objectValue(
    value,
    path,
    ["defaultAction", "allowedApplications", "deniedApplications"],
    issues,
    unknown,
  );
  if (!object) return;
  enumValue(object.defaultAction, ["deny"] as const, `${path}/defaultAction`, issues);
  stringArray(object.allowedApplications, `${path}/allowedApplications`, issues);
  stringArray(object.deniedApplications, `${path}/deniedApplications`, issues);
}

function validateNetwork(value: unknown, issues: ValidationIssue[], unknown: UnknownFields): void {
  const path = "/network";
  if (value === undefined) {
    addIssue(
      issues,
      path,
      "required_field",
      "network is required; absence never grants network access",
    );
    return;
  }
  const object = objectValue(
    value,
    path,
    [
      "defaultAction",
      "allowedDomains",
      "allowedIpRanges",
      "allowedProtocols",
      "dnsPolicy",
      "maximumOutboundRequests",
      "privateNetworkAccess",
      "noNetwork",
    ],
    issues,
    unknown,
  );
  if (!object) return;
  enumValue(object.defaultAction, ["deny"] as const, `${path}/defaultAction`, issues);
  stringArray(object.allowedDomains, `${path}/allowedDomains`, issues);
  stringArray(object.allowedIpRanges, `${path}/allowedIpRanges`, issues);
  enumArray(object.allowedProtocols, NETWORK_PROTOCOLS, `${path}/allowedProtocols`, issues);
  enumValue(object.dnsPolicy, DNS_POLICIES, `${path}/dnsPolicy`, issues);
  nonNegativeInteger(object.maximumOutboundRequests, `${path}/maximumOutboundRequests`, issues);
  enumValue(
    object.privateNetworkAccess,
    PRIVATE_NETWORK_ACCESS_POLICIES,
    `${path}/privateNetworkAccess`,
    issues,
  );
  requiredBoolean(object.noNetwork, `${path}/noNetwork`, issues);
}

function rejectCredentialMaterial(object: JsonObject, path: string, issues: ValidationIssue[]): void {
  for (const field of CREDENTIAL_MATERIAL_FIELD_NAMES) {
    if (Object.hasOwn(object, field)) {
      addIssue(
        issues,
        pointer(path, field),
        "credential_material_forbidden",
        "credential material is forbidden; policies may contain references and safe metadata only",
      );
    }
  }
}

function validateCredentialBinding(value: unknown, path: string, issues: ValidationIssue[]): void {
  const object = strictObjectValue(value, path, ["kind", "runId", "capability"], issues);
  if (!object) return;
  if (!enumValue(object.kind, ["run", "capability"] as const, `${path}/kind`, issues)) return;
  if (object.kind === "run") requiredString(object.runId, `${path}/runId`, issues);
  if (object.kind === "capability") requiredString(object.capability, `${path}/capability`, issues);
}

function validateCredentialReference(value: unknown, path: string, issues: ValidationIssue[]): void {
  const object = strictObjectValue(
    value,
    path,
    ["credentialId", "issuer", "scopes", "revocable", "lifetime", "boundTo", "expiresAt"],
    issues,
  );
  if (!object) return;
  rejectCredentialMaterial(object, path, issues);
  requiredString(object.credentialId, `${path}/credentialId`, issues);
  requiredString(object.issuer, `${path}/issuer`, issues);
  stringArray(object.scopes, `${path}/scopes`, issues);
  if (object.revocable !== true) {
    addIssue(issues, `${path}/revocable`, "invalid_literal", "credential references must be revocable");
  }
  const lifetimeValid = enumValue(object.lifetime, CREDENTIAL_LIFETIMES, `${path}/lifetime`, issues);
  validateCredentialBinding(object.boundTo, `${path}/boundTo`, issues);
  if (lifetimeValid && object.lifetime === "short_lived") {
    requiredString(object.expiresAt, `${path}/expiresAt`, issues);
  } else if (object.expiresAt !== undefined) {
    requiredString(object.expiresAt, `${path}/expiresAt`, issues);
  }
}

function validateCredentials(value: unknown, issues: ValidationIssue[]): void {
  const path = "/credentials";
  const object = strictObjectValue(value, path, ["references"], issues);
  if (!object) return;
  rejectCredentialMaterial(object, path, issues);
  objectArray(object.references, `${path}/references`, issues, (entry, entryPath) => {
    validateCredentialReference(entry, entryPath, issues);
  });
}

function validateExternalSideEffects(
  value: unknown,
  issues: ValidationIssue[],
  unknown: UnknownFields,
): void {
  const path = "/external_side_effects";
  const object = objectValue(value, path, ["defaultAction", "rules"], issues, unknown);
  if (!object) return;
  enumValue(
    object.defaultAction,
    ["require_approval"] as const,
    `${path}/defaultAction`,
    issues,
  );
  objectArray(object.rules, `${path}/rules`, issues, (entry, entryPath) => {
    const rule = objectValue(entry, entryPath, ["actionClass", "approval"], issues, unknown);
    if (!rule) return;
    enumValue(rule.actionClass, EXTERNAL_SIDE_EFFECT_CLASSES, `${entryPath}/actionClass`, issues);
    enumValue(rule.approval, ["required", "denied"] as const, `${entryPath}/approval`, issues);
  });
}

function validateMoney(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  unknown: UnknownFields,
): void {
  const object = objectValue(value, path, ["currency", "minorUnits"], issues, unknown);
  if (!object) return;
  if (requiredString(object.currency, `${path}/currency`, issues) && !/^[A-Z]{3}$/.test(object.currency)) {
    addIssue(issues, `${path}/currency`, "invalid_currency", "expected a three-letter uppercase currency code");
  }
  nonNegativeInteger(object.minorUnits, `${path}/minorUnits`, issues);
}

function validateSpend(value: unknown, issues: ValidationIssue[], unknown: UnknownFields): void {
  const path = "/spend";
  const object = objectValue(
    value,
    path,
    ["maximumSpend", "maximumVerificationCost"],
    issues,
    unknown,
  );
  if (!object) return;
  validateMoney(object.maximumSpend, `${path}/maximumSpend`, issues, unknown);
  validateMoney(object.maximumVerificationCost, `${path}/maximumVerificationCost`, issues, unknown);
}

function validateRuntime(value: unknown, issues: ValidationIssue[], unknown: UnknownFields): void {
  const path = "/runtime";
  const fields = [
    "maximumActiveRuntimeSeconds",
    "maximumWallClockRuntimeSeconds",
    "maximumModelCalls",
    "maximumWorkerCount",
    "maximumExternalActions",
  ] as const;
  const object = objectValue(value, path, fields, issues, unknown);
  if (!object) return;
  for (const field of fields) nonNegativeInteger(object[field], `${path}/${field}`, issues);
}

function validateRetries(value: unknown, issues: ValidationIssue[], unknown: UnknownFields): void {
  const path = "/retries";
  const object = objectValue(value, path, ["maximumRetries"], issues, unknown);
  if (!object) return;
  nonNegativeInteger(object.maximumRetries, `${path}/maximumRetries`, issues);
}

function validateApprovalTarget(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  unknown: UnknownFields,
): void {
  const object = objectValue(value, path, ["kind", "capability", "actionClass"], issues, unknown);
  if (!object) return;
  if (
    !enumValue(
      object.kind,
      ["any_action", "capability", "external_side_effect"] as const,
      `${path}/kind`,
      issues,
    )
  ) return;
  if (object.kind === "capability") requiredString(object.capability, `${path}/capability`, issues);
  if (object.kind === "external_side_effect") {
    enumValue(object.actionClass, EXTERNAL_SIDE_EFFECT_CLASSES, `${path}/actionClass`, issues);
  }
}

function validateApprovalRequirement(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  unknown: UnknownFields,
): void {
  const object = objectValue(value, path, ["kind", "userId", "role", "eligible"], issues, unknown);
  if (!object) return;
  if (
    !enumValue(object.kind, ["named_person", "role", "two_people"] as const, `${path}/kind`, issues)
  ) return;
  if (object.kind === "named_person") requiredString(object.userId, `${path}/userId`, issues);
  if (object.kind === "role") requiredString(object.role, `${path}/role`, issues);
  if (object.kind === "two_people") {
    const eligiblePath = `${path}/eligible`;
    const eligible = objectValue(object.eligible, eligiblePath, ["kind", "role"], issues, unknown);
    if (!eligible) return;
    if (!enumValue(eligible.kind, ["any_user", "role"] as const, `${eligiblePath}/kind`, issues)) return;
    if (eligible.kind === "role") requiredString(eligible.role, `${eligiblePath}/role`, issues);
  }
}

function validateApprovalGrant(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  unknown: UnknownFields,
): void {
  const object = objectValue(
    value,
    path,
    ["kind", "expiresAfterSeconds", "resource", "maximumDurationSeconds"],
    issues,
    unknown,
  );
  if (!object) return;
  if (
    !enumValue(object.kind, ["once", "remainder_of_run", "bounded"] as const, `${path}/kind`, issues)
  ) return;
  positiveInteger(object.expiresAfterSeconds, `${path}/expiresAfterSeconds`, issues);
  if (object.kind === "bounded") {
    requiredString(object.resource, `${path}/resource`, issues);
    positiveInteger(object.maximumDurationSeconds, `${path}/maximumDurationSeconds`, issues);
  }
}

function validateApprovalDecision(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  unknown: UnknownFields,
): void {
  const object = objectValue(value, path, ["kind", "approver", "grant"], issues, unknown);
  if (!object) return;
  if (
    !enumValue(
      object.kind,
      ["allow_automatically", "deny", "require_approval"] as const,
      `${path}/kind`,
      issues,
    )
  ) return;
  if (object.kind === "require_approval") {
    validateApprovalRequirement(object.approver, `${path}/approver`, issues, unknown);
    validateApprovalGrant(object.grant, `${path}/grant`, issues, unknown);
  }
}

function validateApprovals(value: unknown, issues: ValidationIssue[], unknown: UnknownFields): void {
  const path = "/approvals";
  const object = objectValue(value, path, ["rules"], issues, unknown);
  if (!object) return;
  objectArray(object.rules, `${path}/rules`, issues, (entry, entryPath) => {
    const rule = objectValue(
      entry,
      entryPath,
      ["id", "description", "appliesTo", "decision"],
      issues,
      unknown,
    );
    if (!rule) return;
    requiredString(rule.id, `${entryPath}/id`, issues);
    requiredString(rule.description, `${entryPath}/description`, issues);
    validateApprovalTarget(rule.appliesTo, `${entryPath}/appliesTo`, issues, unknown);
    validateApprovalDecision(rule.decision, `${entryPath}/decision`, issues, unknown);
  });
}

function validateVerification(
  value: unknown,
  issues: ValidationIssue[],
  unknown: UnknownFields,
): void {
  const path = "/verification";
  const object = objectValue(
    value,
    path,
    ["required", "requirements", "independentVerifierRequired"],
    issues,
    unknown,
  );
  if (!object) return;
  requiredBoolean(object.required, `${path}/required`, issues);
  stringArray(object.requirements, `${path}/requirements`, issues);
  requiredBoolean(object.independentVerifierRequired, `${path}/independentVerifierRequired`, issues);
}

function validateRetention(value: unknown, issues: ValidationIssue[], unknown: UnknownFields): void {
  const path = "/retention";
  const object = objectValue(value, path, ["class"], issues, unknown);
  if (!object) return;
  enumValue(object.class, RETENTION_CLASSES, `${path}/class`, issues);
}

export function validatePolicyManifest(input: unknown): ValidationResult<PolicyManifest> {
  const issues: ValidationIssue[] = [];
  const unknownFields: UnknownFields = {};
  const fields = [
    "policyId",
    "version",
    "displayName",
    ...POLICY_MANIFEST_SECTION_NAMES,
  ] as const;
  const object = objectValue(input, "", fields, issues, unknownFields);
  if (!object) return fail(issues);

  requiredString(object.policyId, "/policyId", issues);
  positiveInteger(object.version, "/version", issues);
  requiredString(object.displayName, "/displayName", issues);
  validateResources(object.resources, issues, unknownFields);
  validateFilesystem(object.filesystem, issues, unknownFields);
  validateApplications(object.applications, issues, unknownFields);
  validateNetwork(object.network, issues, unknownFields);
  validateCredentials(object.credentials, issues);
  validateExternalSideEffects(object.external_side_effects, issues, unknownFields);
  validateSpend(object.spend, issues, unknownFields);
  validateRuntime(object.runtime, issues, unknownFields);
  validateRetries(object.retries, issues, unknownFields);
  validateApprovals(object.approvals, issues, unknownFields);
  validateVerification(object.verification, issues, unknownFields);
  validateRetention(object.retention, issues, unknownFields);

  if (issues.length > 0) return fail(issues);
  // The input object itself is returned: unknown fields remain byte-for-byte the
  // same values in addition to being indexed for deliberate round-tripping.
  return ok(input as PolicyManifest, unknownFields);
}

function validateActor(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  unknown: UnknownFields,
): void {
  const object = objectValue(
    value,
    path,
    [
      "kind",
      "userId",
      "deviceId",
      "workerId",
      "policyId",
      "policyVersion",
      "component",
      "verifierId",
      "independent",
    ],
    issues,
    unknown,
  );
  if (!object) return;
  if (
    !enumValue(
      object.kind,
      ["user", "worker", "policy", "system", "verifier"] as const,
      `${path}/kind`,
      issues,
    )
  ) return;
  switch (object.kind) {
    case "user":
      requiredString(object.userId, `${path}/userId`, issues);
      if (object.deviceId !== undefined) requiredString(object.deviceId, `${path}/deviceId`, issues);
      break;
    case "worker":
      requiredString(object.workerId, `${path}/workerId`, issues);
      break;
    case "policy":
      requiredString(object.policyId, `${path}/policyId`, issues);
      positiveInteger(object.policyVersion, `${path}/policyVersion`, issues);
      break;
    case "system":
      requiredString(object.component, `${path}/component`, issues);
      break;
    case "verifier":
      requiredString(object.verifierId, `${path}/verifierId`, issues);
      requiredBoolean(object.independent, `${path}/independent`, issues);
      break;
  }
}

function validateDecisionRequest(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  unknown: UnknownFields,
): void {
  const object = objectValue(value, path, ["action", "description", "target", "requestedBy"], issues, unknown);
  if (!object) return;
  requiredString(object.action, `${path}/action`, issues);
  requiredString(object.description, `${path}/description`, issues);
  if (object.target !== undefined) requiredString(object.target, `${path}/target`, issues);
  validateActor(object.requestedBy, `${path}/requestedBy`, issues, unknown);
}

function validateDecisionReason(
  value: unknown,
  values: readonly string[],
  path: string,
  issues: ValidationIssue[],
  unknown: UnknownFields,
): void {
  const object = objectValue(value, path, ["code", "explanation"], issues, unknown);
  if (!object) return;
  enumValue(object.code, values, `${path}/code`, issues);
  requiredString(object.explanation, `${path}/explanation`, issues);
}

function validatePolicyReference(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  unknown: UnknownFields,
): void {
  const object = objectValue(value, path, ["policyId", "version"], issues, unknown);
  if (!object) return;
  requiredString(object.policyId, `${path}/policyId`, issues);
  positiveInteger(object.version, `${path}/version`, issues);
}

function validateDecisionOptions(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  unknown: UnknownFields,
): void {
  if (!Array.isArray(value)) {
    addIssue(
      issues,
      path,
      value === undefined ? "required_field" : "invalid_type",
      value === undefined ? "availableOptions is required" : "expected an array",
    );
    return;
  }
  if (value.length === 0) {
    addIssue(issues, path, "empty_options", "at least one available option is required");
    return;
  }
  value.forEach((entry, index) => {
    const entryPath = pointer(path, String(index));
    const option = objectValue(entry, entryPath, ["kind", "description"], issues, unknown);
    if (!option) return;
    enumValue(option.kind, POLICY_DECISION_OPTION_KINDS, `${entryPath}/kind`, issues);
    requiredString(option.description, `${entryPath}/description`, issues);
  });
}

export function validatePolicyDecision(input: unknown): ValidationResult<PolicyDecision> {
  const issues: ValidationIssue[] = [];
  const unknownFields: UnknownFields = {};
  const object = objectValue(
    input,
    "",
    ["outcome", "request", "reason", "controllingPolicy", "availableOptions"],
    issues,
    unknownFields,
  );
  if (!object) return fail(issues);
  if (
    !enumValue(object.outcome, ["allowed", "denied", "undetermined"] as const, "/outcome", issues)
  ) return fail(issues);

  validateDecisionRequest(object.request, "/request", issues, unknownFields);
  validatePolicyReference(object.controllingPolicy, "/controllingPolicy", issues, unknownFields);
  if (object.outcome === "allowed") {
    validateDecisionReason(object.reason, POLICY_ALLOWED_REASON_CODES, "/reason", issues, unknownFields);
    if (Object.hasOwn(object, "availableOptions")) {
      addIssue(
        issues,
        "/availableOptions",
        "unexpected_field",
        "availableOptions applies only to non-proceeding decisions",
      );
    }
  } else if (object.outcome === "denied") {
    validateDecisionReason(object.reason, POLICY_DENIED_REASON_CODES, "/reason", issues, unknownFields);
    validateDecisionOptions(object.availableOptions, "/availableOptions", issues, unknownFields);
  } else {
    validateDecisionReason(
      object.reason,
      POLICY_UNDETERMINED_REASON_CODES,
      "/reason",
      issues,
      unknownFields,
    );
    validateDecisionOptions(object.availableOptions, "/availableOptions", issues, unknownFields);
  }

  if (issues.length > 0) return fail(issues);
  return ok(input as PolicyDecision, unknownFields);
}
