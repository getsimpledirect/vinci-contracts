import {
  fail,
  isVerdictStatus,
  ok,
  canonicalize,
  isCanonicalTimestamp,
  isDigest,
  isIdentifier,
  isNonBlankText,
  isStrictlyAfter,
  plainActor,
  RISK_LEVELS,
  toPlainRecord,
  type Actor,
  type EvidenceId,
  type OrganizationId,
  type RiskLevel,
  type SchemaMeta,
  type Timestamp,
  type ValidationIssue,
  type ValidationResult,
  type VerdictStatus,
} from "@getsimpledirect/vinci-contracts";
import type { NotTestedItem } from "./attribution.ts";
import { VERDICT_STALENESS_TRIGGERS, type VerdictStalenessTrigger } from "./verdict-assessment.ts";

/**
 * What a verdict concluded about one acceptance criterion.
 *
 * `unverified` is deliberately absent from the result set. A criterion nobody
 * evaluated does not belong in a list of results — it belongs in `notTested`,
 * where the reader can see it was skipped and why. Letting "unverified" sit
 * among results is how a criterion that was never checked gets counted as
 * having been looked at.
 */
export const CRITERION_RESULT_STATUSES = ["supported", "contradicted", "unknown"] as const;
export type CriterionResultStatus = (typeof CRITERION_RESULT_STATUSES)[number];

export type CriterionResult = {
  readonly criterionId: string;
  readonly status: CriterionResultStatus;
  readonly summary: string;
  /** The evidence this conclusion actually rests on. Empty is not permitted. */
  readonly evidenceIds: readonly EvidenceId[];
};

export type UnresolvedCondition = {
  readonly description: string;
  /** What someone must DO. A condition with no action is a worry, not a finding. */
  readonly requiredAction: string;
};

/** Domain-specific name for the shared qualitative risk vocabulary. */
export const RISK_SEVERITIES = RISK_LEVELS;
export type RiskSeverity = RiskLevel;

export type ResidualRisk = {
  readonly description: string;
  readonly severity: RiskSeverity;
};

export type StalenessCondition = {
  readonly trigger: VerdictStalenessTrigger;
  /** The value being watched — a digest, a policy version, a path. */
  readonly value: string;
};

/**
 * The issuing authority behind a verdict: WHOSE, and WHO within it.
 *
 * An `Actor` alone does not answer the question this field exists to answer.
 * The `system` arm is `{ kind: "system", component: string }`, and a verdict
 * issued by `{ kind: "system", component: "control-plane" }` names a component
 * that TWO DIFFERENT ORGANIZATIONS may both operate. Two such verdicts are
 * byte-identical in their attribution while coming from unrelated authorities,
 * so a consumer holding one cannot say whose word it is — which is the whole
 * property `issuedBy` was added for. The same holds for every other arm:
 * `worker-1`, `user-1` and `policy.auto-accept` are all names scoped to some
 * organization, and none of them carries that scope.
 *
 * ONE object rather than two sibling fields on the record, because the two
 * facts are only meaningful together. `organizationId` without an actor names
 * an authority and no principal within it; an actor without an
 * `organizationId` names a principal whose identifier could belong to anyone.
 * Keeping them in one closed object means they are written together, read
 * together, and cannot be separated by a partial copy — the failure mode where
 * a consumer forwards the actor and drops the scope that made it unambiguous.
 *
 * `organizationId` is an `OrganizationId`, the branded identifier this
 * repository already uses for the same noun (see `contracts/src/ids.ts`, and
 * `SessionBindingRef.organizationId` on the relay wire). It is validated with
 * `isIdentifier`, exactly as every other organization identifier here is.
 *
 * It is REQUIRED and NOT nullable, and that is a deliberate difference from
 * `SessionBindingRef`, where `organizationId: OrganizationId | null` encodes a
 * personal workspace. A routing header may legitimately say "no organization";
 * a verdict may not, because the whole point of the field is that the issuing
 * authority is nameable. A null here would restore the ambiguity it exists to
 * remove, and a consumer could not tell "personal" from "unstated".
 *
 * THE SHAPE OF ATTRIBUTION, NOT PROOF OF IT. Both halves are unsigned and
 * self-declared: nothing in this record establishes that the named
 * organization exists, that the named actor belongs to it, or that either ran
 * the evaluation. A record may name any organization it likes. This makes a
 * verdict ATTRIBUTABLE — there is now a party to point at and to hold to it —
 * and it does not make it ATTESTED. Binding an issuer to a key is a separate
 * concern living in `device-auth` and `remote-protocol`.
 */
export type VerdictIssuer = {
  /** WHICH issuing authority. Disambiguates identically-named principals. */
  readonly organizationId: OrganizationId;
  /** WHO within it concluded the verdict. The canonical `Actor` union. */
  readonly actor: Actor;
};

