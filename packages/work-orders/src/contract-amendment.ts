import {
  fail,
  isCanonicalTimestamp,
  isIdentifier,
  isNonBlankText,
  ok,
  toPlainRecord,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import type { AttentionBudget } from "./attention.ts";
import {
  validateWorkOrder,
  type AcceptanceCriterion,
  type WorkOrder,
} from "./work-order.ts";

export const CONTRACT_CHANGE_PATHS = [
  "request",
  "scope",
  "acceptanceCriteria",
  "grantedAuthority",
  "attentionBudget",
  "expiresAt",
] as const;

export type ContractChangePath = (typeof CONTRACT_CHANGE_PATHS)[number];
export type ContractChangeKind = "added" | "removed" | "modified";

export type ContractChange = {
  readonly path: ContractChangePath;
  readonly kind: ContractChangeKind;
};

export const MATERIAL_PATHS = [
  "acceptanceCriteria",
  "scope",
  "grantedAuthority",
] as const satisfies readonly ContractChangePath[];

export type ContractAmendment = {
  readonly schemaVersion: 1;
  readonly amendmentId: string;
  readonly workOrderId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly changedBy: string;
  readonly changedAt: string;
  readonly reason: string;
  readonly changes: readonly ContractChange[];
  readonly materiality: "material" | "editorial";
};

export type WorkOrderPatch = Readonly<Partial<{
  request: string;
  scope: string;
  acceptanceCriteria: readonly AcceptanceCriterion[];
  grantedAuthority: readonly string[];
  attentionBudget: AttentionBudget;
  expiresAt: string;
}>>;

export type AmendmentAttribution = {
  readonly amendmentId: string;
  readonly changedBy: string;
  readonly changedAt: string;
  readonly reason: string;
};

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

function isChangePath(value: unknown): value is ContractChangePath {
  return typeof value === "string" && (CONTRACT_CHANGE_PATHS as readonly string[]).includes(value);
}

function isChangeKind(value: unknown): value is ContractChangeKind {
  return value === "added" || value === "removed" || value === "modified";
}

/** Validate an immutable audit record describing one work-contract version transition. */
export function validateContractAmendment(input: unknown): ValidationResult<ContractAmendment> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];

  const known = [
    "schemaVersion",
    "amendmentId",
    "workOrderId",
    "fromVersion",
    "toVersion",
    "changedBy",
    "changedAt",
    "reason",
    "changes",
    "materiality",
  ];
  for (const key of Object.keys(record)) {
    if (!known.includes(key)) {
      issues.push(issue(`/${key}`, "unknown_field", "a contract amendment carries only its declared fields"));
    }
  }

  if (record.schemaVersion !== 1) {
    issues.push(issue("/schemaVersion", "invalid_schema_version", "this schema is version 1"));
  }
  for (const field of ["amendmentId", "workOrderId", "changedBy"] as const) {
    if (!isIdentifier(record[field])) {
      issues.push(issue(`/${field}`, "invalid_id", `${field} is an identifier`));
    }
  }
  if (!Number.isSafeInteger(record.fromVersion) || (record.fromVersion as number) < 1) {
    issues.push(issue("/fromVersion", "invalid_contract_version", "fromVersion is an integer at least 1"));
  }
  if (!Number.isSafeInteger(record.toVersion) || (record.toVersion as number) < 2) {
    issues.push(issue("/toVersion", "invalid_contract_version", "toVersion is an integer at least 2"));
  }
  if (
    Number.isSafeInteger(record.fromVersion)
    && Number.isSafeInteger(record.toVersion)
    && record.toVersion !== (record.fromVersion as number) + 1
  ) {
    issues.push(issue("/toVersion", "non_consecutive_version", "toVersion must be exactly one greater than fromVersion"));
  }
  if (!isCanonicalTimestamp(record.changedAt)) {
    issues.push(
      issue(
        "/changedAt",
        "invalid_timestamp",
        "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z",
      ),
    );
  }
  if (!isNonBlankText(record.reason)) {
    issues.push(issue("/reason", "required_field", "reason must be non-blank text"));
  }

  if (!Array.isArray(record.changes) || record.changes.length === 0) {
    issues.push(issue("/changes", "changes_required", "an amendment must describe at least one contract change"));
  } else {
    record.changes.forEach((raw, index) => {
      const path = `/changes/${index}`;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        issues.push(issue(path, "invalid_type", "a contract change is an object"));
        return;
      }
      const change = raw as Record<string, unknown>;
      for (const key of Object.keys(change)) {
        if (!["path", "kind"].includes(key)) {
          issues.push(issue(`${path}/${key}`, "unknown_field", "a contract change carries only path and kind"));
        }
      }
      if (!isChangePath(change.path)) {
        issues.push(issue(`${path}/path`, "unknown_change_path", "path must come from CONTRACT_CHANGE_PATHS"));
      }
      if (!isChangeKind(change.kind)) {
        issues.push(issue(`${path}/kind`, "unknown_change_kind", "kind must be added, removed, or modified"));
      }
    });
  }

  if (record.materiality !== "material" && record.materiality !== "editorial") {
    issues.push(issue("/materiality", "unknown_materiality", "materiality must be material or editorial"));
  } else if (Array.isArray(record.changes)) {
    const wellFormedChanges = record.changes.every(
      (raw): raw is ContractChange =>
        typeof raw === "object"
        && raw !== null
        && !Array.isArray(raw)
        && isChangePath((raw as Record<string, unknown>).path)
        && isChangeKind((raw as Record<string, unknown>).kind),
    );
    if (wellFormedChanges && classifyMateriality(record.changes) !== record.materiality) {
      issues.push(issue("/materiality", "materiality_mismatch", "materiality must be derived from changes"));
    }
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as ContractAmendment, {});
}

