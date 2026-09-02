import {
  fail,
  isCanonicalTimestamp,
  isDigest,
  isIdentifier,
  isNonBlankText,
  isStrictlyAfter,
  ok,
  plainActor,
  toPlainRecord,
  type Actor,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import { HARNESS_CAPABILITIES, type HarnessCapability } from "@getsimpledirect/vinci-model-classes";
import { digestValidated } from "./digest.ts";
import {
  isEnumMember,
  isGitObjectId,
  isObjectRecord,
  isPositiveInt,
  issue,
  rejectUnknownFields,
} from "./lib/validate.ts";

/**
 * What a harness has actually established about itself, per capability.
 *
 * `matchEndpointToRole` (model-classes) cannot confirm a harness capability —
 * an inference endpoint has no way to edit a repository — so it withholds
 * eligibility for any role that requires one until a CALLER hands it a list of
 * capabilities the harness has established. This record is where that list
 * comes from. Each entry names the capability, the self-test that proved it,
 * its result, and WHAT ARTIFACT was observed running the self-test.
 *
 * v1 asked the wrong question of that last field. It offered
 * `installed_worker | source_checkout` and counted only `installed_worker`, on
 * the reasoning that a capability proven on a source checkout says nothing
 * about the installed artifact that will run the job. The reasoning is right;
 * the field was not. DELIVERY MECHANISM was standing in for a property it does
 * not determine — whether the artifact's IDENTITY IS BOUND — and the measured
 * deployment made the substitution fail in the worst direction. Production
 * workers run the daemon from `/opt/vinci-code-cli`, a root-owned git checkout
 * deployed by `git fetch` + `git checkout --detach <sha>` + a systemd restart,
 * announcing `worker_build=<40-hex sha>` on the bus; the release repository has
 * no worker packaging path at all. Under v1 no production worker could ever be
 * attested, so every advanced role stayed `unevaluable
 * [harness_capabilities_unverified]` permanently — the exact verdict this
 * record exists to clear. The guard could not stop a determined actor (nothing
 * checks the label) and reliably stopped the compliant one.
 *
 * v2 asks about identity instead (`OBSERVED_ENTRYPOINTS` below). A checkout is
 * attestable when it is PINNED — an exact commit and a recomputable tree — and
 * a working tree is never attestable, however it was delivered.
 */
export type HarnessAttestation = {
  readonly schemaVersion: 2;
  readonly attestationId: string;
  readonly runtimeBuild: string;
  readonly environmentDigest: string;
  readonly workerPrincipalId: string;
  readonly capabilities: readonly AttestedCapability[];
  readonly createdAt: string;
  readonly expiresAt: string;
  /** Who issued the attestation. Snapshotted through plainActor, so a proxy cannot lie about it. */
  readonly issuedBy: Actor;
};

export const ATTESTATION_STATUSES = ["PASS", "FAIL", "SKIPPED"] as const;
export type AttestationStatus = (typeof ATTESTATION_STATUSES)[number];

/**
 * WHAT was observed running the self-test, by how its identity is bound.
 *
 * - `installed_package` — an installed package artifact, the shape the
 *   control-plane server gets via install.sh. Its identity is the package the
 *   registry resolved and its contents are not editable in place by the run.
 * - `pinned_checkout` — a working copy at an exact recorded commit with a clean
 *   tree. This is what a production worker actually is, and it is attestable
 *   BECAUSE the pin makes its identity recomputable, not because of how the
 *   bytes arrived. It must carry `checkoutPin`; see `CheckoutPin`.
 * - `working_tree` — dirty, or at no recorded commit. NEVER attestable, under
 *   any circumstance: there is no identity to bind a self-test result to, so a
 *   PASS observed here describes bytes that no longer need to exist.
 */
export const OBSERVED_ENTRYPOINTS = ["installed_package", "pinned_checkout", "working_tree"] as const;
export type ObservedEntrypoint = (typeof OBSERVED_ENTRYPOINTS)[number];

/**
 * The entrypoints whose identity is bound tightly enough to carry a self-test
 * result forward to the artifact that will run the job.
 *
 * An ALLOWLIST, deliberately, not `!== "working_tree"`. A member added to
 * OBSERVED_ENTRYPOINTS later is then not attestable until someone adds it here
 * on purpose; a denylist would grant every future member by default, which is
 * the wrong direction for a fail-closed guard. Not exported: what an
 * attestation establishes is answered by `attestedHarnessCapabilities`, and a
 * second exported copy of this list is a second place for the answer to drift.
 */
const ATTESTABLE_ENTRYPOINTS = ["installed_package", "pinned_checkout"] as const;

/**
 * The evidence that makes a checkout PINNED rather than merely labelled so.
 *
 * Two git object ids, nothing else:
 * - `commitId` — the exact commit the tree is checked out at (40 lowercase
 *   hex). This is the same value production already announces on the bus as
 *   `worker_build`, so the field records something that exists rather than
 *   asking deployment for something new.
 * - `treeId` — `git write-tree` over the working tree AS OBSERVED (40 lowercase
 *   hex).
 *
 * A bare `clean: true` would be the attestation problem one level down: anyone
 * can set a boolean, and nobody can check it. `treeId` is a RECOMPUTABLE value.
 * A third party holding the repository recomputes `git rev-parse
 * <commitId>^{tree}` and compares: equal means the tree that ran the self-test
 * was exactly the recorded commit, and a dirty tree hashes to something else,
 * so the claim is falsifiable by anyone rather than believable only on trust.
 * That comparison needs the repository and so is an AUDITOR's check, not this
 * validator's; what the contract enforces is that the falsifiable evidence is
 * present and well-formed, which is the part a schema can enforce at all.
 *
 * Ids and digests only — no paths, no branch names, no free text. A pin is
 * identity, and every place this record could carry prose is a place content
 * could sit unexamined (DR-3).
 *
 * 40 hex, not 40-or-64: git's SHA-256 object format would be a schema version
 * bump with its own migration, not a loosened regex. Widening it here silently
 * would let a 64-hex digest of anything at all pass as a commit id.
 */
export type CheckoutPin = {
  readonly commitId: string;
  readonly treeId: string;
};

export type AttestedCapability = {
  readonly id: string;
  readonly version: number;
  readonly status: AttestationStatus;
  readonly selfTestDigest: string;
  readonly observedEntrypoint: ObservedEntrypoint;
  /** Required when `observedEntrypoint` is `pinned_checkout`, forbidden otherwise. */
  readonly checkoutPin?: CheckoutPin;
};

/**
 * `checkoutPin` is required for `pinned_checkout` and forbidden for every other
 * entrypoint.
 *
 * Forbidden, not merely ignored, in the other two arms. An entry that carries a
 * pin while naming `working_tree` reads to a human as pinned and is not; an
 * `installed_package` does not have a checkout for the pin to describe. Both
 * are a field asserting more than the record means, so both are refused rather
 * than dropped.
 */
function validateCheckoutPin(
  raw: Record<string, unknown>,
  path: string,
  issues: ValidationIssue[],
): void {
  const declaresPin = Object.hasOwn(raw, "checkoutPin");
  if (raw.observedEntrypoint !== "pinned_checkout") {
    if (declaresPin) {
      issues.push(
        issue(
          `${path}/checkoutPin`,
          "checkout_pin_not_applicable",
          "only a pinned_checkout carries checkoutPin",
        ),
      );
    }
    return;
  }
  if (!declaresPin || !isObjectRecord(raw.checkoutPin)) {
    issues.push(
      issue(
        `${path}/checkoutPin`,
        "missing_checkout_pin",
        "a pinned_checkout carries checkoutPin: the commit it is pinned to and the tree hash observed there",
      ),
    );
    return;
  }
  const pin = raw.checkoutPin;
  rejectUnknownFields(pin, ["commitId", "treeId"], `${path}/checkoutPin`, "a checkout pin", issues);
  if (!isGitObjectId(pin.commitId)) {
    issues.push(
      issue(`${path}/checkoutPin/commitId`, "invalid_commit_id", "commitId is 40 lowercase hex characters"),
    );
  }
  if (!isGitObjectId(pin.treeId)) {
    issues.push(
      issue(`${path}/checkoutPin/treeId`, "invalid_tree_id", "treeId is 40 lowercase hex characters"),
    );
  }
}

function validateCapability(raw: unknown, path: string, issues: ValidationIssue[], seen: Set<string>): void {
  if (!isObjectRecord(raw)) {
    issues.push(issue(path, "invalid_type", "an attested capability is an object"));
    return;
  }
  rejectUnknownFields(
    raw,
    ["id", "version", "status", "selfTestDigest", "observedEntrypoint", "checkoutPin"],
    path,
    "an attested capability",
    issues,
  );
  if (!isIdentifier(raw.id)) {
    issues.push(issue(`${path}/id`, "invalid_id", "a capability id is an identifier"));
  } else if (seen.has(raw.id)) {
    issues.push(issue(`${path}/id`, "duplicate_capability", "a capability is attested twice"));
  } else {
    seen.add(raw.id);
  }
  if (!isPositiveInt(raw.version)) {
    issues.push(issue(`${path}/version`, "invalid_version", "a capability version is a positive integer"));
  }
  if (!isEnumMember(raw.status, ATTESTATION_STATUSES)) {
    issues.push(issue(`${path}/status`, "unknown_attestation_status", "status must be PASS, FAIL, or SKIPPED"));
  }
  if (!isDigest(raw.selfTestDigest)) {
    issues.push(issue(`${path}/selfTestDigest`, "invalid_digest", "selfTestDigest is 64 lowercase hex characters"));
  }
  if (!isEnumMember(raw.observedEntrypoint, OBSERVED_ENTRYPOINTS)) {
    issues.push(
      issue(
        `${path}/observedEntrypoint`,
        "unknown_entrypoint",
        `observedEntrypoint must be one of ${OBSERVED_ENTRYPOINTS.join(", ")}`,
      ),
    );
  }
  validateCheckoutPin(raw, path, issues);
}

/** Validate a harness attestation from untrusted input. */
export function validateHarnessAttestation(input: unknown): ValidationResult<HarnessAttestation> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];

  rejectUnknownFields(
    record,
    [
      "schemaVersion", "attestationId", "runtimeBuild", "environmentDigest", "workerPrincipalId",
      "capabilities", "createdAt", "expiresAt", "issuedBy",
    ],
    "",
    "a harness attestation",
    issues,
  );

  if (record.schemaVersion !== 2) {
    issues.push(issue("/schemaVersion", "invalid_schema_version", "this schema is version 2"));
  }
  for (const field of ["attestationId", "workerPrincipalId"] as const) {
    if (!isIdentifier(record[field])) {
      issues.push(issue(`/${field}`, "invalid_id", `${field} is an identifier`));
    }
  }
  if (!isNonBlankText(record.runtimeBuild)) {
    issues.push(issue("/runtimeBuild", "required_field", "runtimeBuild must be non-blank text"));
  }
  if (!isDigest(record.environmentDigest)) {
    issues.push(issue("/environmentDigest", "invalid_digest", "environmentDigest is 64 lowercase hex characters"));
  }

  if (!Array.isArray(record.capabilities)) {
    issues.push(issue("/capabilities", "invalid_type", "capabilities is an array"));
  } else {
    const seen = new Set<string>();
    record.capabilities.forEach((raw, i) => validateCapability(raw, `/capabilities/${i}`, issues, seen));
  }

  for (const field of ["createdAt", "expiresAt"] as const) {
    if (!isCanonicalTimestamp(record[field])) {
      issues.push(
        issue(`/${field}`, "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z"),
      );
    }
  }
  if (
    isCanonicalTimestamp(record.createdAt)
    && isCanonicalTimestamp(record.expiresAt)
    && !isStrictlyAfter(record.expiresAt, record.createdAt)
  ) {
    issues.push(issue("/expiresAt", "expiry_not_after_creation", "expiresAt must be strictly later than createdAt"));
  }

  // plainActor, not a local check: the issuer's identity decides whose word
  // this attestation is, and a proxy must not be able to answer differently
  // to the validator and to the consumer.
  if (!isObjectRecord(record.issuedBy) || plainActor(record.issuedBy) === null) {
    issues.push(issue("/issuedBy", "invalid_actor", "issuedBy must be a consistent actor"));
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as HarnessAttestation, {});
}

