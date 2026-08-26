import {
  isIdentifier,
  toPlainRecord,
  type ValidationIssue,
} from "@getsimpledirect/vinci-contracts";

export function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

export function rejectUnknownFields(
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  prefix: string,
  issues: ValidationIssue[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      issues.push(issue(`${prefix}/${key}`, "unknown_field", "the signed wire shape is closed"));
    }
  }
}

export function prefixIssues(
  prefix: string,
  nested: readonly ValidationIssue[],
  issues: ValidationIssue[],
): void {
  for (const entry of nested) {
    issues.push({ ...entry, path: `${prefix}${entry.path === "/" ? "" : entry.path}` || "/" });
  }
}

/** Unpadded RFC 4648 base64url syntax, with impossible length 1 mod 4 refused. */
export function isBase64Url(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && /^[A-Za-z0-9_-]+$/.test(value)
    && value.length % 4 !== 1;
}

export function validateSignature(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  const plain = toPlainRecord(value);
  if (!plain.ok) {
    prefixIssues(path, plain.issues, issues);
    return;
  }
  const signature = plain.value;
  rejectUnknownFields(signature, ["alg", "value"], path, issues);
  if (signature.alg !== "Ed25519") {
    issues.push(issue(`${path}/alg`, "invalid_signature_algorithm", "only Ed25519 is supported"));
  }
  if (!isBase64Url(signature.value)) {
    issues.push(issue(`${path}/value`, "invalid_base64url", "signature value must be unpadded base64url"));
  }
}

export function validateId(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!isIdentifier(value)) issues.push(issue(path, "invalid_id", "expected an identifier"));
}