/**
 * An independent assessment of whether completed work satisfied its request.
 *
 * This is the artifact the business is sold on, and until now it existed only
 * inside `vinci-acceptance/packages/protocol` while `@getsimpledirect/vinci-contracts` held the
 * status and the staleness rules but not the record carrying them. That is the
 * drift this repository exists to close, sitting on the one thing customers buy.
 *
 * Two properties matter more than the field list.
 *
 * `scope` is required and non-empty because a verdict is a statement about
 * something specific. "The code is correct" is not a verdict anyone can rely
 * on; "the requested endpoint returns 404 for unknown ids, verified by
 * execution against commit abc123" is. A verdict that will not say what it
 * covered is claiming everything.
 *
 * `snapshotDigest` binds the conclusion to the exact artifact evaluated. A
 * verdict that floats free of what it examined cannot be checked later, and
 * cannot be told apart from a stale one.
 *
 * TWO VERSIONS ARE LIVE. Version 1 is the shape below and nothing else;
 * version 2 adds a required `issuer`. They are declared as separate types with
 * separate validators rather than one type that was edited in place, because
 * version 1 declares `compatibility: "frozen"` and records written against it
 * exist. A v2-only validator would have made every one of them unreadable by
 * this package while `VERDICT_RECORD_V1_SCHEMA_META` still claimed they were a
 * supported contract. See {@link VerdictRecordV1}, {@link VerdictRecordV2} and
 * {@link validateVerdictRecordAny}.
 *
 * The fields common to both live here, in ONE declaration, so the fifteen that
 * did not change cannot drift between the two versions. A version is then that
 * common shape plus exactly what its version number adds — which is also what
 * makes "v2 adds one field" a statement the type system enforces rather than a
 * claim in a comment.
 */
export type VerdictRecordCommon = {
  readonly status: VerdictStatus;
  /** Exactly what was evaluated. */
  readonly snapshotDigest: string;
  readonly summary: string;
  /** What this verdict covers — and by implication, what it does not. */
  readonly scope: string;
  readonly criterionResults: readonly CriterionResult[];
  /** The evidence that actually decided it, not everything gathered. */
  readonly decisiveEvidenceIds: readonly EvidenceId[];
  readonly unresolvedConditions: readonly UnresolvedCondition[];
  readonly residualRisks: readonly ResidualRisk[];
  /** What was not checked, and why. Silence about coverage reads as coverage. */
  readonly notTested: readonly NotTestedItem[];
  readonly policyVersion: string;
  /** Which evaluator produced this, so a bad one can be found later. */
  readonly evaluatorVersion: string;
  readonly issuedAt: Timestamp;
  readonly expiresAt: Timestamp | null;
  readonly staleWhen: readonly StalenessCondition[];
};

/**
 * The frozen version 1 verdict record: the common fields and nothing else.
 *
 * This type is UNCHANGED. `VERDICT_RECORD_V1_SCHEMA_META` declares
 * `compatibility: "frozen"`, and frozen is a promise to the records already
 * written, not a label on the newest shape. Adding `issuer` here would have
 * broken that promise; deleting this type in favour of v2 would have broken it
 * harder, by leaving every stored v1 record with no validator in this package
 * at all while the schema meta still said version 1 was a supported contract.
 *
 * It has no `issuer`, and that absence is the defect version 2 exists to close
 * — not a bug to be patched here. A v1 record is unattributed at the aggregate
 * level and must be read knowing that. The remedy is to RE-ISSUE it as a v2
 * record naming a real issuer, which only whoever stands behind the conclusion
 * can do; see the migration on {@link VERDICT_RECORD_V2_SCHEMA_META}.
 */
export type VerdictRecordV1 = VerdictRecordCommon & {
  readonly schemaVersion: 1;
};

/**
 * Version 2: the same verdict, now saying WHOSE conclusion it is.
 *
 * `issuer` names the issuing authority. Until version 2 this record had a
 * scope, a disposition and a subject digest but no issuer: attribution existed
 * one level down, on each `EvidenceRecord.attestation`, and on the harness
 * (`HarnessAttestation.issuedBy`), and was DROPPED at exactly the point the
 * items rolled up into the aggregate that states the conclusion. So the record
 * a consumer actually relies on said what was checked and how it came out
 * without saying whose word it was — and an unattributed verdict cannot be
 * audited, disputed, or weighed by the one distinction §8.1 turns on, which is
 * whether the issuer was the worker or someone independent of it.
 *
 * It carries TWO facts in one closed object, `organizationId` and `actor`,
 * because an actor alone does not identify an issuing authority: the `system`
 * arm is `{ kind: "system", component: string }`, and two different
 * organizations may each run a `control-plane`. See {@link VerdictIssuer} for
 * why the two travel together rather than as sibling fields.
 *
 * `actor` is the canonical `Actor` union and not a `verifierId` string, for the
 * same reason `EvidenceRecord` uses one: the `verifier` arm carries
 * `independent`, so a verifier that is NOT independent must disclose that
 * (FR-7.3) rather than be indistinguishable from one that is. Reusing the union
 * also means a worker issuing its own verdict is visible as `kind: "worker"`
 * instead of hiding behind a free-text id that could say anything.
 *
 * This is the SHAPE of attribution, not proof of it. Both the organization and
 * the actor are unsigned and self-declared; nothing in this record establishes
 * that the named issuer is the one who actually ran the evaluation, or that the
 * actor belongs to the organization it is recorded beside. It makes a verdict
 * ATTRIBUTABLE, not ATTESTED. Binding an issuer to a key is a separate concern
 * that lives in `device-auth` and `remote-protocol`.
 *
 * The version was BUMPED rather than the field added inside version 1, because
 * version 1's compatibility policy is `frozen` and a new required field is a
 * change. Frozen does not mean the shape may never change; it means it may not
 * change WITHIN a major version. `HARNESS_ATTESTATION_SCHEMA_META` and
 * `RUN_EVENT_SCHEMA_META` both set this precedent — bump and state the
 * migration, rather than edit a frozen shape in place and leave every record
 * already written claiming a `schemaVersion: 1` contract it does not satisfy.
 */