/**
 * The harness capabilities this attestation actually establishes at `now`.
 *
 * This is the ONLY function that should feed `matchEndpointToRole`'s
 * `attestedHarnessCapabilities` argument. It is deliberately narrower than the
 * record: an entry counts only when its self-test PASSED, was observed on an
 * artifact whose identity is bound (`ATTESTABLE_ENTRYPOINTS`: an installed
 * package, or a checkout pinned to an exact commit with a recomputable tree —
 * never a `working_tree`), the attestation has not expired (`expiresAt`
 * strictly after `now`), and the id is a member of HARNESS_CAPABILITIES.
 * Anything else — a FAIL, a SKIPPED, an unknown id, a stale attestation, an
 * invalid record, an unparseable `now` — contributes nothing. Returning an
 * empty list is the fail-closed answer: the matcher treats it as "stated and
 * does not cover", never as a grant.
 *
 * A `pinned_checkout` without well-formed `checkoutPin` evidence never reaches
 * this loop: it is INVALID, so the whole attestation is refused above rather
 * than counting as one uncapable entry among valid ones.
 */
export function attestedHarnessCapabilities(attestation: HarnessAttestation, now: string): HarnessCapability[] {
  const validated = validateHarnessAttestation(attestation);
  if (!validated.ok) return [];
  if (!isStrictlyAfter(validated.value.expiresAt, now)) return [];
  const out: HarnessCapability[] = [];
  for (const capability of validated.value.capabilities) {
    if (capability.status !== "PASS") continue;
    if (!isEnumMember(capability.observedEntrypoint, ATTESTABLE_ENTRYPOINTS)) continue;
    if (!isEnumMember(capability.id, HARNESS_CAPABILITIES)) continue;
    const id = capability.id as HarnessCapability;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** The identity of an attestation: SHA-256 over the canonical, validated record. */
export function harnessAttestationDigest(attestation: HarnessAttestation): string {
  return digestValidated("harness attestation", validateHarnessAttestation(attestation));
}

export const HARNESS_ATTESTATION_SCHEMA_META: SchemaMeta = {
  id: "vinci.harness-attestation",
  /**
   * BUMPED to 2, and the shape changed under a `frozen` policy is exactly why.
   *
   * Frozen means no change is permitted WITHIN a major version, not that the
   * shape may never change; `RUN_EVENT_SCHEMA_META` set the precedent when v4
   * had to add event types — bump the version and state the migration, rather
   * than edit a frozen shape in place and leave every existing record's
   * `schemaVersion` claiming a contract it no longer satisfies.
   */
  version: 2,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  /**
   * REFUSED, not up-converted, and the reason is that the v1 record does not
   * contain the facts a v2 record asserts.
   *
   * `installed_worker` could plausibly be read as `installed_package`, but
   * `source_checkout` maps to `pinned_checkout` or to `working_tree` depending
   * on whether the tree was clean at an exact commit — which is precisely the
   * evidence v1 never carried. Guessing would manufacture a pin nobody
   * observed. Mapping the one arm that is derivable and inventing the other is
   * worse than refusing both, so a v2 validator refuses a v1 record on
   * `schemaVersion` and the harness re-attests.
   */
  migration:
    "v1 records remain readable by a v1 validator only; v2 replaces observedEntrypoint's delivery vocabulary "
    + "(installed_worker | source_checkout) with an identity-binding one (installed_package | pinned_checkout | "
    + "working_tree) and requires checkoutPin (commitId, treeId) on a pinned_checkout; a v2 consumer refuses a v1 "
    + "record on schemaVersion rather than up-converting it, because the pin evidence a v1 source_checkout would "
    + "need to become a pinned_checkout was never recorded and must be re-observed",
};
