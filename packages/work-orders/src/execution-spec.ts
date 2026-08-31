import {
  canonicalize,
  fail,
  isCanonicalTimestamp,
  isDigest,
  isIdentifier,
  isNonBlankText,
  isStrictlyAfter,
  ok,
  safeLabel,
  toPlainRecord,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import { sha256Hex, workOrderDigest } from "./digest.ts";
import { validateWorkOrder, type WorkOrder } from "./work-order.ts";
import { checkValidatedExecutionSpecWithinOrder } from "./within-order.ts";

/**
 * Everything a worker needs to START that a work order deliberately does not say.
 *
 * A work order is durable intent: what was asked, what "done" means, how much
 * authority and attention it carries. It survives the repository moving, the
 * model being swapped, the base commit advancing. None of those change what
 * was agreed, so none of them belong in the contract — and putting them there
 * would force a new contract version every time the world moved under it.
 *
 * An execution spec is the opposite: it is compiled FROM a work order for one
 * run, fixes every one of those moving parts, and is immutable once issued.
 * Re-running against a new base commit is a new spec with a new digest; the
 * order underneath is untouched.
 *
 * The spec references its order by id AND by digest. The id says which line of
 * contract this is; the digest says exactly which version of it, byte for
 * byte. A spec that names an id alone could be paired with any later amendment
 * of that order, which is how a worker ends up executing under terms nobody
 * agreed to. `bindExecutionSpec` is the check that the pairing is honest.
 *
 * Handoff to a worker is therefore the triple
 *   { work_order_id, contract_digest, execution_spec_digest }
 * and nothing else: every term the worker runs under is reachable from those
 * three values and cannot be swapped without one of them changing.
 */
export type ExecutionSpec = {
  readonly schemaVersion: 1;
  readonly workOrderId: string;
  /** `workOrderDigest` of the exact order this was compiled from. */
  readonly workOrderDigest: string;
  readonly repository: ExecutionRepository;
  /** The branch the run starts from, as a plain branch name ("main", never "refs/heads/main"). */
  readonly baseRef: string;
  /** The commit `baseRef` resolved to when the spec was compiled. 40 lowercase hex. */
  readonly baseCommit: string;
  /** Where the work lands. */
  readonly targetBranch: string;
  /**
   * A model-class name. Held as a string on purpose: the vocabulary lives in
   * @getsimpledirect/vinci-model-classes and is the consumer's to resolve; the
   * spec records which name was chosen, it does not re-validate the catalogue.
   */
  readonly modelClass: string;
  /** Provider pin, when the run must not be routed elsewhere. */
  readonly provider?: string;
  readonly resourceBounds: ResourceBounds;
  /** Tool names the worker may use. Anything absent is not granted. */
  readonly tools: readonly string[];
  /** Inputs the worker is given, each pinned by content digest. */
  readonly inputArtifacts: readonly InputArtifact[];
  /**
   * Names of `CapabilityMatrix` keys from @getsimpledirect/vinci-worker-capabilities
   * (for example "structuredEvidence", "safeResume"). Strings, NOT that type:
   * worker-capabilities sits two layers above this package and the dependency
   * graph forbids the import. The consumer that holds a matrix checks these
   * names against it; this validator checks only their shape.
   */
  readonly requiredCapabilities: readonly string[];
  /** What the run produces. */
  readonly output: ExecutionOutput;
  /** Whether an evidence bundle is required. When it is, one is always attempted. */
  readonly evidence: EvidenceRequirement;
  /** How the output is put forward for review. A pull request is promotion, not evidence. */
  readonly promotion: ExecutionPromotion;
  readonly issuedAt: string;
};

export type ExecutionRepository = {
  /** Hostname, e.g. "github.com". */
  readonly host: string;
  readonly owner: string;
  readonly name: string;
};

export type ResourceBounds = {
  /**
   * Budget in micro-USD (1 USD = 1_000_000), a non-negative safe integer.
   *
   * Not a float. Money as a binary double is the wrong type in general, and
   * here it is also a wire hazard: the digest is computed from canonical
   * bytes that a Node and a Python implementation must agree on, and a
   * float's shortest round-trip representation is exactly the place two
   * runtimes' formatting rules differ. An integer prints one way everywhere.
   */
  readonly budgetMicrousd: number;
  /** Positive integer seconds. */
  readonly maxRuntimeS: number;
  /** Canonical timestamp, strictly after `issuedAt`. */
  readonly deadline: string;
};

export type InputArtifact = {
  readonly id: string;
  /** Lowercase hex SHA-256 of the artifact's bytes. */
  readonly digest: string;
};

/**
 * What the run produces.
 *
 *   branch   — commits pushed to `targetBranch`
 *   patch    — a patch file, nothing pushed
 *   artifact — a non-code deliverable (a report, a dataset)
 *   none     — nothing durable (measurement, dry run)
 */
export const EXECUTION_OUTPUTS = ["branch", "patch", "artifact", "none"] as const;
export type ExecutionOutput = (typeof EXECUTION_OUTPUTS)[number];

/**
 * Whether the run must produce an evidence bundle. When `required` is true the
 * bundle is always attempted; a run that cannot produce one has failed, not
 * "delivered without evidence". HOW evidence is verified is not repeated
 * here: that is the work order's `verifier` and `acceptanceCriteria`, and a
 * spec restating it would be a second place for the policy to drift.
 */
export type EvidenceRequirement = { readonly required: boolean };

/**
 * How the output is put forward. A PULL REQUEST IS A PROMOTION MECHANISM, NOT
 * EVIDENCE: it is where a branch goes to be looked at, and says nothing about
 * whether the acceptance criteria hold. The first draft of this schema had a
 * single `evidencePolicy: "pr"` that conflated the two.
 *
 *   pull_request — open a pull request from `targetBranch`; requires `output: "branch"`
 *   none         — the output is left where it lands
 */
export const EXECUTION_PROMOTIONS = ["pull_request", "none"] as const;
export type ExecutionPromotion = (typeof EXECUTION_PROMOTIONS)[number];

const SPEC_FIELDS = [
  "schemaVersion", "workOrderId", "workOrderDigest", "repository", "baseRef", "baseCommit",
  "targetBranch", "modelClass", "provider", "resourceBounds", "tools", "inputArtifacts",
  "requiredCapabilities", "output", "evidence", "promotion", "issuedAt",
] as const;
const MAX_LIST = 100;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*$/;
/**
 * A PLAIN BRANCH NAME, under the rules the worker adopted in vinci-code-cli
 * PR #8 (vinci/worker/task.mjs branch header) plus `git check-ref-format
 * --branch` semantics. Both `baseRef` and `targetBranch` are branch names,
 * never refspecs: the worker builds `refs/heads/<name>` itself, and a value
 * that already carries refspec syntax (`+`, `:`, `..`, a leading `-`,
 * `refs/`, `@{`, `~`, `^`) is how a checkout or push lands somewhere other
 * than where the spec says.
 *
 *   - first character alphanumeric (so no leading `-`, `+`, `.`, `/`);
 *   - then only [A-Za-z0-9._/-]: excludes whitespace, controls, `~ ^ : ? * [ \ @ { }`;
 *   - no `..`, no `//`, no component beginning with `.` or ending with `.lock`;
 *   - no trailing `/` or `.`, no `.lock` suffix;
 *   - no `refs/` anywhere and no `refs.` prefix; not `HEAD`.
 */
export function isPlainBranchName(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) return false;
  if (value.includes("..") || value.includes("//") || value.includes("refs/") || /^refs[/.]/.test(value)) return false;
  if (value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock") || value === "HEAD") return false;
  return value.split("/").every((component) => !component.startsWith(".") && !component.endsWith(".lock"));
}
/** A CapabilityMatrix key is a camelCase identifier. */
const CAPABILITY_PATTERN = /^[a-z][A-Za-z0-9]{0,63}$/;

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  noun: string,
  issues: ValidationIssue[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      issues.push(issue(`${path}/${key}`, "unknown_field", `${noun} carries only its declared fields`));
    }
  }
}

