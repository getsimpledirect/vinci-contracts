import {
  fail,
  ok,
  toPlainRecord,
  type Actor,
  type PlainRecord,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import { digestValidated } from "./digest.ts";
import {
  AUTHORITY_TERMS,
  SUPPORTED_SCHEMA_VERSIONS,
  checkSchemaVersion,
  isCanonicalTimestamp,
  isDigest,
  isIdentifier,
  isNonBlankText,
  isObjectRecord,
  isPositiveInt,
  isRefText,
  issue,
  plainActor,
  readRefArray,
  rejectAuthorityFieldsInPayload,
  rejectUnknownFields,
} from "./lib/validate.ts";

/**
 * CON-03, as a type rather than a naming convention.
 *
 * The rule is that a model may PROPOSE a citation or a recommendation, and the
 * host RESOLVES the source ids, principal identities, artifact digests, tool
 * observations and cost receipts. Every version of that rule this repository
 * has met elsewhere was a convention — "the fields the model writes live under
 * `content`" — and a convention is enforced by whoever remembers it. INV-01
 * says no generated report, confidence score, tool argument or persona
 * statement can confer execution authority, and "we agreed where to put things"
 * is not a mechanism by which that can be true.
 *
 * So the split is structural, in three layers that fail independently:
 *
 *   1. The record is two disjoint subtrees. `hostResolved` and the envelope's
 *      own fields are written by the attesting component; `payload` is
 *      everything a model or a requester wrote. There is no third place.
 *   2. `ModelAuthored<T>` maps any authority-bearing key name in a payload type
 *      to `never`, so a payload type that declares one does not COMPILE.
 *   3. Each RECORD's own payload allowlist runs at every depth, so a key the
 *      schema does not declare is refused wherever it appears. This is the
 *      layer that actually holds: it is a closed list of what a payload MAY
 *      carry, so it does not depend on anyone predicting what an attacker
 *      would call the thing they are smuggling.
 *   4. `validateAttestedEnvelope` additionally walks the payload subtree and
 *      refuses a key containing one of `AUTHORITY_TERMS`' fourteen word stems,
 *      with its own issue code, so the common spellings are named rather than
 *      reported as unknown fields.
 *
 * LAYER 4 IS A NET, NOT A DEFINITION OF AUTHORITY, and an earlier version of
 * this comment overstated it as "refuses an authority-bearing key by name, at
 * any depth". A review refuted that in minutes: `authorizedBy`, `approvalRef`,
 * `entitlements`, `privileges`, `capabilities`, `roleAssignment`, `clearance`,
 * `canMerge`, `signedBy`, `sudo` and `runAs` all pass it — "authorized" does
 * not contain the stem "authority". Twenty-one such spellings were found. NO
 * RECORD IN THIS PACKAGE IS EXPLOITABLE BY THEM, because layer 3 refuses every
 * undeclared key regardless of spelling, and `src/authority-terms.test.ts`
 * pins exactly that: it shows the stem walk does NOT fire on
 * `payload.completion.authorizedBy` and that the record's allowlist does. The
 * day someone adds a free-form payload subtree — a map, a passthrough object —
 * layer 3 stops covering it and layer 4 will not catch what it lets through.
 * Enumerating more stems would be the same defect one level up.
 *
 * The positive reachability control for all three is that the SAME field name
 * is accepted on the envelope: `contextManifestDigest` is a required host field
 * here and is refused inside `payload`. A rule that refused the name everywhere
 * would be a rule about spelling. This one is about who resolved the value.
 */

export { AUTHORITY_TERMS };
export type AuthorityTerm = (typeof AUTHORITY_TERMS)[number];

/** Does the key name `S`, case-folded, contain an authority term? */
export type ContainsAuthorityTerm<S extends string> =
  Lowercase<S> extends `${string}${AuthorityTerm}${string}` ? true : false;

type ModelAuthoredValue<V> = V extends readonly (infer E)[]
  ? readonly ModelAuthoredValue<E>[]
  : V extends string | number | boolean | null
    ? V
    : V extends object
      ? ModelAuthored<V>
      : V;

/**
 * A payload shape with every authority-bearing key mapped to `never`.
 *
 * `never` rather than "omitted": omitting the key would let a wider type add it
 * back, while `never` makes the property unsatisfiable, so the object literal
 * that would carry it fails to compile where someone writes it. Applied
 * recursively, because `{ basis: { grantRef } }` is the same claim one level
 * down.
 */
export type ModelAuthored<T> = {
  readonly [K in keyof T]: ContainsAuthorityTerm<K & string> extends true
    ? never
    : ModelAuthoredValue<T[K]>;
};

// The compile-time half of CON-03, proven where something checks it. `tsc
// --build` compiles this file; a *.test.ts is excluded from the build and this
// repository's eslint config is not type-aware, so the same three lines written
// as a test would be checked by nothing at all.
type _AuthorityKeyMapped = ModelAuthored<{ policyRef: string }>["policyRef"];
const _authorityKeyIsNever: [_AuthorityKeyMapped] extends [never] ? true : false = true;
// Nested, one level down, where a top-level-only rule would say nothing.
type _NestedAuthorityKeyMapped = ModelAuthored<{ basis: { grantRef: string } }>["basis"]["grantRef"];
const _nestedAuthorityKeyIsNever: [_NestedAuthorityKeyMapped] extends [never] ? true : false = true;
// THE REACHABILITY CONTROL. Without it a `ModelAuthored` that mapped every key
// to `never` would satisfy both proofs above while making the type useless.
type _OrdinaryKeyMapped = ModelAuthored<{ question: string }>["question"];
const _ordinaryKeySurvives: [_OrdinaryKeyMapped] extends [never] ? false : true = true;

/** Which record a given envelope carries. */
export const ATTESTED_ENVELOPE_KINDS = [
  "oracle_research_request",
  "oracle_source_citation",
  // A proposal is model-authored and therefore lives in the same envelope as
  // the other two, rather than in a mechanism of its own. PROP-01 says a
  // STOP_PROPOSAL does not terminate a job and an IMPLEMENTATION_PROPOSAL does
  // not open a PR; the reason it CANNOT is that the half a model writes is the
  // payload, and the payload is where an authority-bearing key does not
  // compile and is refused at runtime. A second mechanism would be a second
  // thing to keep correct.
  "oracle_decision_proposal",
] as const;
export type AttestedEnvelopeKind = (typeof ATTESTED_ENVELOPE_KINDS)[number];

/**
 * Who attested this envelope, and at what version.
 *
 * CON-04 versions every record AND every transformation. The component that
 * resolved these fields is part of what the attestation means: the same
 * envelope shape resolved by an admission host and by a replay tool are not the
 * same claim, and a consumer that cannot tell them apart cannot act on either.
 */
export type AttestingComponent = {
  readonly component: string;
  readonly version: string;
};

/**
 * A model-authored payload inside a runtime-attested envelope.
 *
 * `THost` is the record-specific half the host resolved; `TPayload` is the half
 * a model or a requester wrote. Every field of the envelope itself is
 * host-resolved, which is why identity, authority and budget live here and
 * nowhere else.
 */
export type AttestedEnvelope<THost, TPayload> = {
  readonly schemaVersion: 1;
  readonly envelopeKind: AttestedEnvelopeKind;
  readonly workspaceRef: string;
  readonly principal: Actor;
  readonly runRef: string;
  readonly workOrderRef: string;
  readonly policyRef: string;
  readonly policyVersion: number;
  readonly grantRefs: readonly string[];
  /**
   * The parent budget reservation, or explicitly `null` when the work runs
   * inside its caller's reservation.
   *
   * The key is REQUIRED and the value may be null. CON-02 forbids collapsing
   * missing and null, and here they mean opposite things: absent says the
   * attesting component never considered the budget, which is a state no
   * envelope may be admitted in; null says it considered it and there is none.
   */
  readonly budgetReservationRef: string | null;
  readonly contextManifestDigest: string;
  readonly issuedAt: string;
  readonly attestedBy: AttestingComponent;
  readonly hostResolved: THost;
  readonly payload: TPayload;
};

/**
 * The envelope's own field names: the closed list of what the host resolves.
 *
 * Exported because it is the contract a consumer checks against, and because
 * CON-03's reachability control is "this exact name is accepted here and
 * refused in the payload" — a test needs the list to make that a property of
 * the whole set rather than of one hand-picked example.
 */
export const HOST_ATTESTED_FIELDS = [
  "schemaVersion",
  "envelopeKind",
  "workspaceRef",
  "principal",
  "runRef",
  "workOrderRef",
  "policyRef",
  "policyVersion",
  "grantRefs",
  "budgetReservationRef",
  "contextManifestDigest",
  "issuedAt",
  "attestedBy",
  "hostResolved",
  "payload",
] as const;

export { SUPPORTED_SCHEMA_VERSIONS };

/**
 * Is `value` a schema version this build can read?
 *
 * T07's mechanism, isolated so there is one answer to the question rather than
 * one per record. CON-04 exists because a parser or schema upgrade must not
 * silently convert one meaning into another, and the way that happens is a
 * version check that is subtly different in each of five files.
 */
export function isSupportedSchemaVersion(value: unknown): value is 1 {
  return (SUPPORTED_SCHEMA_VERSIONS as readonly unknown[]).includes(value);
}

/**
 * Validate the host-attested half of an envelope, leaving both record-specific
 * halves opaque.
 *
 * A record's own validator calls this first and then validates `hostResolved`
 * and `payload` against its own shapes. The split means CON-03 is applied in
 * exactly one place for every record in this package: a new record cannot
 * forget it, because there is no other way to build an envelope.
 */
export function validateAttestedEnvelope(
  input: unknown,
): ValidationResult<AttestedEnvelope<PlainRecord, PlainRecord>> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];

  rejectUnknownFields(record, HOST_ATTESTED_FIELDS, "", "an attested envelope", issues);
  checkSchemaVersion(record.schemaVersion, "/schemaVersion", issues);

  if (!(ATTESTED_ENVELOPE_KINDS as readonly string[]).includes(record.envelopeKind as string)) {
    issues.push(
      issue(
        "/envelopeKind",
        "unknown_envelope_kind",
        "envelopeKind must come from ATTESTED_ENVELOPE_KINDS; an unrecognised discriminator is "
          + "refused rather than approximately matched",
      ),
    );
  }

  for (const field of ["workspaceRef", "runRef", "workOrderRef", "policyRef"] as const) {
    if (!isIdentifier(record[field])) {
      issues.push(issue(`/${field}`, "invalid_id", `${field} is a host-assigned identifier`));
    }
  }

  if (!isPositiveInt(record.policyVersion)) {
    issues.push(
      issue("/policyVersion", "invalid_type", "policyVersion is an integer of at least 1"),
    );
  }

  const principal = record.principal;
  if (!isObjectRecord(principal) || plainActor(principal) === null) {
    issues.push(
      issue(
        "/principal",
        "invalid_actor",
        "principal must be an actor carrying exactly its own kind's fields (see ACTOR_FIELDS)",
      ),
    );
  }

  readRefArray(record.grantRefs, "/grantRefs", "grantRefs", issues);

  // Required KEY, nullable VALUE. Absent means the budget was never considered;
  // null means it was considered and there is none. See the field's comment.
  if (!Object.hasOwn(record, "budgetReservationRef")) {
    issues.push(
      issue(
        "/budgetReservationRef",
        "required_field",
        "budgetReservationRef is required and may be null; absent and null are different claims",
      ),
    );
  } else if (record.budgetReservationRef !== null && !isRefText(record.budgetReservationRef)) {
    issues.push(
      issue(
        "/budgetReservationRef",
        "invalid_ref",
        "budgetReservationRef is a ref or explicitly null",
      ),
    );
  }

  if (!isDigest(record.contextManifestDigest)) {
    issues.push(
      issue(
        "/contextManifestDigest",
        "invalid_digest",
        "contextManifestDigest is 64 lowercase hex characters; the host resolves it and the "
          + "model never states it",
      ),
    );
  }

  if (!isCanonicalTimestamp(record.issuedAt)) {
    issues.push(
      issue("/issuedAt", "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision"),
    );
  }

  const attestedBy = record.attestedBy;
  if (!isObjectRecord(attestedBy)) {
    issues.push(issue("/attestedBy", "invalid_type", "attestedBy is an object"));
  } else {
    rejectUnknownFields(attestedBy, ["component", "version"], "/attestedBy", "attestedBy", issues);
    if (!isRefText(attestedBy.component)) {
      issues.push(
        issue(
          "/attestedBy/component",
          "required_field",
          "attestedBy.component names the attesting component",
        ),
      );
    }
    if (!isNonBlankText(attestedBy.version) || attestedBy.version.length > 64) {
      issues.push(
        issue(
          "/attestedBy/version",
          "required_field",
          "attestedBy.version is the attesting component's version",
        ),
      );
    }
  }

  if (!isObjectRecord(record.hostResolved)) {
    issues.push(issue("/hostResolved", "invalid_type", "hostResolved is an object"));
  }

  const payload = record.payload;
  if (!isObjectRecord(payload)) {
    issues.push(issue("/payload", "invalid_type", "payload is an object"));
  } else {
    // CON-03. Runs on the payload subtree only, and with its own code, so the
    // refusal a consumer sees names the mechanism that refused rather than
    // whichever unrelated allowlist would have refused anyway.
    rejectAuthorityFieldsInPayload(payload as PlainRecord, "/payload", issues);
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as AttestedEnvelope<PlainRecord, PlainRecord>, {});
}

/** The identity of an attested envelope: SHA-256 over its canonical, validated bytes. */
export function attestedEnvelopeDigest(
  envelope: AttestedEnvelope<PlainRecord, PlainRecord>,
): string {
  return digestValidated("attested envelope", validateAttestedEnvelope(envelope));
}

export const ATTESTED_ENVELOPE_SCHEMA_META: SchemaMeta = {
  id: "vinci.oracle.attested-envelope",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};
