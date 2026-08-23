/**
 * Who or what a failure belongs to.
 *
 * This is the difference between an evaluator worth having and one that is
 * worse than nothing. An acceptance system that reports a broken container, a
 * missing credential, or an ambiguous request as a defect in the submitted work
 * does not merely fail to help — it actively misleads, and it teaches people to
 * stop believing verdicts. A false accusation is more expensive than a missed
 * finding, because it is paid every time.
 *
 * The vocabulary is `vinci-acceptance`'s, imported rather than invented, so the
 * producer of verdicts and the shared contract cannot disagree about what a
 * failure means.
 */
export const FAILURE_OWNERS = [
  /** The work under evaluation is at fault. This is the only owner that means "reject the work". */
  "submitted_work",
  /** Vinci's own execution environment failed. Not the author's problem, and must never read as one. */
  "vinci_infrastructure",
  /** The check could not run because access was not granted. Unknown, not failed. */
  "missing_access",
  /** The request itself was ambiguous enough that no check could settle it. */
  "unclear_requirement",
] as const;

export type FailureOwner = (typeof FAILURE_OWNERS)[number];

export function isFailureOwner(value: unknown): value is FailureOwner {
  return typeof value === "string" && (FAILURE_OWNERS as readonly string[]).includes(value);
}

/**
 * Only one owner justifies holding the submitted work responsible.
 *
 * Exported so consumers do not each re-derive it. Getting this wrong in one
 * consumer is how infrastructure flakiness starts being reported as defects.
 */
export function blamesSubmittedWork(owner: FailureOwner): boolean {
  return owner === "submitted_work";
}

/**
 * Something a verdict did NOT check, and why.
 *
 * FR-6 requires a receipt to say what did not run. Silence about coverage reads
 * as coverage: a verdict listing five passing criteria and omitting the two it
 * could not evaluate is understood as "all seven are fine", which is precisely
 * the unearned pass this system exists to prevent.
 *
 * `reason` is required. "Not tested" without a reason is indistinguishable from
 * an oversight, and the reader cannot tell whether to worry.
 */
export type NotTestedItem = {
  readonly description: string;
  readonly reason: string;
};

/**
 * What a piece of evidence says about the claim it was gathered for, and — when
 * it says something failed — whose failure it is.
 *
 * A discriminated union rather than an `outcome` field beside an optional
 * `failureOwner`, because optional attribution is attribution nobody supplies.
 * `vinci-acceptance` carries `failureOwner?: FailureOwner`, and an optional
 * field on the one record that decides whether work gets rejected is a default
 * waiting to happen: unattributed failures read as the author's fault, which is
 * the misattribution this vocabulary exists to prevent.
 *
 * Here a failing outcome CANNOT be constructed without an owner. There is no
 * shape for "this failed and I am not saying why".
 */
export type EvidenceOutcome =
  /** The evidence supports the claim. Nothing failed, so there is nothing to attribute. */
  | { readonly outcome: "supports" }
  /**
   * The check ran and settled nothing. Explicitly NOT a failure: reporting an
   * inconclusive result as a contradiction is how a flaky check becomes a
   * rejected pull request.
   */
  | { readonly outcome: "inconclusive" }
  /** The evidence contradicts the claim. Someone owns that, and must be named. */
  | { readonly outcome: "contradicts"; readonly failureOwner: FailureOwner }
  /**
   * The evidence itself cannot be trusted — the check misran, the environment
   * was wrong, the output was unreadable. Also requires an owner, because
   * "invalid" without attribution is routinely read as "the work is broken".
   */
  | { readonly outcome: "invalid"; readonly failureOwner: FailureOwner };

export const EVIDENCE_OUTCOMES = ["supports", "inconclusive", "contradicts", "invalid"] as const;

/**
 * Does this evidence justify holding the submitted work responsible?
 *
 * The single question a verdict needs answered, in one place rather than
 * re-derived per consumer. Evidence that contradicts because Vinci's own
 * container failed does not count against the author, and a consumer that
 * forgets the distinction produces exactly the false accusations that make an
 * acceptance system untrustworthy.
 */
export function countsAgainstSubmittedWork(evidence: EvidenceOutcome): boolean {
  // Own data reads, and no throwing, because this is exported and answers a
  // question about blame. Before this it threw on null and on a throwing
  // proxy, and — the real defect — an object with NO own keys inheriting
  // `outcome: "contradicts"` and `failureOwner: "submitted_work"` returned
  // TRUE. Attribution decided from a prototype is attribution nobody wrote.
  const outcome = ownData(evidence, "outcome");
  if (outcome !== "contradicts" && outcome !== "invalid") return false;
  return blamesSubmittedWork(ownData(evidence, "failureOwner") as FailureOwner);
}

/**
 * Read one own DATA property, or undefined. Never invokes a getter, never
 * follows a prototype, never throws.
 */
function ownData(source: unknown, field: string): unknown {
  if (typeof source !== "object" || source === null) return undefined;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(source, field);
  } catch {
    return undefined;
  }
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  return descriptor.value;
}
