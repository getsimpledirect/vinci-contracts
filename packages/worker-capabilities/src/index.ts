/**
 * @getsimpledirect/vinci-worker-capabilities — demonstrated worker controls.
 *
 * A worker's own claim about what it enforces is advisory. The capability
 * matrix records what its adapter demonstrated, and the trust level is derived
 * from that matrix rather than trusted from the declaration. A later
 * conformance suite will fill the matrix; hand-written declarations are what
 * that suite checks against.
 */
import {
  fail,
  isDigest,
  isIdentifier,
  isNonBlankText,
  ok,
  toPlainRecord,
  type PlainRecord,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import {
  BROADENING_COMMANDS,
  REVERSIBLE_BRAKING_COMMANDS,
  type RemoteCommandKind,
  STEERING_COMMANDS,
  type SessionRole,
  TERMINAL_COMMANDS,
  mayIssue,
} from "@getsimpledirect/vinci-remote-protocol";

/** Ordered from the least to the most demonstrated oversight. */
export const TRUST_LEVELS = [
  "inventoried",
  "observed",
  "supervised",
  "governed",
  "assured",
] as const;

export type TrustLevel = (typeof TRUST_LEVELS)[number];

export function isTrustLevel(value: unknown): value is TrustLevel {
  return (TRUST_LEVELS as readonly unknown[]).includes(value);
}

/** Negative means `a` is lower, zero means equal, and positive means higher. */
export function compareTrustLevels(a: TrustLevel, b: TrustLevel): number {
  return TRUST_LEVELS.indexOf(a) - TRUST_LEVELS.indexOf(b);
}

export type CapabilityMatrix = {
  readonly activityStream: boolean;
  readonly questions: boolean;
  readonly steering: boolean;
  readonly approvals: "native" | "translated" | "none";
  readonly pause: boolean;
  readonly restrictToReadOnly: boolean;
  readonly abort: boolean;
  readonly filesystemEnforcement: boolean;
  readonly networkEnforcement: boolean;
  readonly structuredEvidence: boolean;
  readonly nativeReceipts: boolean;
  readonly safeResume: boolean;
  readonly independentVerification: boolean;
};

type BooleanCapability = Exclude<keyof CapabilityMatrix, "approvals">;

export type TrustRequirement =
  | {
      readonly capability: BooleanCapability;
      readonly equals: true;
      readonly description: string;
    }
  | {
      readonly capability: "approvals";
      readonly notEquals: "none";
      readonly description: string;
    };

export type TrustLevelRequirements = {
  readonly level: TrustLevel;
  readonly description: string;
  readonly requirements: readonly TrustRequirement[];
};

const ACTIVITY_STREAM = {
  capability: "activityStream",
  equals: true,
  description: "Activity events are available to an observer.",
} as const;
const QUESTIONS = {
  capability: "questions",
  equals: true,
  description: "Questions can be exchanged with the worker.",
} as const;
const ABORT = {
  capability: "abort",
  equals: true,
  description: "A run can be ended by an authorized command.",
} as const;
const APPROVALS = {
  capability: "approvals",
  notEquals: "none",
  description: "Approval decisions have a native or translated path.",
} as const;
const PAUSE = {
  capability: "pause",
  equals: true,
  description: "A running worker can be paused.",
} as const;
const READ_ONLY = {
  capability: "restrictToReadOnly",
  equals: true,
  description: "A running worker can be restricted to read-only operation.",
} as const;
const FILESYSTEM = {
  capability: "filesystemEnforcement",
  equals: true,
  description: "Filesystem limits are enforced by the adapter.",
} as const;
const NETWORK = {
  capability: "networkEnforcement",
  equals: true,
  description: "Network limits are enforced by the adapter.",
} as const;
const RECEIPTS = {
  capability: "nativeReceipts",
  equals: true,
  description: "The worker emits native receipts.",
} as const;
const INDEPENDENT_VERIFICATION = {
  capability: "independentVerification",
  equals: true,
  description: "Verification is performed independently of submitted work.",
} as const;
const STRUCTURED_EVIDENCE = {
  capability: "structuredEvidence",
  equals: true,
  description: "Verification produces structured evidence.",
} as const;

/** Machine-readable ladder used both for derivation and for Admin explanations. */
export const TRUST_LEVEL_REQUIREMENTS = [
  {
    level: "inventoried",
    description: "Worker and adapter identity are recorded.",
    requirements: [],
  },
  {
    level: "observed",
    description: "Worker activity can be observed.",
    requirements: [ACTIVITY_STREAM],
  },
  {
    level: "supervised",
    description: "A person can exchange questions, decide approvals, and end the run.",
    requirements: [ACTIVITY_STREAM, QUESTIONS, ABORT, APPROVALS],
  },
  {
    level: "governed",
    description: "The adapter demonstrates the required runtime enforcement and receipts.",
    requirements: [
      ACTIVITY_STREAM,
      QUESTIONS,
      ABORT,
      APPROVALS,
      PAUSE,
      READ_ONLY,
      FILESYSTEM,
      NETWORK,
      RECEIPTS,
    ],
  },
  {
    level: "assured",
    description: "Independent verification produces structured evidence.",
    requirements: [
      ACTIVITY_STREAM,
      QUESTIONS,
      ABORT,
      APPROVALS,
      PAUSE,
      READ_ONLY,
      FILESYSTEM,
      NETWORK,
      RECEIPTS,
      INDEPENDENT_VERIFICATION,
      STRUCTURED_EVIDENCE,
    ],
  },
] as const satisfies readonly TrustLevelRequirements[];

function requirementMet(matrix: CapabilityMatrix, requirement: TrustRequirement): boolean {
  if (requirement.capability === "approvals") return matrix.approvals !== requirement.notEquals;
  return matrix[requirement.capability] === requirement.equals;
}

/** Compute the highest complete rung; matrix-independent claims are ignored. */
export function derivedTrustLevel(matrix: CapabilityMatrix): TrustLevel {
  let derived: TrustLevel = "inventoried";
  for (const rung of TRUST_LEVEL_REQUIREMENTS) {
    if (!rung.requirements.every((requirement) => requirementMet(matrix, requirement))) break;
    derived = rung.level;
  }
  return derived;
}

const TRUST_LEVEL_LABELS: Readonly<Record<TrustLevel, string>> = {
  inventoried: "Inventoried",
  observed: "Observed",
  supervised: "Supervised",
  governed: "Governed",
  assured: "Assured",
};

export function trustLevelLabel(level: TrustLevel): string {
  return TRUST_LEVEL_LABELS[level];
}

type CommandRule = (matrix: CapabilityMatrix) => boolean;

/**
 * Exhaustive by type. Adding a RemoteCommandKind requires a mapping here or an
 * explicit entry in UNMAPPED_COMMANDS; otherwise TypeScript fails the build.
 */
const COMMAND_RULES = {
  [REVERSIBLE_BRAKING_COMMANDS[0]]: (matrix) => matrix.pause,
  [REVERSIBLE_BRAKING_COMMANDS[1]]: (matrix) => matrix.restrictToReadOnly,
  [REVERSIBLE_BRAKING_COMMANDS[2]]: (matrix) => matrix.approvals !== "none",
  [TERMINAL_COMMANDS[0]]: (matrix) => matrix.abort,
  [STEERING_COMMANDS[0]]: (matrix) => matrix.steering,
  [STEERING_COMMANDS[1]]: (matrix) => matrix.questions,
  approve_pending_approval: (matrix) => matrix.approvals !== "none",
} satisfies Readonly<Record<RemoteCommandKind, CommandRule>>;

const MAPPED_COMMANDS = [
  ...REVERSIBLE_BRAKING_COMMANDS,
  ...TERMINAL_COMMANDS,
  ...STEERING_COMMANDS,
  ...BROADENING_COMMANDS,
  "approve_pending_approval",
] as const satisfies readonly RemoteCommandKind[];

export const UNMAPPED_COMMANDS = [] as const satisfies readonly {
  readonly command: RemoteCommandKind;
  readonly reason: string;
}[];

/**
 * The ADAPTER axis only: every command this worker can actually honour. This is
 * necessary for rendering a control and not sufficient — authority has a second
 * axis, the role of the person holding the device, and `approve_pending_approval`
 * in particular is broadening and owner/approver-only in remote-protocol. A UI
 * must call `renderableRemoteCommands(matrix, role)`, which intersects both axes;
 * rendering this list alone offers authority the session does not have.
 */
export function permittedRemoteCommands(matrix: CapabilityMatrix): readonly RemoteCommandKind[] {
  return MAPPED_COMMANDS.filter((command) => COMMAND_RULES[command](matrix));
}

export type WorkerDeclaration = {
  readonly schemaVersion: 1;
  readonly worker: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly buildDigest?: string;
  };
  readonly adapter: {
    readonly id: string;
    readonly version: string;
  };
  readonly controlLevel: TrustLevel;
  readonly supports: CapabilityMatrix;
};

