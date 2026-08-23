import type { Actor, ValidationIssue } from "@vinci/contracts";

export function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

export function isActor(value: unknown): value is Actor {
  if (!isObject(value)) return false;
  switch (value.kind) {
    case "user":
      return isNonEmptyString(value.userId) && (value.deviceId === undefined || isNonEmptyString(value.deviceId));
    case "worker":
      return isNonEmptyString(value.workerId);
    case "policy":
      return isNonEmptyString(value.policyId) && isPositiveInteger(value.policyVersion);
    case "system":
      return isNonEmptyString(value.component);
    case "verifier":
      return isNonEmptyString(value.verifierId) && typeof value.independent === "boolean";
    default:
      return false;
  }
}

export function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

export function collectUnknownFields(
  value: Readonly<Record<string, unknown>>,
  known: readonly string[],
  prefix: string,
  output: Record<string, unknown>,
): void {
  for (const [key, entry] of Object.entries(value)) {
    if (!known.includes(key)) output[`${prefix}/${escapePointer(key)}`] = entry;
  }
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