function validateStringList(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  accept: (item: unknown) => boolean,
  code: string,
  message: string,
): void {
  if (!Array.isArray(value)) {
    issues.push(issue(path, "invalid_type", `${path.slice(1)} is an array`));
    return;
  }
  if (value.length > MAX_LIST) {
    issues.push(issue(path, "too_many", `at most ${MAX_LIST} entries`));
    return;
  }
  const seen = new Set<string>();
  value.forEach((item, i) => {
    if (!accept(item)) {
      issues.push(issue(`${path}/${i}`, code, message));
      return;
    }
    if (seen.has(item as string)) {
      issues.push(issue(`${path}/${i}`, "duplicate_entry", "an entry is listed twice"));
    }
    seen.add(item as string);
  });
}

/** Validate an execution spec from untrusted input. Fail-closed; unknown fields rejected. */
export function validateExecutionSpec(input: unknown): ValidationResult<ExecutionSpec> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];

  rejectUnknownFields(record, SPEC_FIELDS, "", "an execution spec", issues);
  if (record.schemaVersion !== 1) {
    issues.push(issue("/schemaVersion", "invalid_schema_version", "this schema is version 1"));
  }
  if (!isIdentifier(record.workOrderId)) {
    issues.push(issue("/workOrderId", "invalid_id", "workOrderId is an identifier"));
  }
  if (!isDigest(record.workOrderDigest)) {
    issues.push(issue("/workOrderDigest", "invalid_digest", "workOrderDigest is a lowercase hex SHA-256"));
  }

  if (!isObjectRecord(record.repository)) {
    issues.push(issue("/repository", "invalid_type", "repository is an object"));
  } else {
    const repo = record.repository;
    rejectUnknownFields(repo, ["host", "owner", "name"], "/repository", "repository", issues);
    if (typeof repo.host !== "string" || !HOST_PATTERN.test(repo.host)) {
      issues.push(issue("/repository/host", "invalid_host", "host is a lowercase hostname, e.g. github.com"));
    }
    for (const field of ["owner", "name"] as const) {
      if (!isIdentifier(repo[field])) {
        issues.push(issue(`/repository/${field}`, "invalid_id", `repository ${field} is an identifier`));
      }
    }
  }

  for (const field of ["baseRef", "targetBranch"] as const) {
    if (!isPlainBranchName(record[field])) {
      issues.push(issue(`/${field}`, "invalid_ref",
        `${field} must be a plain git branch name (letters, digits, ._/-; no leading -/+, no .., no refs/ prefix, no refspec syntax)`));
    }
  }
  if (typeof record.baseCommit !== "string" || !COMMIT_PATTERN.test(record.baseCommit)) {
    issues.push(issue("/baseCommit", "invalid_commit", "baseCommit is a full 40-character lowercase hex SHA-1"));
  }
  if (!isIdentifier(record.modelClass)) {
    issues.push(issue("/modelClass", "invalid_model_class", "modelClass is an identifier"));
  }
  if (Object.hasOwn(record, "provider") && !isIdentifier(record.provider)) {
    issues.push(issue("/provider", "invalid_provider", "provider, when present, is an identifier"));
  }

  let deadline: string | null = null;
  if (!isObjectRecord(record.resourceBounds)) {
    issues.push(issue("/resourceBounds", "invalid_type", "resourceBounds is an object"));
  } else {
    const bounds = record.resourceBounds;
    rejectUnknownFields(bounds, ["budgetMicrousd", "maxRuntimeS", "deadline"], "/resourceBounds", "resourceBounds", issues);
    if (!Number.isSafeInteger(bounds.budgetMicrousd) || (bounds.budgetMicrousd as number) < 0) {
      issues.push(issue("/resourceBounds/budgetMicrousd", "invalid_budget", "budgetMicrousd is a non-negative safe integer number of micro-USD; floats and USD are rejected"));
    }
    if (!Number.isSafeInteger(bounds.maxRuntimeS) || (bounds.maxRuntimeS as number) <= 0) {
      issues.push(issue("/resourceBounds/maxRuntimeS", "invalid_runtime", "maxRuntimeS is a positive integer number of seconds"));
    }
    if (!isCanonicalTimestamp(bounds.deadline)) {
      issues.push(issue("/resourceBounds/deadline", "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision"));
    } else {
      deadline = bounds.deadline;
    }
  }

  validateStringList(record.tools, "/tools", issues, isNonBlankText, "invalid_tool", "a tool name is non-blank text");
  validateStringList(
    record.requiredCapabilities, "/requiredCapabilities", issues,
    (v) => typeof v === "string" && CAPABILITY_PATTERN.test(v),
    "invalid_capability", "a required capability is a CapabilityMatrix key name, e.g. structuredEvidence",
  );

  if (!Array.isArray(record.inputArtifacts)) {
    issues.push(issue("/inputArtifacts", "invalid_type", "inputArtifacts is an array"));
  } else if (record.inputArtifacts.length > MAX_LIST) {
    issues.push(issue("/inputArtifacts", "too_many", `at most ${MAX_LIST} artifacts`));
  } else {
    const seen = new Set<string>();
    record.inputArtifacts.forEach((raw, i) => {
      const path = `/inputArtifacts/${i}`;
      if (!isObjectRecord(raw)) {
        issues.push(issue(path, "invalid_type", `an input artifact is an object, got ${safeLabel(raw)}`));
        return;
      }
      rejectUnknownFields(raw, ["id", "digest"], path, "an input artifact", issues);
      if (!isIdentifier(raw.id)) {
        issues.push(issue(`${path}/id`, "invalid_id", "an artifact id is an identifier"));
      } else if (seen.has(raw.id)) {
        issues.push(issue(`${path}/id`, "duplicate_artifact", "two artifacts share an id"));
      } else {
        seen.add(raw.id);
      }
      if (!isDigest(raw.digest)) {
        issues.push(issue(`${path}/digest`, "invalid_digest", "an artifact digest is a lowercase hex SHA-256"));
      }
    });
  }

  const validOutput = typeof record.output === "string" && (EXECUTION_OUTPUTS as readonly string[]).includes(record.output);
  if (!validOutput) {
    issues.push(issue("/output", "unknown_output", `output must be one of ${EXECUTION_OUTPUTS.join(", ")}`));
  }
  if (!isObjectRecord(record.evidence)) {
    issues.push(issue("/evidence", "invalid_type", "evidence is an object"));
  } else {
    rejectUnknownFields(record.evidence, ["required"], "/evidence", "evidence", issues);
    if (typeof record.evidence.required !== "boolean") {
      issues.push(issue("/evidence/required", "invalid_type", "evidence.required is boolean"));
    }
  }
  const validPromotion = typeof record.promotion === "string" && (EXECUTION_PROMOTIONS as readonly string[]).includes(record.promotion);
  if (!validPromotion) {
    issues.push(issue("/promotion", "unknown_promotion", `promotion must be one of ${EXECUTION_PROMOTIONS.join(", ")}`));
  } else if (validOutput && record.promotion === "pull_request" && record.output !== "branch") {
    issues.push(issue("/promotion", "promotion_needs_branch", "a pull request promotes a branch; output must be \"branch\""));
  }
  if (!isCanonicalTimestamp(record.issuedAt)) {
    issues.push(issue("/issuedAt", "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision"));
  } else if (deadline !== null && !isStrictlyAfter(deadline, record.issuedAt)) {
    issues.push(issue("/resourceBounds/deadline", "deadline_not_after_issuance", "deadline must be strictly later than issuedAt"));
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as ExecutionSpec, {});
}