/** Classify from the exported rule so every consumer applies the same staleness boundary. */
export function classifyMateriality(changes: readonly ContractChange[]): "material" | "editorial" {
  return changes.some((change) => (MATERIAL_PATHS as readonly ContractChangePath[]).includes(change.path))
    ? "material"
    : "editorial";
}

/**
 * Whether a current verdict must be staled by this amendment.
 *
 * A stale verdict remains immutable history, but it is no longer the current
 * assessment of the amended contract. Consumers must retain it and require a
 * new verdict, mirroring Vinci Code's separation of attempts from verdicts.
 */
export function verificationIsStaleAfter(amendment: ContractAmendment): boolean {
  return amendment.materiality === "material";
}

function sameCriterion(a: AcceptanceCriterion, b: AcceptanceCriterion): boolean {
  return a.statement === b.statement && a.verifiedBy === b.verifiedBy;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function amendmentError(code: string, message: string): Error {
  return new Error(`${code}: ${message}`);
}

function diffCriteria(
  previous: readonly AcceptanceCriterion[],
  next: readonly AcceptanceCriterion[],
): ContractChange[] {
  const oldById = new Map(previous.map((criterion) => [criterion.id, criterion]));
  const nextById = new Map(next.map((criterion) => [criterion.id, criterion]));

  for (const [id, oldCriterion] of oldById) {
    const nextCriterion = nextById.get(id);
    if (nextCriterion !== undefined && !sameCriterion(oldCriterion, nextCriterion)) {
      throw amendmentError(
        "criterion_rewritten_in_place",
        `criterion ${id} changed meaning; remove it and add the replacement with a new id`,
      );
    }
  }

  const changes: ContractChange[] = [];
  for (const criterion of previous) {
    if (!nextById.has(criterion.id)) changes.push({ path: "acceptanceCriteria", kind: "removed" });
  }
  for (const criterion of next) {
    if (!oldById.has(criterion.id)) changes.push({ path: "acceptanceCriteria", kind: "added" });
  }
  if (changes.length === 0 && !sameValue(previous, next)) {
    changes.push({ path: "acceptanceCriteria", kind: "modified" });
  }
  return changes;
}

function throwValidation(label: string, result: ValidationResult<unknown>): never {
  if (result.ok) throw new Error("unreachable");
  const first = result.issues[0];
  throw amendmentError(first?.code ?? "invalid_amendment_input", `${label}${first?.path ?? ""}: ${first?.message ?? "invalid"}`);
}

/**
 * Create the next immutable work-contract version and its audit record.
 *
 * The function snapshots and validates every input, never mutates `previous`,
 * and rejects a criterion whose existing id is reused for different content.
 */
export function amendWorkOrder(
  previous: WorkOrder,
  patch: WorkOrderPatch,
  attribution: AmendmentAttribution,
): { readonly next: WorkOrder; readonly amendment: ContractAmendment } {
  const validPrevious = validateWorkOrder(previous);
  if (!validPrevious.ok) throwValidation("previous", validPrevious);
  if (validPrevious.value.contractVersion === Number.MAX_SAFE_INTEGER) {
    throw amendmentError("contract_version_exhausted", "contractVersion cannot be incremented safely");
  }

  const plainPatch = toPlainRecord(patch);
  if (!plainPatch.ok) throwValidation("patch", plainPatch);
  for (const key of Object.keys(plainPatch.value)) {
    if (!(CONTRACT_CHANGE_PATHS as readonly string[]).includes(key)) {
      throw amendmentError("unknown_patch_field", `patch cannot change ${key}`);
    }
  }

  const plainAttribution = toPlainRecord(attribution);
  if (!plainAttribution.ok) throwValidation("attribution", plainAttribution);
  for (const key of Object.keys(plainAttribution.value)) {
    if (!["amendmentId", "changedBy", "changedAt", "reason"].includes(key)) {
      throw amendmentError("unknown_attribution_field", `attribution cannot carry ${key}`);
    }
  }

  const oldOrder = validPrevious.value;
  const patchValue = plainPatch.value;
  const candidate = {
    ...oldOrder,
    ...patchValue,
    schemaVersion: 2 as const,
    contractVersion: oldOrder.contractVersion + 1,
    supersedes: {
      contractVersion: oldOrder.contractVersion,
      amendmentId: plainAttribution.value.amendmentId,
    },
  };

  if (
    Object.hasOwn(patchValue, "expiresAt")
    && patchValue.expiresAt !== oldOrder.expiresAt
    && (
      !isCanonicalTimestamp(patchValue.expiresAt)
      || Date.parse(patchValue.expiresAt) <= Date.parse(oldOrder.expiresAt)
    )
  ) {
    throw amendmentError("expiry_not_extended", "an expiresAt amendment must extend the previous expiry");
  }

  const nextResult = validateWorkOrder(candidate);
  if (!nextResult.ok) throwValidation("patch", nextResult);
  const next = nextResult.value;
  const changes: ContractChange[] = [];

  if (oldOrder.request !== next.request) changes.push({ path: "request", kind: "modified" });
  if (oldOrder.scope !== next.scope) changes.push({ path: "scope", kind: "modified" });
  changes.push(...diffCriteria(oldOrder.acceptanceCriteria, next.acceptanceCriteria));
  if (!sameValue(oldOrder.grantedAuthority, next.grantedAuthority)) {
    changes.push({ path: "grantedAuthority", kind: "modified" });
  }
  if (!sameValue(oldOrder.attentionBudget, next.attentionBudget)) {
    changes.push({ path: "attentionBudget", kind: "modified" });
  }
  if (oldOrder.expiresAt !== next.expiresAt) changes.push({ path: "expiresAt", kind: "modified" });
  if (changes.length === 0) {
    throw amendmentError("no_contract_changes", "an amendment must change at least one contract field");
  }

  const amendmentResult = validateContractAmendment({
    schemaVersion: 1,
    amendmentId: plainAttribution.value.amendmentId,
    workOrderId: oldOrder.id,
    fromVersion: oldOrder.contractVersion,
    toVersion: next.contractVersion,
    changedBy: plainAttribution.value.changedBy,
    changedAt: plainAttribution.value.changedAt,
    reason: plainAttribution.value.reason,
    changes,
    materiality: classifyMateriality(changes),
  });
  if (!amendmentResult.ok) throwValidation("attribution", amendmentResult);

  return { next, amendment: amendmentResult.value };
}

export const CONTRACT_AMENDMENT_SCHEMA_META: SchemaMeta = {
  id: "vinci.contract-amendment",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};
