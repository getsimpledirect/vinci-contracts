import {
  fail,
  isCanonicalTimestamp,
  ok,
  type ValidationIssue,
  type ValidationResult,
  toPlainRecord,
} from "@vinci/contracts";
import type { CustomerEndpointConfig } from "./customer-endpoint.ts";
import type { FallbackRecord } from "./fallback.ts";
import type { ModelProvenanceRecord } from "./provenance.ts";
import { RESOLUTION_EVIDENCE } from "./provenance.ts";
import type { ResidencyRecord } from "./residency.ts";
import {
  MODEL_CAPABILITIES,
  MODEL_CLASS_IDS,
  MODEL_PROVIDERS,
  MODEL_REASONING_MODES,
} from "./vocabulary.ts";

type JsonObject = Record<string, unknown>;
type UnknownFields = Record<string, unknown>;

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

function rejectPresentField(
  object: JsonObject,
  field: string,
  path: string,
  issues: ValidationIssue[],
  message: string,
): void {
  if (Object.hasOwn(object, field)) {
    addIssue(issues, pointer(path, field), "unexpected_field", message);
  }
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

/** Credential subtrees are allowlists: preserving an unknown key could export a secret. */
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
      "unrecognised credential field; authentication records may contain references only",
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

function literalOne(value: unknown, path: string, issues: ValidationIssue[]): value is 1 {
  if (value === undefined) {
    addIssue(issues, path, "required_field", `${path.slice(path.lastIndexOf("/") + 1)} is required`);
    return false;
  }
  if (value !== 1) {
    addIssue(issues, path, "invalid_literal", "expected literal value 1");
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

function timestamp(value: unknown, path: string, issues: ValidationIssue[]): value is string {
  if (value === undefined) {
    addIssue(issues, path, "required_field", `${path.slice(path.lastIndexOf("/") + 1)} is required`);
    return false;
  }
  if (!isCanonicalTimestamp(value)) {
    addIssue(
      issues,
      path,
      "invalid_timestamp",
      "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z",
    );
    return false;
  }
  return true;
}

function validateActor(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  unknownFields: UnknownFields,
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
    unknownFields,
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

function validateExplicitValue(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  unknownFields: UnknownFields,
  validateKnown: (known: unknown, knownPath: string) => void,
): void {
  const object = objectValue(value, path, ["kind", "value"], issues, unknownFields);
  if (!object) return;
  if (!enumValue(object.kind, ["known", "unknown"] as const, `${path}/kind`, issues)) return;
  if (object.kind === "known") {
    validateKnown(object.value, `${path}/value`);
  } else if (Object.hasOwn(object, "value")) {
    addIssue(issues, `${path}/value`, "unexpected_field", "an unknown value must not carry a value");
  }
}

function validateProcessingLocation(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  unknownFields: UnknownFields,
): void {
  const object = objectValue(value, path, ["jurisdiction", "region"], issues, unknownFields);
  if (!object) return;
  requiredString(object.jurisdiction, `${path}/jurisdiction`, issues);
  if (object.region !== undefined) requiredString(object.region, `${path}/region`, issues);
}

function validateExplicitLocation(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  unknownFields: UnknownFields,
): void {
  validateExplicitValue(value, path, issues, unknownFields, (known, knownPath) => {
    validateProcessingLocation(known, knownPath, issues, unknownFields);
  });
}

function validateCapabilityProfile(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  unknownFields: UnknownFields,
): void {
  const object = objectValue(
    value,
    path,
    ["capabilities", "contextLimit", "toolSupport"],
    issues,
    unknownFields,
  );
  if (!object) return;
  if (!Array.isArray(object.capabilities)) {
    addIssue(
      issues,
      `${path}/capabilities`,
      object.capabilities === undefined ? "required_field" : "invalid_type",
      object.capabilities === undefined ? "capabilities is required" : "expected an array",
    );
  } else {
    object.capabilities.forEach((capability, index) => {
      enumValue(
        capability,
        MODEL_CAPABILITIES,
        pointer(`${path}/capabilities`, String(index)),
        issues,
      );
    });
  }
  positiveInteger(object.contextLimit, `${path}/contextLimit`, issues);
  requiredBoolean(object.toolSupport, `${path}/toolSupport`, issues);
}

function validateExplicitProvider(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  unknownFields: UnknownFields,
): void {
  validateExplicitValue(value, path, issues, unknownFields, (known, knownPath) => {
    enumValue(known, MODEL_PROVIDERS, knownPath, issues);
  });
}

function validateExplicitString(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  unknownFields: UnknownFields,
): void {
  validateExplicitValue(value, path, issues, unknownFields, (known, knownPath) => {
    requiredString(known, knownPath, issues);
  });
}

function validateFallbackRecordAt(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  unknownFields: UnknownFields,
): void {
  const object = objectValue(
    value,
    path,
    [
      "schemaVersion",
      "runId",
      "recordedAt",
      "recordedBy",
      "outcome",
      "source",
      "destination",
      "policyDecision",
    ],
    issues,
    unknownFields,
  );
  if (!object) return;
  literalOne(object.schemaVersion, `${path}/schemaVersion`, issues);
  requiredString(object.runId, `${path}/runId`, issues);
  timestamp(object.recordedAt, `${path}/recordedAt`, issues);
  validateActor(object.recordedBy, `${path}/recordedBy`, issues, unknownFields);
  const outcomeValid = enumValue(
    object.outcome,
    ["applied", "blocked"] as const,
    `${path}/outcome`,
    issues,
  );

  const source = objectValue(
    object.source,
    `${path}/source`,
    ["provider", "jurisdiction"],
    issues,
    unknownFields,
  );
  if (source) {
    validateExplicitProvider(source.provider, `${path}/source/provider`, issues, unknownFields);
    validateExplicitLocation(source.jurisdiction, `${path}/source/jurisdiction`, issues, unknownFields);
  }

  const destination = objectValue(
    object.destination,
    `${path}/destination`,
    ["provider", "jurisdiction"],
    issues,
    unknownFields,
  );
  if (destination) {
    enumValue(destination.provider, MODEL_PROVIDERS, `${path}/destination/provider`, issues);
    validateProcessingLocation(
      destination.jurisdiction,
      `${path}/destination/jurisdiction`,
      issues,
      unknownFields,
    );
  }

  const policy = objectValue(
    object.policyDecision,
    `${path}/policyDecision`,
    ["permitted", "policyId", "policyVersion", "reasonCode"],
    issues,
    unknownFields,
  );
  if (policy) {
    const permittedValid = requiredBoolean(
      policy.permitted,
      `${path}/policyDecision/permitted`,
      issues,
    );
    requiredString(policy.policyId, `${path}/policyDecision/policyId`, issues);
    positiveInteger(policy.policyVersion, `${path}/policyDecision/policyVersion`, issues);
    requiredString(policy.reasonCode, `${path}/policyDecision/reasonCode`, issues);
    if (
      outcomeValid
      && permittedValid
      && ((object.outcome === "applied" && policy.permitted !== true)
        || (object.outcome === "blocked" && policy.permitted !== false))
    ) {
      addIssue(
        issues,
        `${path}/policyDecision/permitted`,
        "policy_decision_conflict",
        "applied fallbacks require permission and blocked fallbacks require denial",
      );
    }
  }
}

export function validateFallbackRecord(input: unknown): ValidationResult<FallbackRecord> {
  // Snapshot before inspecting: rejects prototypes carrying inherited
  // fields, accessors that answer differently on each read, and symbol or
  // non-enumerable keys that an unknown-field check would not see.
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  input = plain.value;
  const issues: ValidationIssue[] = [];
  const unknownFields: UnknownFields = {};
  validateFallbackRecordAt(input, "", issues, unknownFields);
  if (issues.length > 0) return fail(issues);
  return ok(input as FallbackRecord, unknownFields);
}

function validateMaterialFallback(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  unknownFields: UnknownFields,
): void {
  const object = objectValue(value, path, ["kind", "record"], issues, unknownFields);
  if (!object) return;
  if (!enumValue(object.kind, ["not-used", "used", "unknown"] as const, `${path}/kind`, issues)) {
    return;
  }
  if (object.kind === "used") {
    validateFallbackRecordAt(object.record, `${path}/record`, issues, unknownFields);
  } else if (Object.hasOwn(object, "record")) {
    addIssue(issues, `${path}/record`, "unexpected_field", "only a used fallback carries a record");
  }
}

function validateModelRequest(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  unknownFields: UnknownFields,
): void {
  const object = objectValue(
    value,
    path,
    ["kind", "modelClass", "requestedModel"],
    issues,
    unknownFields,
  );
  if (!object) return;
  if (!enumValue(object.kind, ["model-class", "model"] as const, `${path}/kind`, issues)) return;
  if (object.kind === "model-class") {
    enumValue(object.modelClass, MODEL_CLASS_IDS, `${path}/modelClass`, issues);
    rejectPresentField(
      object,
      "requestedModel",
      path,
      issues,
      "a model-class request must not also carry a concrete model",
    );
  } else {
    rejectPresentField(
      object,
      "modelClass",
      path,
      issues,
      "a concrete model request must not also carry a model class",
    );
    const requested = objectValue(
      object.requestedModel,
      `${path}/requestedModel`,
      ["provider", "model"],
      issues,
      unknownFields,
    );
    if (requested) {
      enumValue(requested.provider, MODEL_PROVIDERS, `${path}/requestedModel/provider`, issues);
      requiredString(requested.model, `${path}/requestedModel/model`, issues);
    }
  }
}

function validateResolvedRoute(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  unknownFields: UnknownFields,
): void {
  const object = objectValue(
    value,
    path,
    ["provider", "model", "modelVersion", "evidence"],
    issues,
    unknownFields,
  );
  if (!object) return;
  validateExplicitProvider(object.provider, `${path}/provider`, issues, unknownFields);
  validateExplicitString(object.model, `${path}/model`, issues, unknownFields);
  validateExplicitString(object.modelVersion, `${path}/modelVersion`, issues, unknownFields);
  enumValue(object.evidence, RESOLUTION_EVIDENCE, `${path}/evidence`, issues);
}

export function validateModelProvenanceRecord(
  input: unknown,
): ValidationResult<ModelProvenanceRecord> {
  // Snapshot before inspecting: refuses prototypes carrying inherited fields,
  // accessors that can answer differently on each read, and symbol or
  // non-enumerable keys an unknown-field check would never see.
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  input = plain.value;
  const issues: ValidationIssue[] = [];
  const unknownFields: UnknownFields = {};
  const object = objectValue(
    input,
    "",
    [
      "schemaVersion",
      "event",
      "runId",
      "recordedAt",
      "recordedBy",
      "request",
      "reasoningMode",
      "capabilityProfile",
      "materialFallback",
      "route",
      "previousRoute",
      "observedRoute",
    ],
    issues,
    unknownFields,
  );
  if (!object) return fail(issues);
  literalOne(object.schemaVersion, "/schemaVersion", issues);
  const eventValid = enumValue(
    object.event,
    ["selected", "resolved", "drift"] as const,
    "/event",
    issues,
  );
  requiredString(object.runId, "/runId", issues);
  timestamp(object.recordedAt, "/recordedAt", issues);
  validateActor(object.recordedBy, "/recordedBy", issues, unknownFields);
  validateModelRequest(object.request, "/request", issues, unknownFields);
  validateExplicitValue(
    object.reasoningMode,
    "/reasoningMode",
    issues,
    unknownFields,
    (known, knownPath) => enumValue(known, MODEL_REASONING_MODES, knownPath, issues),
  );
  validateExplicitValue(
    object.capabilityProfile,
    "/capabilityProfile",
    issues,
    unknownFields,
    (known, knownPath) => validateCapabilityProfile(known, knownPath, issues, unknownFields),
  );
  validateMaterialFallback(object.materialFallback, "/materialFallback", issues, unknownFields);

  if (eventValid && object.event === "resolved") {
    validateResolvedRoute(object.route, "/route", issues, unknownFields);
    rejectPresentField(object, "previousRoute", "", issues, "only drift events carry previousRoute");
    rejectPresentField(object, "observedRoute", "", issues, "only drift events carry observedRoute");
  } else if (eventValid && object.event === "drift") {
    validateResolvedRoute(object.previousRoute, "/previousRoute", issues, unknownFields);
    validateResolvedRoute(object.observedRoute, "/observedRoute", issues, unknownFields);
    rejectPresentField(object, "route", "", issues, "drift events carry two named routes");
  } else if (eventValid) {
    rejectPresentField(object, "route", "", issues, "selected events do not carry a resolved route");
    rejectPresentField(object, "previousRoute", "", issues, "selected events do not carry routes");
    rejectPresentField(object, "observedRoute", "", issues, "selected events do not carry routes");
  }

  if (issues.length > 0) return fail(issues);
  return ok(input as ModelProvenanceRecord, unknownFields);
}

function validateWorkspace(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  unknownFields: UnknownFields,
): void {
  const object = objectValue(
    value,
    path,
    ["kind", "workspaceId", "ownerId", "organizationId"],
    issues,
    unknownFields,
  );
  if (!object) return;
  if (!enumValue(object.kind, ["personal", "organization"] as const, `${path}/kind`, issues)) {
    return;
  }
  requiredString(object.workspaceId, `${path}/workspaceId`, issues);
  if (object.kind === "personal") {
    requiredString(object.ownerId, `${path}/ownerId`, issues);
    rejectPresentField(
      object,
      "organizationId",
      path,
      issues,
      "personal workspaces do not carry an organizationId",
    );
  } else {
    requiredString(object.organizationId, `${path}/organizationId`, issues);
    rejectPresentField(
      object,
      "ownerId",
      path,
      issues,
      "organization workspaces do not carry a personal ownerId",
    );
  }
}

function validateAbsoluteUrl(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!requiredString(value, path, issues)) return;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("bad protocol");
  } catch {
    addIssue(issues, path, "invalid_url", "expected an absolute HTTP or HTTPS URL");
  }
}

function validateCredentials(value: unknown, issues: ValidationIssue[]): void {
  const path = "/credentials";
  const object = strictObjectValue(value, path, ["source"], issues);
  if (!object) return;
  const source = strictObjectValue(
    object.source,
    `${path}/source`,
    ["kind", "credentialId", "variableName"],
    issues,
  );
  if (!source) return;
  if (
    !enumValue(
      source.kind,
      ["managed-credential", "environment-variable"] as const,
      `${path}/source/kind`,
      issues,
    )
  ) return;
  if (source.kind === "managed-credential") {
    requiredString(source.credentialId, `${path}/source/credentialId`, issues);
    if (Object.hasOwn(source, "variableName")) {
      addIssue(
        issues,
        `${path}/source/variableName`,
        "unexpected_field",
        "managed credentials use a credentialId reference only",
      );
    }
  } else {
    requiredString(source.variableName, `${path}/source/variableName`, issues);
    if (Object.hasOwn(source, "credentialId")) {
      addIssue(
        issues,
        `${path}/source/credentialId`,
        "unexpected_field",
        "environment credentials use a variableName reference only",
      );
    }
  }
}

export function validateCustomerEndpointConfig(
  input: unknown,
): ValidationResult<CustomerEndpointConfig> {
  // Snapshot before inspecting: refuses prototypes carrying inherited fields,
  // accessors that can answer differently on each read, and symbol or
  // non-enumerable keys an unknown-field check would never see.
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  input = plain.value;
  const issues: ValidationIssue[] = [];
  const unknownFields: UnknownFields = {};
  const object = objectValue(
    input,
    "",
    [
      "schemaVersion",
      "endpointId",
      "workspace",
      "baseUrl",
      "modelIdentifier",
      "capabilityProfile",
      "retentionDeclaration",
      "jurisdiction",
      "credentials",
    ],
    issues,
    unknownFields,
  );
  if (!object) return fail(issues);
  literalOne(object.schemaVersion, "/schemaVersion", issues);
  requiredString(object.endpointId, "/endpointId", issues);
  validateWorkspace(object.workspace, "/workspace", issues, unknownFields);
  validateAbsoluteUrl(object.baseUrl, "/baseUrl", issues);
  requiredString(object.modelIdentifier, "/modelIdentifier", issues);
  validateCapabilityProfile(object.capabilityProfile, "/capabilityProfile", issues, unknownFields);
  validateExplicitString(
    object.retentionDeclaration,
    "/retentionDeclaration",
    issues,
    unknownFields,
  );
  validateExplicitLocation(object.jurisdiction, "/jurisdiction", issues, unknownFields);
  validateCredentials(object.credentials, issues);

  if (issues.length > 0) return fail(issues);
  return ok(input as CustomerEndpointConfig, unknownFields);
}

export function validateResidencyRecord(input: unknown): ValidationResult<ResidencyRecord> {
  // Snapshot before inspecting: refuses prototypes carrying inherited fields,
  // accessors that can answer differently on each read, and symbol or
  // non-enumerable keys an unknown-field check would never see.
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  input = plain.value;
  const issues: ValidationIssue[] = [];
  const unknownFields: UnknownFields = {};
  const object = objectValue(
    input,
    "",
    [
      "schemaVersion",
      "runId",
      "recordedAt",
      "recordedBy",
      "accountDataLocation",
      "projectContentLocation",
      "inferenceLocation",
      "verificationLocation",
    ],
    issues,
    unknownFields,
  );
  if (!object) return fail(issues);
  literalOne(object.schemaVersion, "/schemaVersion", issues);
  requiredString(object.runId, "/runId", issues);
  timestamp(object.recordedAt, "/recordedAt", issues);
  validateActor(object.recordedBy, "/recordedBy", issues, unknownFields);
  validateExplicitLocation(
    object.accountDataLocation,
    "/accountDataLocation",
    issues,
    unknownFields,
  );
  validateExplicitLocation(
    object.projectContentLocation,
    "/projectContentLocation",
    issues,
    unknownFields,
  );
  validateExplicitLocation(
    object.inferenceLocation,
    "/inferenceLocation",
    issues,
    unknownFields,
  );
  validateExplicitLocation(
    object.verificationLocation,
    "/verificationLocation",
    issues,
    unknownFields,
  );

  if (issues.length > 0) return fail(issues);
  return ok(input as ResidencyRecord, unknownFields);
}