export type VerdictRecordV2 = VerdictRecordCommon & {
  readonly schemaVersion: 2;
  /**
   * The issuing authority: which organization, and which principal within it.
   * The actor half is snapshotted through `plainActor`, so a proxy cannot
   * answer one thing to the validator and another to the consumer.
   */
  readonly issuer: VerdictIssuer;
};

/**
 * A verdict record at whichever version it declares.
 *
 * The type a consumer reading STORED verdicts holds, because the version is a
 * property of the record and not of the reading code. Narrow it on
 * `schemaVersion`, which TypeScript discriminates: inside `if (v.schemaVersion
 * === 2)` the `issuer` is present and typed, and outside it the compiler
 * refuses to read a field version 1 does not have.
 */
export type VerdictRecordAny = VerdictRecordV1 | VerdictRecordV2;

/**
 * @deprecated Prefer the explicit {@link VerdictRecordV1}, {@link
 * VerdictRecordV2} or {@link VerdictRecordAny}.
 *
 * Kept, and kept pointing at VERSION 1, so that code written against this name
 * before version 2 existed still describes the records it was written to
 * describe. Re-pointing it at v2 would have silently changed the meaning of
 * every existing annotation rather than asking anyone to make a choice — an
 * importer would have kept compiling while the shape it was promising changed
 * underneath it. An unversioned name cannot follow the newest version without
 * doing that, so it stays put and says so.
 */
export type VerdictRecord = VerdictRecordV1;

/**
 * May this status be issued given these criterion results?
 *
 * The anti-unearned-pass rule, in one place. A VERIFIED_PASS alongside a
 * contradicted criterion is incoherent — something was found not to work and
 * the verdict says it all works. `CONDITIONAL` exists precisely for "it holds,
 * with caveats", and `BLOCKED` for "this could not be settled".
 *
 * An `unknown` criterion also bars a pass: unknown means the check ran and
 * settled nothing, which is not evidence of success. Treating unknown as
 * passing is how an evaluator issues confidence it did not earn — the failure
 * the strategy calls worse than having no evaluator at all.
 */
export function statusIsSupportedBy(
  status: VerdictStatus,
  criterionResults: readonly CriterionResult[],
): boolean {
  // This predicate is exported, so it is a public gate and not merely a helper
  // that `validateVerdictRecord` happens to call. It must not assume its caller
  // already validated anything: an external caller reaches it directly with
  // whatever it has, including a hostile array.
  // Snapshot through the SAME boundary the validator uses, before anything is
  // read. Array.isArray was chosen here because it inspects an internal slot and
  // runs no trap; that is true and was not enough.
  //
  // A Proxy whose TARGET is empty can report length 1 and hand back a fabricated
  // descriptor for index 0, and this returned true — a VERIFIED_PASS over zero
  // actual criteria, while the same value serialized to []. The stored record
  // and the predicate described different things. That is the identical
  // two-view defect already fixed for actors, in the one predicate the product's
  // commercial claim rests on. A revoked Proxy also threw, from Array.isArray
  // itself, out of a function documented never to throw.
  //
  // Deferring to toPlainRecord removes the second view rather than guarding it:
  // whatever serialization captures is the only thing anyone sees, so a
  // fabricating trap can only fabricate into an inert copy that then fails on
  // its own merits. It also ends a disagreement with validateVerdictRecord at
  // exactly 10,000 criteria, where this helper said yes and the validator said
  // no, because both now share one limit instead of maintaining two.
  const snapshot = toPlainRecord({ criterionResults });
  if (!snapshot.ok) return false;
  const inert = (snapshot.value as { criterionResults?: unknown }).criterionResults;
  if (!Array.isArray(inert)) return false;
  const results: readonly unknown[] = inert;

  // Establish the status is a status BEFORE applying status semantics.
  //
  // The old order asked `status !== "VERIFIED_PASS"` first, so every value that
  // is not literally that string — "NOT_A_STATUS", "", null, 7, undefined —
  // returned TRUE. For a predicate named "is this status supported by these
  // criteria", answering true for a status that does not exist is the same
  // unearned-confidence failure as the vacuous pass, reached from the other
  // side: garbage in, endorsement out.
  if (!isVerdictStatus(status)) return false;

  if (status !== "VERIFIED_PASS") return true;

  return everyEntryIsSupported(results);
}

/**
 * A verdict may not have more criteria than this.
 *
 * Not a real limit on verdicts — it is a refusal to walk an attacker-chosen
 * length. A hostile object can report a length of 2^32-1 and this loop would
 * run for hours. Fail closed instead.
 */
