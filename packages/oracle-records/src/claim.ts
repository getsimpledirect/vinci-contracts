import {
  fail,
  isStrictlyAfter,
  ok,
  toPlainRecord,
  type Actor,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import { digestValidated } from "./digest.ts";
import {
  checkSchemaVersion,
  isCanonicalTimestamp,
  isDigest,
  isEnumMember,
  isIdentifier,
  isObjectRecord,
  isProseText,
  isRefText,
  issue,
  plainActor,
  readEnum,
  readSourceSpans,
  readStringList,
  rejectUnknownFields,
} from "./lib/validate.ts";

/**
 * §5.5. One claim, scoped narrowly enough that something could check it.
 *
 * The spec's first sentence is the design: "split compound claims when one part
 * could be true and another false". Everything here follows from that — a claim
 * carries ONE proposition, one applicability, one materiality, and the evidence
 * offered for that proposition alone. A record able to hold two propositions
 * would be a record whose assessment status means "some of this is supported",
 * which is the status nobody can act on.
 */

/**
 * What kind of statement this is.
 *
 * CLM-03's whole mechanism is that these are five different things and the
 * record says which. An inference that reads as an observation is the failure
 * being prevented: it costs a reader the one fact they need to weigh it, and it
 * costs them silently, because the sentence is identical either way.
 */
export const CLAIM_TYPES = [
  "OBSERVED",
  "EXTERNALLY_REPORTED",
  "INFERRED",
  "HYPOTHESIS",
  "RECOMMENDATION",
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** The claim types that assert something was seen, and therefore owe a span. */
const OBSERVATIONAL_TYPES: readonly ClaimType[] = ["OBSERVED", "EXTERNALLY_REPORTED"];

/**
 * How much this claim bears on the decision.
 *
 * Not a confidence score. A claim can be certain and irrelevant, or material
 * and unresolved; collapsing the two into one number is how a report comes to
 * lead with whatever happens to be best evidenced rather than with what
 * changes the decision (REP-03).
 */
export const CLAIM_MATERIALITY = ["DECISION_CHANGING", "SUPPORTING", "BACKGROUND"] as const;
export type ClaimMateriality = (typeof CLAIM_MATERIALITY)[number];

/**
 * A pointer into a delivered source, optionally into a span of it.
 *
 * `sourceId` is the host-assigned id from `SourceRecord`, never the number a
 * reader saw beside a citation — SRC-03, and `resolveCitations` is what
 * actually answers whether the id was delivered. A claim naming a source is
 * making a reference, not proving one.
 */
export type ClaimSourceSpan = {
  readonly sourceId: string;
  readonly span: { readonly startOffset: number; readonly endOffset: number } | null;
};

/**
 * §5.5 "applicable subject/revision/time/scope", as four fields rather than a
 * sentence.
 *
 * `scope` is the sentence a reader must not have to infer: "captured source
 * revision only" and "deployed behaviour" are different claims about the same
 * proposition, and §22.2's worked example turns on exactly that distinction.
 * Every key is required; `revision` and the two times are null when the claim
 * genuinely is not bound to one, which is a different statement from a claim
 * that forgot to say.
 */
export type ClaimApplicability = {
  readonly subject: string;
  readonly revision: string | null;
  readonly applicableFrom: string | null;
  readonly applicableUntil: string | null;
  readonly scope: string;
};

/**
 * CLM-03. The premises an inference rests on and the reasoning that connects
 * them, labeled as such.
 *
 * An inference "may be useful without appearing verbatim in a source" — so this
 * is not a weaker form of evidence, it is a DIFFERENT one, and it is admissible
 * exactly when it says what it was built from.
 */
export type ClaimDerivation = {
  readonly premises: readonly string[];
  readonly reasoningSummary: string;
  readonly analysisRef: string | null;
};

/**
 * CLM-04. The test that would tell a hypothesis apart from its alternatives.
 *
 * A hypothesis is not required to be true before it is investigated, and this
 * package must not ask it to be: a validator demanding source spans for the
 * future outcome of a proposed experiment refuses the one record shape the
 * whole Oracle exists to produce. What IS required is that the hypothesis says
 * what would settle it, in both directions — a "test" with only a confirming
 * arm is a plan to find agreement.
 */
export type ClaimDiscriminatingTest = {
  readonly test: string;
  readonly wouldSupport: string;
  readonly wouldRefute: string;
};

export type ClaimRecord = {
  readonly schemaVersion: 1;
  readonly claimId: string;
  readonly requestRef: string;
  readonly runRef: string;
  readonly workspaceRef: string;
  /**
   * The immutable context this claim was made under.
   *
   * A claim outlives the report that first carried it: it is referenced by
   * assessments, proposals and outcomes, each of which may be read months
   * later. The scope it was made in has to travel with it, or "applicable
   * scope" becomes a property of whichever report a reader happened to open.
   */
  readonly contextManifestDigest: string;
  readonly claimType: ClaimType;
  readonly proposition: string;
  readonly applicability: ClaimApplicability;
  readonly materiality: ClaimMateriality;
  readonly sourceSpans: readonly ClaimSourceSpan[];
  /**
   * Evidence that CONFLICTS with this claim, carried by the claim itself.
   *
   * INV-06's shape: a contradiction found and then dropped is indistinguishable
   * from a contradiction never found. Keeping it on the claim means the reader
   * of the claim sees it, rather than the reader of whichever report remembered
   * to mention it.
   */
  readonly contradictingEvidence: readonly ClaimSourceSpan[];
  readonly assumptions: readonly string[];
  /** Required and non-null for `INFERRED`; refused on an observational type. */
  readonly derivation: ClaimDerivation | null;
  /** Required and non-null for `HYPOTHESIS`. */
  readonly discriminatingTest: ClaimDiscriminatingTest | null;
  readonly author: Actor;
  readonly invalidationConditions: readonly string[];
  readonly issuedAt: string;
};

const CLAIM_FIELDS = [
  "schemaVersion",
  "claimId",
  "requestRef",
  "runRef",
  "workspaceRef",
  "contextManifestDigest",
  "claimType",
  "proposition",
  "applicability",
  "materiality",
  "sourceSpans",
  "contradictingEvidence",
  "assumptions",
  "derivation",
  "discriminatingTest",
  "author",
  "invalidationConditions",
  "issuedAt",
] as const;

/** Validate a claim record from untrusted input. */
export function validateClaimRecord(input: unknown): ValidationResult<ClaimRecord> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];

  rejectUnknownFields(record, CLAIM_FIELDS, "", "a claim record", issues);
  checkSchemaVersion(record.schemaVersion, "/schemaVersion", issues);

  for (const field of ["claimId", "requestRef", "runRef", "workspaceRef"] as const) {
    if (!isIdentifier(record[field])) {
      issues.push(issue(`/${field}`, "invalid_id", `${field} is a host-assigned identifier`));
    }
  }
  if (!isDigest(record.contextManifestDigest)) {
    issues.push(
      issue(
        "/contextManifestDigest",
        "invalid_digest",
        "contextManifestDigest is 64 lowercase hex characters; a claim carries the scope it was made under",
      ),
    );
  }
  readEnum(record.claimType, CLAIM_TYPES, "/claimType", "unknown_claim_type", "claimType must come from CLAIM_TYPES", issues);
  readEnum(
    record.materiality,
    CLAIM_MATERIALITY,
    "/materiality",
    "unknown_materiality",
    "materiality must come from CLAIM_MATERIALITY",
    issues,
  );
  if (!isProseText(record.proposition)) {
    issues.push(
      issue("/proposition", "required_field", "a claim states one proposition a reader could check"),
    );
  }

  const applicability = record.applicability;
  if (!isObjectRecord(applicability)) {
    issues.push(issue("/applicability", "invalid_type", "applicability is an object"));
  } else {
    rejectUnknownFields(
      applicability,
      ["subject", "revision", "applicableFrom", "applicableUntil", "scope"],
      "/applicability",
      "applicability",
      issues,
    );
    if (!isRefText(applicability.subject)) {
      issues.push(issue("/applicability/subject", "required_field", "a claim names what it is about"));
    }
    if (!isProseText(applicability.scope)) {
      issues.push(
        issue(
          "/applicability/scope",
          "required_field",
          "the scope is stated, never inferred: captured source and deployed behaviour are different claims",
        ),
      );
    }
    if (applicability.revision !== null && !isRefText(applicability.revision)) {
      issues.push(issue("/applicability/revision", "invalid_ref", "revision is a ref or explicitly null"));
    }
    for (const field of ["applicableFrom", "applicableUntil"] as const) {
      if (applicability[field] !== null && !isCanonicalTimestamp(applicability[field])) {
        issues.push(
          issue(
            `/applicability/${field}`,
            "invalid_timestamp",
            `${field} is a canonical timestamp or explicitly null`,
          ),
        );
      }
    }
    if (isStrictlyAfter(applicability.applicableFrom, applicability.applicableUntil)) {
      issues.push(
        issue(
          "/applicability/applicableUntil",
          "inverted_window",
          "a claim's applicability does not end before it begins",
        ),
      );
    }
  }

  readSourceSpans(record.sourceSpans, "/sourceSpans", "sourceSpans", issues);
  readSourceSpans(record.contradictingEvidence, "/contradictingEvidence", "contradictingEvidence", issues);
  readStringList(record.assumptions, "/assumptions", "assumptions", issues);
  readStringList(record.invalidationConditions, "/invalidationConditions", "invalidationConditions", issues);

  const derivation = record.derivation;
  if (derivation !== null) {
    if (!isObjectRecord(derivation)) {
      issues.push(issue("/derivation", "invalid_type", "derivation is an object or explicitly null"));
    } else {
      rejectUnknownFields(
        derivation,
        ["premises", "reasoningSummary", "analysisRef"],
        "/derivation",
        "a derivation",
        issues,
      );
      const premises = readStringList(derivation.premises, "/derivation/premises", "premises", issues);
      if (premises !== undefined && premises.length === 0) {
        issues.push(
          issue(
            "/derivation/premises",
            "derivation_without_premises",
            "CLM-03: an inference labels the premises it rests on; a derivation from nothing is an assertion",
          ),
        );
      }
      if (!isProseText(derivation.reasoningSummary)) {
        issues.push(
          issue("/derivation/reasoningSummary", "required_field", "CLM-03: an inference summarises its reasoning"),
        );
      }
      if (derivation.analysisRef !== null && !isRefText(derivation.analysisRef)) {
        issues.push(issue("/derivation/analysisRef", "invalid_ref", "analysisRef is a ref or explicitly null"));
      }
    }
  }

  const discriminatingTest = record.discriminatingTest;
  if (discriminatingTest !== null) {
    if (!isObjectRecord(discriminatingTest)) {
      issues.push(
        issue("/discriminatingTest", "invalid_type", "discriminatingTest is an object or explicitly null"),
      );
    } else {
      rejectUnknownFields(
        discriminatingTest,
        ["test", "wouldSupport", "wouldRefute"],
        "/discriminatingTest",
        "a discriminating test",
        issues,
      );
      for (const field of ["test", "wouldSupport", "wouldRefute"] as const) {
        if (!isProseText(discriminatingTest[field])) {
          issues.push(
            issue(
              `/discriminatingTest/${field}`,
              "required_field",
              "CLM-04: a discriminating test says what would support AND what would refute; one arm is a plan to agree",
            ),
          );
        }
      }
    }
  }

  if (!isObjectRecord(record.author) || plainActor(record.author) === null) {
    issues.push(
      issue("/author", "invalid_actor", "author must be an actor carrying exactly its own kind's fields"),
    );
  }
  if (!isCanonicalTimestamp(record.issuedAt)) {
    issues.push(issue("/issuedAt", "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision"));
  }

  // --- CLM-03 and CLM-04, the rules that make the type mean something ------
  //
  // Guarded on the discriminator being a known member, for the reason
  // `validateSourceRecord` guards its own consequential rules: an unrecognised
  // claim type would otherwise produce three findings about a record whose one
  // real problem is the type.
  if (isEnumMember(record.claimType, CLAIM_TYPES)) {
    const claimType = record.claimType as ClaimType;
    if (OBSERVATIONAL_TYPES.includes(claimType)) {
      if (Array.isArray(record.sourceSpans) && record.sourceSpans.length === 0) {
        issues.push(
          issue(
            "/sourceSpans",
            "observation_without_source_span",
            `${claimType} says something was seen in a source; without a span nothing identifies what was seen`,
          ),
        );
      }
      if (derivation !== null) {
        // CLM-03's exact sentence, as a refusal: "do not relabel a plausible
        // inference as directly observed fact". A record carrying premises and
        // a reasoning summary IS an inference, whatever its type field says,
        // and this is the one place that disagreement is visible.
        issues.push(
          issue(
            "/derivation",
            "inference_labeled_as_observed",
            `CLM-03: a record carrying premises and a reasoning summary is an inference; ${claimType} `
              + "claims it was read directly from a source. Use INFERRED",
          ),
        );
      }
    }
    if (claimType === "INFERRED" && derivation === null) {
      issues.push(
        issue(
          "/derivation",
          "inference_without_derivation",
          "CLM-03: an inference labels its premises and reasoning summary; without them it is an unsourced assertion",
        ),
      );
    }
    if (claimType === "HYPOTHESIS" && discriminatingTest === null) {
      issues.push(
        issue(
          "/discriminatingTest",
          "hypothesis_without_discriminating_test",
          "CLM-04: a hypothesis is presented WITH the test that would tell it apart; it is not required to be true first",
        ),
      );
    }
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as ClaimRecord, {});
}

/** The identity of a claim: SHA-256 over its canonical, validated bytes. */
export function claimRecordDigest(record: ClaimRecord): string {
  return digestValidated("claim record", validateClaimRecord(record));
}

export const CLAIM_RECORD_SCHEMA_META: SchemaMeta = {
  id: "vinci.oracle.claim-record",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};