const ROOT_KEYS = new Set(["schemaVersion", "worker", "adapter", "controlLevel", "supports"]);
const WORKER_KEYS = new Set(["id", "name", "version", "buildDigest"]);
const ADAPTER_KEYS = new Set(["id", "version"]);
const CAPABILITY_KEYS = new Set<keyof CapabilityMatrix>([
  "activityStream",
  "questions",
  "steering",
  "approvals",
  "pause",
  "restrictToReadOnly",
  "abort",
  "filesystemEnforcement",
  "networkEnforcement",
  "structuredEvidence",
  "nativeReceipts",
  "safeResume",
  "independentVerification",
]);

function asRecord(value: unknown): PlainRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as PlainRecord)
    : null;
}

function rejectUnknown(
  record: PlainRecord,
  allowed: ReadonlySet<string>,
  path: string,
  noun: string,
  issues: ValidationIssue[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      issues.push({
        path: `${path}/${key}`,
        code: "unknown_field",
        message: `${noun} carries only its declared fields`,
      });
    }
  }
}

function addRequiredString(
  record: PlainRecord,
  key: string,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!isNonBlankText(record[key])) {
    issues.push({ path: `${path}/${key}`, code: "required_field", message: `${key} must be non-blank text` });
  }
}

/** Validate a closed declaration and refuse any trust claim above the matrix. */
export function validateWorkerDeclaration(input: unknown): ValidationResult<WorkerDeclaration> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;

  const record = plain.value;
  const issues: ValidationIssue[] = [];
  rejectUnknown(record, ROOT_KEYS, "", "a worker declaration", issues);

  if (record.schemaVersion !== 1) {
    issues.push({ path: "/schemaVersion", code: "invalid_version", message: "schemaVersion must be 1" });
  }

  const worker = asRecord(record.worker);
  if (worker === null) {
    issues.push({ path: "/worker", code: "invalid_type", message: "worker must be an object" });
  } else {
    rejectUnknown(worker, WORKER_KEYS, "/worker", "worker identity", issues);
    if (!isIdentifier(worker.id)) {
      issues.push({ path: "/worker/id", code: "invalid_id", message: "worker id must be an identifier" });
    }
    addRequiredString(worker, "name", "/worker", issues);
    addRequiredString(worker, "version", "/worker", issues);
    if (worker.buildDigest !== undefined && !isDigest(worker.buildDigest)) {
      issues.push({ path: "/worker/buildDigest", code: "invalid_digest", message: "buildDigest must be a lowercase SHA-256 digest" });
    }
  }

  const adapter = asRecord(record.adapter);
  if (adapter === null) {
    issues.push({ path: "/adapter", code: "invalid_type", message: "adapter must be an object" });
  } else {
    rejectUnknown(adapter, ADAPTER_KEYS, "/adapter", "adapter identity", issues);
    if (!isIdentifier(adapter.id)) {
      issues.push({ path: "/adapter/id", code: "invalid_id", message: "adapter id must be an identifier" });
    }
    addRequiredString(adapter, "version", "/adapter", issues);
  }

  if (!isTrustLevel(record.controlLevel)) {
    issues.push({ path: "/controlLevel", code: "invalid_enum", message: "controlLevel must be a trust level" });
  }

  const supports = asRecord(record.supports);
  let matrix: CapabilityMatrix | null = null;
  if (supports === null) {
    issues.push({ path: "/supports", code: "invalid_type", message: "supports must be an object" });
  } else {
    rejectUnknown(supports, CAPABILITY_KEYS, "/supports", "a capability matrix", issues);
    for (const key of CAPABILITY_KEYS) {
      if (key === "approvals") {
        if (!(supports.approvals === "native" || supports.approvals === "translated" || supports.approvals === "none")) {
          issues.push({ path: "/supports/approvals", code: "invalid_enum", message: "approvals must be native, translated or none" });
        }
      } else if (typeof supports[key] !== "boolean") {
        issues.push({ path: `/supports/${key}`, code: "required_field", message: `${key} must be boolean` });
      }
    }
    const capabilityIssues = issues.some((issue) => issue.path.startsWith("/supports"));
    if (!capabilityIssues) matrix = supports as unknown as CapabilityMatrix;
  }

  if (matrix !== null && isTrustLevel(record.controlLevel)) {
    const derived = derivedTrustLevel(matrix);
    if (compareTrustLevels(record.controlLevel, derived) > 0) {
      issues.push({
        path: "/controlLevel",
        code: "control_level_overclaimed",
        message: `declared control level ${record.controlLevel} exceeds derived trust level ${derived}`,
      });
    }
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as WorkerDeclaration, {});
}