const MAX_CRITERIA = 10_000;

/**
 * Traverse the results WITHOUT calling anything the input supplied.
 *
 * `.every()` is not usable here, and the reasons stack up:
 *
 *   new Array(1)                     length 1, every() SKIPS the hole -> true
 *   arr.every = () => true           our callback never runs -> true
 *   Proxy with a throwing length/index trap  -> threw
 *
 * The first is the serious one. It is the vacuous pass again — VERIFIED_PASS
 * with zero actual criterion objects — arriving through a third door after
 * being closed twice, because a sparse array reports a non-zero length while
 * containing nothing. A length check and an `.every()` together still say yes.
 *
 * So every index from 0 to length-1 must be an OWN DATA property. A hole fails
 * (no descriptor), an accessor fails (no `value`), and an inherited element
 * fails. Nothing the caller provided — no `every`, no getter, no trap — is ever
 * invoked except reflective reads, which are wrapped narrowly.
 */
function everyEntryIsSupported(criterionResults: readonly unknown[]): boolean {
  let length: unknown;
  try {
    length = (criterionResults as { readonly length?: unknown }).length;
  } catch {
    return false;
  }
  if (typeof length !== "number" || !Number.isInteger(length) || length < 0) return false;
  // A pass backed by no criteria is not a pass. See the vacuous-pass note above.
  if (length === 0 || length > MAX_CRITERIA) return false;

  for (let index = 0; index < length; index += 1) {
    let entry: PropertyDescriptor | undefined;
    try {
      entry = Object.getOwnPropertyDescriptor(criterionResults, index);
    } catch {
      return false;
    }
    // undefined => a hole. No "value" => an accessor. Both refuse.
    if (entry === undefined || !("value" in entry)) return false;

    const result: unknown = entry.value;
    if (typeof result !== "object" || result === null || Array.isArray(result)) return false;

    // Read the OWN data property, without ever invoking a getter.
    //
    //   { get status() { throw } }          -> threw, from a function whose
    //                                          comment promises it does not
    //   Object.create({status:"supported"}) -> TRUE. An object with NO own
    //                                          status, inheriting one from its
    //                                          prototype, counted as supported.
    //
    // The second manufactures a pass: an attacker needs not a supported
    // criterion but a prototype that claims one.
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(result, "status");
    } catch {
      return false;
    }
    if (descriptor === undefined || !("value" in descriptor)) return false;
    if (descriptor.value !== "supported") return false;
  }

  return true;
}

/** Closed-shape check for one nested object: declared keys, nothing else. */
function nested(
  raw: unknown,
  path: string,
  keys: readonly string[],
  add: (path: string, code: string, message: string) => void,
): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    add(path, "invalid_type", "expected an object");
    return null;
  }
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      add(`${path}/${key}`, "unknown_field", "this record carries only its declared fields");
    }
  }
  return value;
}

/** Validate an array field, or record why it is not one. Never throws. */
function eachEntry(
  raw: unknown,
  path: string,
  add: (path: string, code: string, message: string) => void,
  visit: (entry: unknown, entryPath: string) => void,
): boolean {
  if (!Array.isArray(raw)) {
    add(path, "invalid_type", "expected an array");
    return false;
  }
  raw.forEach((entry, i) => visit(entry, `${path}/${i}`));
  return true;
}

/** The fields every live version of this record carries. */
const COMMON_FIELDS = [
  "schemaVersion", "status", "snapshotDigest", "summary", "scope", "criterionResults",
  "decisiveEvidenceIds", "unresolvedConditions", "residualRisks", "notTested",
  "policyVersion", "evaluatorVersion", "issuedAt", "expiresAt", "staleWhen",
] as const;

/** The versions this package can read. Anything else is refused, not guessed. */
export const VERDICT_RECORD_SCHEMA_VERSIONS = [1, 2] as const;
export type VerdictRecordSchemaVersion = (typeof VERDICT_RECORD_SCHEMA_VERSIONS)[number];

/**
 * The version-2 issuer guard: which organization, and which principal within it.
 *
 * Lifted into its own function because it is the ONLY field rule that differs
 * between the two live versions. Calling it from the version-2 branch keeps
 * the version-1 path byte-for-byte the code it always was, instead of a
 * version-1 path threaded through a version-2 function body.
 */