/**
 * SHA-256 hex over the canonical encoding of the validated spec. Every field
 * is covered, `workOrderDigest` included, so the spec digest transitively pins
 * the exact contract it was compiled from. Throws on an invalid spec.
 */
export function executionSpecDigest(spec: ExecutionSpec): string {
  const validated = validateExecutionSpec(spec);
  if (!validated.ok) {
    const first = validated.issues[0];
    throw new Error(
      `cannot digest an invalid execution spec: ${first?.path ?? "/"} ${first?.code ?? "invalid"}`,
    );
  }
  return sha256Hex(canonicalize(validated.value));
}

/** The three values a worker is handed. Nothing it runs under is outside them. */
export type WorkHandoff = {
  readonly work_order_id: string;
  readonly contract_digest: string;
  readonly execution_spec_digest: string;
};

/**
 * Prove that `spec` was compiled from exactly `order`, and produce the handoff.
 *
 * Both the id and the digest must match. An id match with a digest mismatch is
 * the dangerous case — the same line of contract at a different version — and
 * it is reported as its own issue so it is not mistaken for a typo in the id.
 * Both records are validated on the way through; a digest of an invalid record
 * is not computed, so an invalid pair fails here rather than throwing.
 */
export function bindExecutionSpec(spec: ExecutionSpec, order: WorkOrder): ValidationResult<WorkHandoff> {
  const validSpec = validateExecutionSpec(spec);
  if (!validSpec.ok) return validSpec;
  const validOrder = validateWorkOrderForBinding(order);
  if (!validOrder.ok) return validOrder;
  const issues: ValidationIssue[] = [];
  const contractDigest = workOrderDigest(validOrder.value);
  if (validSpec.value.workOrderId !== validOrder.value.id) {
    issues.push(issue("/workOrderId", "work_order_id_mismatch", `spec names ${validSpec.value.workOrderId}; order is ${validOrder.value.id}`));
  }
  if (validSpec.value.workOrderDigest !== contractDigest) {
    issues.push(issue("/workOrderDigest", "work_order_digest_mismatch", "spec was compiled from a different version of this order"));
  }
  if (issues.length > 0) return fail(issues);
  // Identity proven; now containment. A spec bound to the right order may
  // still ask for more than it grants, and that is refused with its own reason.
  // Both records were validated above; the comparison is not asked to do it again.
  const within = checkValidatedExecutionSpecWithinOrder(validSpec.value, validOrder.value);
  if (!within.ok) {
    return fail([
      issue("", "execution_exceeds_contract",
        `the execution spec asks for what the order does not grant: ${within.issues.map((i) => `${i.path} ${i.code}`).join("; ")}`),
      ...within.issues,
    ]);
  }
  return ok({
    work_order_id: validOrder.value.id,
    contract_digest: contractDigest,
    execution_spec_digest: executionSpecDigest(validSpec.value),
  });
}

function validateWorkOrderForBinding(order: unknown): ValidationResult<WorkOrder> {
  const result = validateWorkOrder(order);
  if (result.ok) return result;
  return fail(result.issues.map((i) => issue(`/order${i.path}`, i.code, i.message)));
}

export const EXECUTION_SPEC_SCHEMA_META: SchemaMeta = {
  id: "vinci.execution-spec",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "First version; nothing precedes it. A spec is immutable once issued — a changed base commit, model, or bound is a new spec with a new digest, never an edit.",
};