export const WORKER_DECLARATION_SCHEMA_META: SchemaMeta = {
  id: "vinci.worker-declaration",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};

/**
 * What a UI may render for THIS worker in front of THIS role: the adapter can
 * honour it AND remote-protocol lets the role issue it. Both axes are decided
 * elsewhere; this function only intersects them, so neither can be widened here.
 */
export function renderableRemoteCommands(
  matrix: CapabilityMatrix,
  role: SessionRole,
): readonly RemoteCommandKind[] {
  // This is an authority guard, so it is probed with hostile input by the
  // hostile-key sweep: a matrix that is not a plain closed record, or a role
  // that is not a string, yields NO commands rather than throwing or guessing.
  if (!isPlainCapabilityMatrix(matrix)) return [];
  return permittedRemoteCommands(matrix).filter((command) => mayIssue(role, command));
}

const CAPABILITY_BOOLEAN_KEYS = [
  "activityStream",
  "questions",
  "steering",
  "pause",
  "restrictToReadOnly",
  "abort",
  "filesystemEnforcement",
  "networkEnforcement",
  "structuredEvidence",
  "nativeReceipts",
  "safeResume",
  "independentVerification",
] as const;

function isPlainCapabilityMatrix(value: unknown): value is CapabilityMatrix {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== CAPABILITY_BOOLEAN_KEYS.length + 1) return false;
  for (const key of CAPABILITY_BOOLEAN_KEYS) {
    if (!Object.hasOwn(record, key) || typeof record[key] !== "boolean") return false;
  }
  const approvals = Object.hasOwn(record, "approvals") ? record.approvals : undefined;
  return approvals === "native" || approvals === "translated" || approvals === "none";
}