function validateIssuer(
  record: Readonly<Record<string, unknown>>,
  add: (path: string, code: string, message: string) => void,
): void {
  // --- the issuer: which organization, and which principal within it -----
  //
  // The two halves are checked SEPARATELY and report separate paths, because
  // they are separately absent. A record naming an actor with no organization
  // and a record naming an organization with no actor are different defects —
  // the first is a principal nobody can scope, the second an authority with no
  // principal — and collapsing them into one "issuer is wrong" issue would
  // leave a consumer unable to tell which fact it is missing.
  //
  // The actor half goes through plainActor rather than a local shape check.
  // plainActor is the single boundary this repository uses to decide "what is
  // this actor", and going through it is what keeps the answer the validator
  // reaches identical to the one a consumer reaches. A hand-rolled check here
  // would be a SECOND view of the same value, which is the exact defect
  // actor.ts documents at length: a proxy answered "worker" to reflection and
  // "independent verifier" to serialization, and a worker was authorized to
  // vouch for its own output.
  //
  // It also gets the per-arm rules for free — a verifier missing `independent`,
  // an actor of an unknown kind, a worker carrying `independent: true`, and a
  // blank identifier are all refused here without this file restating any of
  // them and drifting from the definition.
  const issuer: unknown = record.issuer;
  if (typeof issuer !== "object" || issuer === null || Array.isArray(issuer)) {
    // Separated from the per-half checks below so that a missing or non-object
    // issuer reports "there is no issuer" rather than the more specific
    // "this organization is not an identifier" or "this actor is inconsistent",
    // which would be claims about values that are not there at all.
    add(
      "/issuer",
      "required_field",
      "a verdict must name the authority that issued it; an unattributed conclusion cannot be audited or disputed",
    );
  } else {
    // Closed, like every other shape in this record: an issuer carrying a third
    // member is refused rather than silently narrowed to the two we read. An
    // unknown member here is how a second, unvalidated attribution gets carried
    // alongside the one the validator checked.
    const parts = issuer as Record<string, unknown>;
    for (const key of Object.keys(parts)) {
      if (key !== "organizationId" && key !== "actor") {
        add(`/issuer/${key}`, "unknown_field", "an issuer carries only its declared fields");
      }
    }

    // WHICH organization. Without it, `{ kind: "system", component:
    // "control-plane" }` names a component that two different organizations may
    // each operate, and two unrelated authorities produce byte-identical
    // attribution. Required and never null: a routing header may say "no
    // organization", a verdict may not, because a null would be
    // indistinguishable from an issuer that simply declined to say.
    if (!Object.hasOwn(parts, "organizationId")) {
      add(
        "/issuer/organizationId",
        "required_field",
        "a verdict must name the organization it was issued under; an actor id alone is not unique across organizations",
      );
    } else if (!isIdentifier(parts.organizationId)) {
      add("/issuer/organizationId", "invalid_id", "organizationId must be an identifier");
    }

    // WHO within it. An organization alone names an authority and no principal,
    // so §8.1's worker-versus-independent distinction has nothing to read.
    const actor: unknown = parts.actor;
    if (typeof actor !== "object" || actor === null || Array.isArray(actor)) {
      add(
        "/issuer/actor",
        "required_field",
        "a verdict must name the principal that concluded it; an organization alone does not say who",
      );
    } else if (plainActor(actor as Readonly<Record<string, unknown>>) === null) {
      add("/issuer/actor", "invalid_actor", "the issuing actor must be a consistent actor");
    }
  }
}

/**
 * Validate an ALREADY-SNAPSHOTTED record against ONE version's rules.
 *
 * Fail-closed, on an inert snapshot, as every validator in this repository is.
 *
 * Every field declared on the record is checked here. That sentence used to be
 * false: seven fields — `decisiveEvidenceIds`, `unresolvedConditions`,
 * `residualRisks`, `notTested`, `issuedAt`, `expiresAt` and `staleWhen` — were
 * declared in the type, documented in prose, and never looked at once, so the
 * cast at the end promised a shape the function had not established. A type
 * assertion is not a check; it is a claim that a check already happened.
 *
 * ONE body, parameterised by version, rather than two copies. The two versions
 * differ in exactly two ways — the accepted `schemaVersion` and whether
 * `issuer` is a declared field — and everything else is the same fifteen
 * fields with the same rules. Copying the body would have made "v1 still
 * validates exactly as it did" a claim that decayed with the next edit to
 * either copy; here the v1 path IS the original code, reached with `version`
 * bound to 1.
 *
 * Note what falls out of that for a version the record was not written for:
 * at version 1 `issuer` is NOT in the known set, so a v2 record reaches the v1
 * validator and is refused for two stated reasons — the wrong `schemaVersion`
 * and an undeclared `issuer` field — rather than being half-read or throwing.
 */
