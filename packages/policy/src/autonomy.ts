/**
 * Per-ACTION autonomy, ordered from inspection through human-only execution.
 *
 * This is not the per-adapter trust level. Adapter trust describes what an
 * adapter can enforce; an autonomy rung describes what one requested action is
 * permitted to do on its own. The axes are independent and must not be
 * substituted for one another.
 */
export const AUTONOMY_RUNGS = [
  "observe",
  "recommend",
  "sandbox",
  "reversible",
  "bounded_production",
  "human_reserved",
] as const;

export type AutonomyRung = (typeof AUTONOMY_RUNGS)[number];

/** Human-readable meanings suitable for policy editors and decision UIs. */
export const AUTONOMY_RUNG_MEANINGS = {
  observe: "inspect and report",
  recommend: "propose with evidence, no side effect",
  sandbox: "execute in an isolated environment",
  reversible: "act in a narrow scope with automatic rollback",
  bounded_production: "act within explicit budgets and invariants",
  human_reserved:
    "a human performs it (irreversible, legal, strategic, financial, reputational)",
} as const satisfies Readonly<Record<AutonomyRung, string>>;

export function isAutonomyRung(value: unknown): value is AutonomyRung {
  return typeof value === "string" && (AUTONOMY_RUNGS as readonly string[]).includes(value);
}

/** Negative means `left` is below `right`; positive means it is above. */
export function compareAutonomyRungs(left: AutonomyRung, right: AutonomyRung): number {
  return AUTONOMY_RUNGS.indexOf(left) - AUTONOMY_RUNGS.indexOf(right);
}

export const REVERSIBILITY_CLASSES = [
  "read_only",
  "reversible",
  "conditionally_reversible",
  "irreversible",
] as const;

export type ReversibilityClass = (typeof REVERSIBILITY_CLASSES)[number];

export const REVERSIBILITY_CLASSIFIERS = ["host", "policy"] as const;
export type ReversibilityClassifier = (typeof REVERSIBILITY_CLASSIFIERS)[number];

/** Host/policy assessment used at the authority boundary. */
export type ReversibilityClassification = {
  readonly class: ReversibilityClass;
  readonly classifiedBy: ReversibilityClassifier;
  readonly checkpointAvailable: boolean;
  readonly undoMethod: string | null;
  readonly cannotRestore: readonly string[];
};