function validateAtVersion(
  record: Readonly<Record<string, unknown>>,
  version: VerdictRecordSchemaVersion,
): ValidationResult<VerdictRecordAny> {
  const issues: ValidationIssue[] = [];
  const add = (path: string, code: string, message: string) => issues.push({ path, code, message });

  const known = new Set<string>(COMMON_FIELDS);
  if (version === 2) known.add("issuer");
  for (const key of Object.keys(record)) {
    if (!known.has(key)) add(`/${key}`, "unknown_field", "a verdict carries only its declared fields");
  }

  if (record.schemaVersion !== version) {
    add("/schemaVersion", "invalid_schema_version", `this schema is version ${version}`);
  }

  // The issuer is a VERSION 2 field. At version 1 it is not merely unchecked:
  // it is not a declared field at all, so the closed-shape loop above has
  // already refused it as unknown_field. Silence here would have let a v2
  // record through the v1 validator with its issuer neither validated nor
  // rejected — accepted and unread, the worst of the three outcomes.
  if (version === 2) validateIssuer(record, add);
  if (!isVerdictStatus(record.status)) {
    add("/status", "invalid_enum", "a verdict status is VERIFIED_PASS, CONDITIONAL or BLOCKED");
  }
  if (!isDigest(record.snapshotDigest)) {
    add("/snapshotDigest", "invalid_digest", "snapshotDigest must be 64 lowercase hex characters (sha-256, no prefix); "
          + "a verdict binds to the exact artifact it evaluated");
  }
  for (const field of ["summary", "scope", "policyVersion", "evaluatorVersion"] as const) {
    if (!isNonBlankText(record[field])) {
      add(
        `/${field}`,
        "required_field",
        field === "scope"
          ? "scope must say what this verdict covers; a verdict that will not say is claiming everything"
          : `${field} must be a non-empty string`,
      );
    }
  }

  // --- criterion results -------------------------------------------------
  const results: CriterionResult[] = [];
  const citedEvidence = new Set<string>();
  const seenCriterionIds = new Set<string>();
  const criteriaAreArray = eachEntry(record.criterionResults, "/criterionResults", add, (raw, path) => {
    const r = nested(raw, path, ["criterionId", "status", "summary", "evidenceIds"], add);
    if (r === null) return;
    if (!(CRITERION_RESULT_STATUSES as readonly unknown[]).includes(r.status)) {
      add(`${path}/status`, "invalid_enum", "unrecognised criterion result status");
    }
    if (!isIdentifier(r.criterionId)) {
      add(`${path}/criterionId`, "required_field", "criterionId must be an identifier");
    } else if (seenCriterionIds.has(r.criterionId)) {
      // Two results for one criterion let a contradicted finding be paired with
      // a supported one and the reader pick whichever they prefer.
      add(`${path}/criterionId`, "duplicate_criterion", "a criterion may have exactly one result");
    } else {
      seenCriterionIds.add(r.criterionId);
    }
    if (!isNonBlankText(r.summary)) {
      add(`${path}/summary`, "required_field", "summary must be a non-empty string");
    }
    // A conclusion resting on no evidence is an opinion.
    if (!Array.isArray(r.evidenceIds) || r.evidenceIds.length === 0) {
      add(`${path}/evidenceIds`, "evidence_required", "a criterion result must cite the evidence it rests on");
    } else {
      const seen = new Set<string>();
      r.evidenceIds.forEach((id, j) => {
        if (!isIdentifier(id)) {
          add(`${path}/evidenceIds/${j}`, "invalid_id", "an evidence id is an identifier");
          return;
        }
        if (seen.has(id)) {
          add(`${path}/evidenceIds/${j}`, "duplicate_id", "an evidence id appears once per result");
        }
        seen.add(id);
        citedEvidence.add(id);
      });
    }
    results.push(r as unknown as CriterionResult);
  });

  // --- decisive evidence -------------------------------------------------
  const decisiveIds: string[] = [];
  eachEntry(record.decisiveEvidenceIds, "/decisiveEvidenceIds", add, (id, path) => {
    if (!isIdentifier(id)) {
      add(path, "invalid_id", "an evidence id is an identifier");
      return;
    }
    if (decisiveIds.includes(id)) add(path, "duplicate_id", "a decisive evidence id appears once");
    decisiveIds.push(id);
  });

  // --- conditions, risks, coverage, staleness ----------------------------
  eachEntry(record.unresolvedConditions, "/unresolvedConditions", add, (raw, path) => {
    const c = nested(raw, path, ["description", "requiredAction"], add);
    if (c === null) return;
    if (!isNonBlankText(c.description)) add(`${path}/description`, "required_field", "description must be non-empty");
    // A condition with no action is a worry, not a finding.
    if (!isNonBlankText(c.requiredAction)) {
      add(`${path}/requiredAction`, "required_field", "a condition must say what someone must DO");
    }
  });

  eachEntry(record.residualRisks, "/residualRisks", add, (raw, path) => {
    const r = nested(raw, path, ["description", "severity"], add);
    if (r === null) return;
    if (!isNonBlankText(r.description)) add(`${path}/description`, "required_field", "description must be non-empty");
    if (!(RISK_SEVERITIES as readonly unknown[]).includes(r.severity)) {
      add(`${path}/severity`, "invalid_enum", "severity is low, medium, high or critical");
    }
  });

  eachEntry(record.notTested, "/notTested", add, (raw, path) => {
    const n = nested(raw, path, ["description", "reason"], add);
    if (n === null) return;
    if (!isNonBlankText(n.description)) add(`${path}/description`, "required_field", "description must be non-empty");
    // "not tested" with no reason is indistinguishable from an oversight.
    if (!isNonBlankText(n.reason)) add(`${path}/reason`, "required_field", "say why it was not tested");
  });

  eachEntry(record.staleWhen, "/staleWhen", add, (raw, path) => {
    const s = nested(raw, path, ["trigger", "value"], add);
    if (s === null) return;
    if (!(VERDICT_STALENESS_TRIGGERS as readonly unknown[]).includes(s.trigger)) {
      add(`${path}/trigger`, "invalid_enum", "unrecognised staleness trigger");
    }
    if (!isNonBlankText(s.value)) add(`${path}/value`, "required_field", "a staleness condition watches a value");
  });

  // --- time --------------------------------------------------------------
  if (!isCanonicalTimestamp(record.issuedAt)) {
    add("/issuedAt", "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z");
  }
  if (record.expiresAt !== null) {
    if (!isCanonicalTimestamp(record.expiresAt)) {
      add("/expiresAt", "invalid_timestamp", "expiresAt is a canonical timestamp or explicitly null");
    } else if (!isStrictlyAfter(record.expiresAt, record.issuedAt)) {
      // An expiry at or before issuance is a verdict born expired, which reads
      // to a consumer as "valid" for as long as nobody checks the clock.
      add("/expiresAt", "expiry_not_after_issuance", "expiresAt must be strictly later than issuedAt");
    }
  }

  // --- the anti-unearned-pass rule, enforced rather than documented -------
  if (isVerdictStatus(record.status) && criteriaAreArray) {
    if (!statusIsSupportedBy(record.status, results)) {
      add(
        "/status",
        "unearned_pass",
        "VERIFIED_PASS requires at least one criterion and every criterion supported; CONDITIONAL and BLOCKED exist for anything less",
      );
    }
    if (record.status === "VERIFIED_PASS") {
      // A pass is a claim that nothing is outstanding. Each of these says
      // something IS outstanding, in the same record.
      if (Array.isArray(record.unresolvedConditions) && record.unresolvedConditions.length > 0) {
        add("/status", "unearned_pass", "a pass with unresolved conditions is a CONDITIONAL verdict");
      }
      if (Array.isArray(record.notTested) && record.notTested.length > 0) {
        add("/status", "unearned_pass", "a pass cannot leave criteria untested; that is CONDITIONAL");
      }
      if (decisiveIds.length === 0) {
        add("/decisiveEvidenceIds", "evidence_required", "a pass must name the evidence that decided it");
      }
    }
  }

  // Exact duplicates in the descriptive arrays are refused.
  //
  // This was an open question in the repair matrix, so here is the decision and
  // its reasoning rather than silence. An entry identical in EVERY field to one
  // already present carries no information: it cannot describe a second,
  // different risk or condition, because everything that distinguishes one from
  // another is the same. Its only effect is to inflate a count, which matters
  // because "three residual risks" reads as more thorough scrutiny than "one".
  //
  // Deliberately EXACT duplicates only. Two risks sharing a description but
  // differing in severity are two genuine risks and are allowed, as are two
  // untested items with the same reason and different descriptions. Comparison
  // is by canonical encoding so key order cannot be used to smuggle a duplicate
  // past a shallow check.
  for (const field of ["unresolvedConditions", "residualRisks", "notTested", "staleWhen"] as const) {
    const entries = record[field];
    if (!Array.isArray(entries)) continue;
    const seen = new Set<string>();
    entries.forEach((entry, i) => {
      let key: string;
      try {
        key = canonicalize(entry);
      } catch {
        // Not canonicalizable; the shape checks above have already recorded why.
        return;
      }
      if (seen.has(key)) {
        add(`/${field}/${i}`, "duplicate_entry", "an identical entry is already present and adds nothing");
      }
      seen.add(key);
    });
  }

  // Decisive evidence must actually appear in the reasoning. Otherwise a record
  // can cite an impressive id that no criterion ever used.
  for (const [i, id] of decisiveIds.entries()) {
    if (!citedEvidence.has(id)) {
      add(
        `/decisiveEvidenceIds/${i}`,
        "uncited_evidence",
        "decisive evidence must be cited by a criterion result",
      );
    }
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as VerdictRecordAny, {});
}

/**
 * Validate a VERSION 1 verdict record from untrusted input.
 *
 * The frozen contract, still independently readable. A record written against
 * version 1 and valid then is valid here now, and nothing about version 2
 * reaches it: `issuer` is not a declared field at this version, so a v2 record
 * arriving here is refused — for the wrong version AND for the undeclared
 * field — rather than silently accepted with its attribution unchecked.
 */
export function validateVerdictRecordV1(input: unknown): ValidationResult<VerdictRecordV1> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  return validateAtVersion(plain.value, 1) as ValidationResult<VerdictRecordV1>;
}

/**
 * Validate a VERSION 2 verdict record from untrusted input.
 *
 * Version 2 requires `issuer`. A v1 record is REFUSED here and never
 * up-converted: see the migration on {@link VERDICT_RECORD_V2_SCHEMA_META} for
 * why no default issuer would be honest.
 */
export function validateVerdictRecordV2(input: unknown): ValidationResult<VerdictRecordV2> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  return validateAtVersion(plain.value, 2) as ValidationResult<VerdictRecordV2>;
}

/**
 * @deprecated Prefer {@link validateVerdictRecordV1}, {@link
 * validateVerdictRecordV2} or {@link validateVerdictRecordAny}, which say which
 * contract they are enforcing.
 *
 * Kept, and kept bound to VERSION 1, for the reason {@link VerdictRecord} is:
 * an importer that wrote `validateVerdictRecord(x)` before version 2 existed
 * was enforcing the version-1 contract, and re-pointing this name at version 2
 * would have changed what their code accepts without their touching it —
 * turning a schema addition into a silent runtime rejection of every record
 * they had. An unversioned name cannot track the newest version without doing
 * that, so it does not try.
 */
export const validateVerdictRecord = validateVerdictRecordV1;

/**
 * Validate a verdict record at WHATEVER version it declares.
 *
 * This earns its place rather than being a convenience wrapper, and the reason
 * is the one hazard this file already spends hundreds of lines on: two views of
 * the same value.
 *
 * The obvious thing for a consumer holding a stored record to write is
 *
 *     if ((input as { schemaVersion?: unknown }).schemaVersion === 2) …
 *
 * and that reads `schemaVersion` off the HOSTILE INPUT, before any snapshot. A
 * proxy or a getter can answer 1 to that dispatch and serialize as 2 — so the
 * v1 validator runs, `issuer` is refused as an unknown field or never looked
 * at, and what is stored afterwards is a version-2 record nobody validated at
 * version 2. Every consumer that dispatches for itself has to get this right
 * independently, and the failure is invisible when it does not.
 *
 * So the snapshot is taken ONCE, here, and the version is read from the INERT
 * copy. Whatever `toPlainRecord` captured is both the value that chooses the
 * validator and the value the validator inspects; there is no second view for a
 * trap to differ in. The returned type is a discriminated union, so a consumer
 * narrows on `schemaVersion` against a value that has already been checked.
 *
 * An unrecognised version is REFUSED with the versions this package actually
 * supports, not silently coerced to the nearest one. Reading a version-3 record
 * with version-2 rules would report it as valid against a contract it was never
 * written for.
 */
export function validateVerdictRecordAny(input: unknown): ValidationResult<VerdictRecordAny> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const declared: unknown = record.schemaVersion;
  for (const version of VERDICT_RECORD_SCHEMA_VERSIONS) {
    if (declared === version) return validateAtVersion(record, version);
  }
  return fail([
    {
      path: "/schemaVersion",
      code: "invalid_schema_version",
      message:
        `a verdict record declares schemaVersion ${VERDICT_RECORD_SCHEMA_VERSIONS.join(" or ")}; `
        + "an unrecognised version is refused rather than read with another version's rules",
    },
  ]);
}

/**
 * VERSION 1, still frozen and still exported.
 *
 * UNCHANGED from before version 2 existed, deliberately and in every field.
 * `compatibility: "frozen"` is not relaxed to `additive-only` to make the new
 * field legal here — that would be editing the rule to fit the change — and
 * `migration: "none"` remains the honest answer at version 1, which is also the
 * only version at which the gate accepts it.
 *
 * It is kept rather than replaced because records written against it exist, and
 * a schema meta that vanishes when the next version ships leaves a consumer
 * holding those records with no statement of what they were required to carry.
 */
export const VERDICT_RECORD_V1_SCHEMA_META: SchemaMeta = {
  id: "vinci.verdict-record",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};

/**
 * @deprecated Name the version: {@link VERDICT_RECORD_V1_SCHEMA_META} or
 * {@link VERDICT_RECORD_V2_SCHEMA_META}.
 *
 * Bound to version 1 for the same reason the other unversioned names are: it is
 * what an importer reading this constant before version 2 existed was told.
 */
export const VERDICT_RECORD_SCHEMA_META: SchemaMeta = VERDICT_RECORD_V1_SCHEMA_META;

export const VERDICT_RECORD_V2_SCHEMA_META: SchemaMeta = {
  id: "vinci.verdict-record",
  /**
   * BUMPED to 2 by the addition of `issuer`.
   *
   * Under a `frozen` policy a new field is not an additive change that a
   * version may absorb — frozen means no change within a major version. The
   * alternative was to relax this record to `additive-only` so the field became
   * legal, and that would be editing the rule to fit the change: the policy is
   * `frozen` because a verdict is the artifact the commercial claim rests on,
   * and a consumer must be able to know from `schemaVersion` alone exactly
   * which fields a record was required to carry.
   */
  version: 2,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  /**
   * REFUSED, not up-converted, and the missing fact is the whole reason.
   *
   * A v1 verdict records neither the organization nor the principal that issued
   * it. There is no field to read either from and no safe default: `system`
   * would attribute a human sign-off to a machine, a `verifier` with
   * `independent: true` would manufacture the exact disclosure FR-7.3 exists to
   * force, and there is no organization to fall back on at all — deriving one
   * from the reader's own tenancy would stamp every imported verdict with the
   * importer's name. Inventing an issuer for a record that never named one is
   * worse than refusing it, because the invented issuer is indistinguishable
   * from an observed one once written.
   */
  migration:
    "v1 records remain readable, unchanged, through validateVerdictRecordV1, which is still exported and still "
    + "frozen; v2 adds a required issuer "
    + "({ organizationId, actor }) naming the authority that concluded the verdict and the principal within it, "
    + "which v1 never recorded at the aggregate level; a v2 consumer refuses a v1 record on schemaVersion rather "
    + "than up-converting it, because there is no field either half could be derived from and any default would "
    + "fabricate an attribution — the issuer must be re-stated by whoever re-issues the verdict",
};
