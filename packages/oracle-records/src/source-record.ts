import {
  fail,
  isStrictlyAfter,
  ok,
  toPlainRecord,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import { digestValidated } from "./digest.ts";
import { validateAttestedEnvelope, type AttestedEnvelope, type ModelAuthored } from "./envelope.ts";
import { ORACLE_DATA_CLASSIFICATIONS } from "./oracle-context.ts";
import {
  checkSchemaVersion,
  isCanonicalTimestamp,
  isDigest,
  isEnumMember,
  isGitObjectId,
  isIdentifier,
  isNonNegativeInt,
  isObjectRecord,
  isProseText,
  isRefText,
  issue,
  readCost,
  readEnum,
  readEnumArray,
  readRefArray,
  rejectUnknownFields,
} from "./lib/validate.ts";

/**
 * §5.4. What was actually observed, and how far that observation reaches.
 *
 * INV-09: a source reference identifies observed bytes or a precisely limited
 * provider observation, and a digest proves identity, not truth or authorship.
 * Every rule below is an application of that one sentence.
 */

export const SOURCE_KINDS = [
  "repository_file",
  "web_document",
  "api_response",
  "evidence_record",
  "provider_research_response",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * SRC-01. How much of the REQUESTED RANGE was obtained — never how much of the
 * document. `FULL_REQUESTED_RANGE` over a two-page request on a four-hundred
 * page document is a complete read of two pages, and the record says so through
 * `requestedRange` and `coversEntireDocument` rather than through this field
 * alone.
 */
export const SOURCE_COMPLETENESS = [
  "FULL_REQUESTED_RANGE",
  "PARTIAL",
  "SNIPPET_ONLY",
  "NOT_OBTAINED",
] as const;
export type SourceCompleteness = (typeof SOURCE_COMPLETENESS)[number];

/**
 * SRC-02. Who observed the bytes.
 *
 * A vendor-hosted research response containing a citation is evidence that the
 * vendor returned that citation. It is not evidence that Vinci retrieved the
 * cited source, and the difference is not a nuance to be recorded in a note —
 * the two arms of `SourceObservation` carry different fields because they
 * support different claims.
 */
export const SOURCE_OBSERVATION_MODES = ["INDEPENDENT_RETRIEVAL", "PROVIDER_REPORTED"] as const;
export type SourceObservationMode = (typeof SOURCE_OBSERVATION_MODES)[number];

/**
 * SRC-04. What the read attempt actually produced.
 *
 * The three cases SRC-04 insists are distinct are distinct here:
 * `SEARCH_NO_RESULTS` (the search ran and matched nothing), `SEARCH_FAILED`
 * (the search did not run), and `READ_COMPLETE` with `matchState: "NO_MATCH"`
 * (the source was read in full and does not contain the sought material). A
 * success record with empty text can express none of them, which is why it is
 * refused.
 */
export const SOURCE_READ_OUTCOMES = [
  "READ_COMPLETE",
  "READ_PARTIAL",
  "SEARCH_NO_RESULTS",
  "SEARCH_FAILED",
  "FETCH_FAILED",
  "UNSUPPORTED_FORMAT",
  "ACCESS_DENIED",
] as const;
export type SourceReadOutcome = (typeof SOURCE_READ_OUTCOMES)[number];

/** The outcomes that obtain bytes. Everything else obtains nothing at all. */
const OBTAINING_OUTCOMES: readonly SourceReadOutcome[] = ["READ_COMPLETE", "READ_PARTIAL"];

/** Whether the obtained content contains what was sought. Meaningless without content. */
export const SOURCE_MATCH_STATES = ["MATCHED", "NO_MATCH", "NOT_SEARCHED"] as const;
export type SourceMatchState = (typeof SOURCE_MATCH_STATES)[number];

/** §5.4 Limitations. */
export const SOURCE_LIMITATIONS = [
  "truncated",
  "parser_failure",
  "inaccessible_sections",
  "unsupported_format",
  "provider_only_attribution",
] as const;
export type SourceLimitation = (typeof SOURCE_LIMITATIONS)[number];

/** §5.4 Relationships, recorded only where actually established. */
export const SOURCE_RELATIONSHIP_KINDS = [
  "same_origin",
  "syndication",
  "derivative",
  "previous_version",
] as const;
export type SourceRelationshipKind = (typeof SOURCE_RELATIONSHIP_KINDS)[number];

/**
 * §5.4 Policy. `unknown` is a THIRD state, not a synonym for prohibited or a
 * placeholder for permitted: INV-03 forbids representing unexamined rights as
 * an answer, and a consumer must be able to see that nobody has looked.
 */
export const SOURCE_USE_PERMISSIONS = ["permitted", "prohibited", "unknown"] as const;
export type SourceUsePermission = (typeof SOURCE_USE_PERMISSIONS)[number];

/**
 * What was asked for. SRC-01: the requested range is explicitly DEFINED, never
 * implied by the completeness label.
 *
 * A union rather than a nullable string pair, so `entire_document` is a claim a
 * record makes rather than the absence of a narrower one.
 */
export type RequestedRange =
  | { readonly kind: "entire_document" }
  | { readonly kind: "byte_range"; readonly startByte: number; readonly endByte: number }
  | { readonly kind: "line_range"; readonly startLine: number; readonly endLine: number }
  | { readonly kind: "page_range"; readonly startPage: number; readonly endPage: number }
  | { readonly kind: "section"; readonly sectionPath: string }
  | { readonly kind: "search_query"; readonly query: string };

export const REQUESTED_RANGE_KINDS = [
  "entire_document",
  "byte_range",
  "line_range",
  "page_range",
  "section",
  "search_query",
] as const;

/** The fields each requested-range arm may carry, derived nowhere else. */
const RANGE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  entire_document: ["kind"],
  byte_range: ["kind", "startByte", "endByte"],
  line_range: ["kind", "startLine", "endLine"],
  page_range: ["kind", "startPage", "endPage"],
  section: ["kind", "sectionPath"],
  search_query: ["kind", "query"],
};

export type SourceOrigin = {
  readonly locator: string;
  readonly repositoryId: string | null;
  readonly repositoryPath: string | null;
  readonly repositoryRevision: string | null;
  readonly publisher: string | null;
};

/**
 * §5.4 Time. Four separate fields, each set only when actually known.
 *
 * CON-02 in its most literal form: a source published in 2019 and last updated
 * yesterday and describing an event in 2014 has three different dates, and a
 * schema with one `date` field forces whoever writes it to pick one and lose
 * the rest. Every key is REQUIRED and every value but `retrievedAt` may be
 * null, so "we do not know when this was published" is stated rather than
 * inferred from an absent key.
 */
export type SourceTimes = {
  readonly retrievedAt: string;
  readonly publishedAt: string | null;
  readonly updatedAt: string | null;
  readonly eventAt: string | null;
};

/**
 * §5.4 Observation. A discriminated union, and SRC-02's whole mechanism.
 *
 * The `PROVIDER_REPORTED` arm has NO `adapterVersion` and NO
 * `observedBytesDigest`, because there was no adapter and there are no observed
 * bytes — the provider said something and that is the whole of what happened.
 * Those two names on this arm are refused with their own issue code rather than
 * as unknown fields, so a consumer can tell "this record tried to claim an
 * independent retrieval it did not perform" from "this record has a typo".
 */
export type SourceObservation =
  | {
      readonly mode: "INDEPENDENT_RETRIEVAL";
      readonly adapterVersion: string;
      readonly contentType: string;
      readonly encoding: string;
      /**
       * The bytes this retrieval actually received, or explicitly null when it
       * received none. A refused fetch has nothing to digest, and a digest of
       * nothing would be a digest of the empty string — an identity that
       * compares equal across every failed read there has ever been.
       */
      readonly observedBytesDigest: string | null;
      readonly retrievedRange: string | null;
      readonly retrievalCostMicrousd: number | null;
    }
  | {
      readonly mode: "PROVIDER_REPORTED";
      readonly providerId: string;
      readonly providerReceiptRef: string;
      readonly retrievedRange: string | null;
      readonly retrievalCostMicrousd: number | null;
    };

const OBSERVATION_FIELDS: Readonly<Record<SourceObservationMode, readonly string[]>> = {
  INDEPENDENT_RETRIEVAL: [
    "mode",
    "adapterVersion",
    "contentType",
    "encoding",
    "observedBytesDigest",
    "retrievedRange",
    "retrievalCostMicrousd",
  ],
  PROVIDER_REPORTED: [
    "mode",
    "providerId",
    "providerReceiptRef",
    "retrievedRange",
    "retrievalCostMicrousd",
  ],
};

/** The independent-retrieval fields a provider report must not claim. */
const INDEPENDENT_ONLY_FIELDS = ["adapterVersion", "observedBytesDigest"] as const;

export type SourceTextOffsets = {
  readonly startOffset: number;
  readonly endOffset: number;
};

export type SourceContentBinding = {
  readonly rawArtifactRef: string;
  readonly rawDigest: string;
  readonly extractedArtifactRef: string | null;
  readonly extractedDigest: string | null;
  readonly extractionVersion: string;
  readonly textOffsets: SourceTextOffsets | null;
  readonly pageLocations: readonly number[];
};

export type SourcePolicy = {
  readonly classification: (typeof ORACLE_DATA_CLASSIFICATIONS)[number];
  readonly permittedAudiences: readonly string[];
  readonly retentionRule: string;
  readonly researchUse: SourceUsePermission;
  readonly trainingUse: SourceUsePermission;
};

export type SourceRelationship = {
  readonly kind: SourceRelationshipKind;
  readonly sourceId: string;
};

/**
 * One source, as the host recorded it.
 *
 * `sourceId` is host-assigned and stable across repeated searches, compaction,
 * parallel subtasks and rendering. `presentationIndex` is the number a reader
 * sees beside a citation in a rendered report and is PRESENTATION ONLY: it is
 * nullable, it is not an identifier, and nothing in this package accepts it
 * where a `sourceId` is expected — `resolveCitations` refuses it by name. SRC-03
 * exists because renumbering between two renders of the same report is normal,
 * and a reference that survives renumbering has to be a different field.
 */
export type SourceRecord = {
  readonly schemaVersion: 1;
  readonly sourceId: string;
  readonly requestRef: string;
  readonly runRef: string;
  readonly workspaceRef: string;
  readonly sourceKind: SourceKind;
  readonly presentationIndex: number | null;
  readonly origin: SourceOrigin;
  readonly time: SourceTimes;
  readonly observation: SourceObservation;
  readonly requestedRange: RequestedRange;
  readonly completeness: SourceCompleteness;
  /**
   * SRC-01. Whether the requested range happens to be the whole document:
   * `true` only when the request WAS the whole document, `false` when it
   * demonstrably was not, and `null` when nothing was obtained and the question
   * has no answer. Three states, none of which is the absence of a field.
   */
  readonly coversEntireDocument: boolean | null;
  readonly readOutcome: SourceReadOutcome;
  readonly matchState: SourceMatchState;
  /** SRC-04. Null exactly when the read obtained nothing; never an empty text. */
  readonly content: SourceContentBinding | null;
  readonly limitations: readonly SourceLimitation[];
  readonly policy: SourcePolicy;
  readonly relationships: readonly SourceRelationship[];
};

const SOURCE_FIELDS = [
  "schemaVersion",
  "sourceId",
  "requestRef",
  "runRef",
  "workspaceRef",
  "sourceKind",
  "presentationIndex",
  "origin",
  "time",
  "observation",
  "requestedRange",
  "completeness",
  "coversEntireDocument",
  "readOutcome",
  "matchState",
  "content",
  "limitations",
  "policy",
  "relationships",
] as const;

function validateRequestedRange(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isObjectRecord(value)) {
    issues.push(
      issue(
        path,
        "invalid_type",
        "SRC-01: the requested range is explicitly defined, never implied by the completeness label",
      ),
    );
    return;
  }
  const kind = value.kind;
  if (!isEnumMember(kind, REQUESTED_RANGE_KINDS)) {
    issues.push(issue(`${path}/kind`, "unknown_range_kind", "kind must come from REQUESTED_RANGE_KINDS"));
    return;
  }
  rejectUnknownFields(value, RANGE_FIELDS[kind] ?? ["kind"], path, "a requested range", issues);
  const pairs: Readonly<Record<string, readonly [string, string]>> = {
    byte_range: ["startByte", "endByte"],
    line_range: ["startLine", "endLine"],
    page_range: ["startPage", "endPage"],
  };
  const pair = pairs[kind];
  if (pair !== undefined) {
    const [from, to] = pair;
    const start = value[from];
    const end = value[to];
    for (const [field, bound] of [[from, start], [to, end]] as const) {
      if (!isNonNegativeInt(bound)) {
        issues.push(issue(`${path}/${field}`, "invalid_type", `${field} is a non-negative integer`));
      }
    }
    if (isNonNegativeInt(start) && isNonNegativeInt(end) && end < start) {
      issues.push(issue(`${path}/${to}`, "inverted_range", "a range ends no earlier than it starts"));
    }
  }
  if (kind === "section" && !isRefText(value.sectionPath)) {
    issues.push(issue(`${path}/sectionPath`, "required_field", "a section range names the section"));
  }
  if (kind === "search_query" && !isProseText(value.query)) {
    issues.push(issue(`${path}/query`, "required_field", "a search range carries the query that was run"));
  }
}

function validateObservation(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isObjectRecord(value)) {
    issues.push(issue(path, "invalid_type", "observation is an object"));
    return;
  }
  const mode = value.mode;
  if (!isEnumMember(mode, SOURCE_OBSERVATION_MODES)) {
    issues.push(
      issue(
        `${path}/mode`,
        "unknown_observation_mode",
        "mode must come from SOURCE_OBSERVATION_MODES; an unrecognised discriminator is refused, not approximately matched",
      ),
    );
    return;
  }

  // SRC-02, with its own code and BEFORE the allowlist.
  //
  // Run the other way round these two names would be reported as unknown
  // fields, and "this provider report claims an adapter it never ran" would be
  // indistinguishable from a misspelling. The distinction is the finding.
  const claimed: string[] = [];
  if (mode === "PROVIDER_REPORTED") {
    for (const field of INDEPENDENT_ONLY_FIELDS) {
      if (Object.hasOwn(value, field)) {
        claimed.push(field);
        issues.push(
          issue(
            `${path}/${field}`,
            "provider_reported_claims_independent_retrieval",
            `SRC-02: ${field} belongs to an observation Vinci performed; a vendor returning a citation is `
              + "evidence that the vendor returned it, not that the source was retrieved",
          ),
        );
      }
    }
  }
  const reported = new Set(claimed.map((field) => `${path}/${field}`));
  rejectUnknownFields(
    value,
    OBSERVATION_FIELDS[mode as SourceObservationMode],
    path,
    "an observation",
    issues,
    reported,
  );

  if (value.retrievedRange !== null && !isRefText(value.retrievedRange)) {
    issues.push(
      issue(`${path}/retrievedRange`, "invalid_ref", "retrievedRange is a ref or explicitly null"),
    );
  }
  if (value.retrievalCostMicrousd !== null) {
    readCost(value.retrievalCostMicrousd, `${path}/retrievalCostMicrousd`, issues);
  }

  if (mode === "INDEPENDENT_RETRIEVAL") {
    if (!isRefText(value.adapterVersion)) {
      issues.push(
        issue(`${path}/adapterVersion`, "required_field", "an independent retrieval names the adapter that performed it"),
      );
    }
    if (!isRefText(value.contentType)) {
      issues.push(issue(`${path}/contentType`, "required_field", "an independent retrieval records the content type"));
    }
    if (!isRefText(value.encoding)) {
      issues.push(issue(`${path}/encoding`, "required_field", "an independent retrieval records the encoding"));
    }
    if (value.observedBytesDigest !== null && !isDigest(value.observedBytesDigest)) {
      issues.push(
        issue(
          `${path}/observedBytesDigest`,
          "invalid_digest",
          "INV-09: an independent retrieval identifies the bytes it observed, or states that it received none",
        ),
      );
    }
  } else {
    if (!isIdentifier(value.providerId)) {
      issues.push(issue(`${path}/providerId`, "invalid_id", "a provider report names the provider"));
    }
    if (!isRefText(value.providerReceiptRef)) {
      issues.push(
        issue(`${path}/providerReceiptRef`, "required_field", "a provider report names the receipt it came from"),
      );
    }
  }
}

function validateContentBinding(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isObjectRecord(value)) {
    issues.push(issue(path, "invalid_type", "content is an object or explicitly null"));
    return;
  }
  rejectUnknownFields(
    value,
    [
      "rawArtifactRef",
      "rawDigest",
      "extractedArtifactRef",
      "extractedDigest",
      "extractionVersion",
      "textOffsets",
      "pageLocations",
    ],
    path,
    "a content binding",
    issues,
  );
  if (!isRefText(value.rawArtifactRef)) {
    issues.push(issue(`${path}/rawArtifactRef`, "invalid_ref", "rawArtifactRef names the stored bytes"));
  }
  if (!isDigest(value.rawDigest)) {
    issues.push(issue(`${path}/rawDigest`, "invalid_digest", "rawDigest is 64 lowercase hex characters"));
  }
  // Extraction is a pair: a reference with no digest names bytes nobody can
  // check, and a digest with no reference identifies bytes nobody can fetch.
  const hasRef = value.extractedArtifactRef !== null;
  const hasDigest = value.extractedDigest !== null;
  if (hasRef !== hasDigest) {
    issues.push(
      issue(
        `${path}/extractedDigest`,
        "extraction_pair_incomplete",
        "an extracted artifact carries both its reference and its digest, or neither",
      ),
    );
  }
  if (hasRef && !isRefText(value.extractedArtifactRef)) {
    issues.push(issue(`${path}/extractedArtifactRef`, "invalid_ref", "extractedArtifactRef is a ref or null"));
  }
  if (hasDigest && !isDigest(value.extractedDigest)) {
    issues.push(issue(`${path}/extractedDigest`, "invalid_digest", "extractedDigest is 64 lowercase hex or null"));
  }
  if (!isRefText(value.extractionVersion)) {
    issues.push(
      issue(`${path}/extractionVersion`, "required_field", "CON-04: the extraction that produced this text is versioned"),
    );
  }
  const offsets = value.textOffsets;
  if (offsets !== null) {
    if (!isObjectRecord(offsets)) {
      issues.push(issue(`${path}/textOffsets`, "invalid_type", "textOffsets is an object or explicitly null"));
    } else {
      rejectUnknownFields(offsets, ["startOffset", "endOffset"], `${path}/textOffsets`, "textOffsets", issues);
      if (!isNonNegativeInt(offsets.startOffset)) {
        issues.push(issue(`${path}/textOffsets/startOffset`, "invalid_type", "startOffset is a non-negative integer"));
      }
      if (!isNonNegativeInt(offsets.endOffset)) {
        issues.push(issue(`${path}/textOffsets/endOffset`, "invalid_type", "endOffset is a non-negative integer"));
      }
      if (
        isNonNegativeInt(offsets.startOffset)
        && isNonNegativeInt(offsets.endOffset)
        && offsets.endOffset < offsets.startOffset
      ) {
        issues.push(issue(`${path}/textOffsets/endOffset`, "inverted_range", "a span ends no earlier than it starts"));
      }
    }
  }
  if (!Array.isArray(value.pageLocations)) {
    issues.push(issue(`${path}/pageLocations`, "invalid_type", "pageLocations is an array"));
  } else {
    value.pageLocations.forEach((page, i) => {
      if (!isNonNegativeInt(page)) {
        issues.push(issue(`${path}/pageLocations/${i}`, "invalid_type", "a page location is a non-negative integer"));
      }
    });
  }
}

/** Validate a source record from untrusted input. */
export function validateSourceRecord(input: unknown): ValidationResult<SourceRecord> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];

  rejectUnknownFields(record, SOURCE_FIELDS, "", "a source record", issues);
  checkSchemaVersion(record.schemaVersion, "/schemaVersion", issues);

  for (const field of ["sourceId", "requestRef", "runRef", "workspaceRef"] as const) {
    if (!isIdentifier(record[field])) {
      issues.push(issue(`/${field}`, "invalid_id", `${field} is host-assigned and stable (SRC-03)`));
    }
  }
  readEnum(record.sourceKind, SOURCE_KINDS, "/sourceKind", "unknown_source_kind", "sourceKind must come from SOURCE_KINDS", issues);

  // SRC-03. Presentation numbering is a rendering artefact, so it is nullable
  // and lives nowhere near the identity fields above.
  if (record.presentationIndex !== null && !isNonNegativeInt(record.presentationIndex)) {
    issues.push(
      issue(
        "/presentationIndex",
        "invalid_type",
        "presentationIndex is a non-negative integer or explicitly null; it is a rendering artefact, never a reference",
      ),
    );
  }

  const origin = record.origin;
  if (!isObjectRecord(origin)) {
    issues.push(issue("/origin", "invalid_type", "origin is an object"));
  } else {
    rejectUnknownFields(
      origin,
      ["locator", "repositoryId", "repositoryPath", "repositoryRevision", "publisher"],
      "/origin",
      "origin",
      issues,
    );
    if (!isRefText(origin.locator)) {
      issues.push(issue("/origin/locator", "required_field", "a source has a canonical locator"));
    }
    for (const field of ["repositoryId", "repositoryPath", "publisher"] as const) {
      if (origin[field] !== null && !isRefText(origin[field])) {
        issues.push(issue(`/origin/${field}`, "invalid_ref", `${field} is a ref or explicitly null`));
      }
    }
    if (origin.repositoryRevision !== null && !isGitObjectId(origin.repositoryRevision)) {
      issues.push(
        issue(
          "/origin/repositoryRevision",
          "invalid_git_object_id",
          "a repository revision is 40 lowercase hex characters, or explicitly null",
        ),
      );
    }
    // A repository file read at an unnamed revision names a moving target: the
    // same locator resolves to different bytes tomorrow, and every claim built
    // on it silently loses its subject.
    if (record.sourceKind === "repository_file" && origin.repositoryRevision === null) {
      issues.push(
        issue(
          "/origin/repositoryRevision",
          "repository_source_without_revision",
          "a repository source is observed AT a revision; without one the locator names whatever it holds today",
        ),
      );
    }
  }

  const time = record.time;
  if (!isObjectRecord(time)) {
    issues.push(issue("/time", "invalid_type", "time is an object"));
  } else {
    rejectUnknownFields(time, ["retrievedAt", "publishedAt", "updatedAt", "eventAt"], "/time", "time", issues);
    if (!isCanonicalTimestamp(time.retrievedAt)) {
      issues.push(issue("/time/retrievedAt", "invalid_timestamp", "retrievedAt is when the attempt was made, known even when it failed"));
    }
    for (const field of ["publishedAt", "updatedAt", "eventAt"] as const) {
      if (time[field] !== null && !isCanonicalTimestamp(time[field])) {
        issues.push(
          issue(
            `/time/${field}`,
            "invalid_timestamp",
            `${field} is a canonical timestamp or explicitly null; CON-02 keeps unknown and absent apart`,
          ),
        );
      }
    }
    if (isStrictlyAfter(time.publishedAt, time.updatedAt)) {
      issues.push(
        issue("/time/updatedAt", "updated_before_published", "a source cannot be updated before it was published"),
      );
    }
  }

  validateObservation(record.observation, "/observation", issues);
  validateRequestedRange(record.requestedRange, "/requestedRange", issues);

  readEnum(
    record.completeness,
    SOURCE_COMPLETENESS,
    "/completeness",
    "unknown_completeness",
    "completeness must come from SOURCE_COMPLETENESS",
    issues,
  );
  readEnum(
    record.readOutcome,
    SOURCE_READ_OUTCOMES,
    "/readOutcome",
    "unknown_read_outcome",
    "readOutcome must come from SOURCE_READ_OUTCOMES",
    issues,
  );
  readEnum(
    record.matchState,
    SOURCE_MATCH_STATES,
    "/matchState",
    "unknown_match_state",
    "matchState must come from SOURCE_MATCH_STATES",
    issues,
  );

  const content = record.content;
  if (content !== null) validateContentBinding(content, "/content", issues);

  // SRC-04. The read outcome decides everything downstream of it, and the
  // rules run only when the outcome itself is a known member — otherwise an
  // unknown discriminator would produce four consequential findings about a
  // record whose one real problem is the discriminator.
  if (isEnumMember(record.readOutcome, SOURCE_READ_OUTCOMES)) {
    const obtained = (OBTAINING_OUTCOMES as readonly string[]).includes(record.readOutcome);
    if (!obtained) {
      if (content !== null) {
        issues.push(
          issue(
            "/content",
            "failed_read_with_content",
            "SRC-04: a failed or empty read is a typed result, not a success record carrying content",
          ),
        );
      }
      if (record.completeness !== "NOT_OBTAINED") {
        issues.push(
          issue(
            "/completeness",
            "unobtained_read_claims_completeness",
            "SRC-04: nothing was obtained, so no part of the requested range was",
          ),
        );
      }
      if (record.matchState !== "NOT_SEARCHED") {
        issues.push(
          issue(
            "/matchState",
            "match_state_without_content",
            "there is no content to have matched; a search that returned nothing is the read outcome, not a match state",
          ),
        );
      }
      if (record.coversEntireDocument !== null) {
        issues.push(
          issue(
            "/coversEntireDocument",
            "document_coverage_claimed_without_content",
            "nothing was obtained, so whether the range covers the document is unknown — which is null, not false",
          ),
        );
      }
    } else {
      if (content === null) {
        issues.push(
          issue(
            "/content",
            "obtained_read_without_content",
            "SRC-04: a read that obtained bytes binds them; an empty success is the shape this rule exists to refuse",
          ),
        );
      }
      if (
        isObjectRecord(record.observation)
        && record.observation.mode === "INDEPENDENT_RETRIEVAL"
        && record.observation.observedBytesDigest === null
      ) {
        issues.push(
          issue(
            "/observation/observedBytesDigest",
            "obtained_read_without_observed_bytes",
            "this read obtained content, so it received bytes; null says it received none",
          ),
        );
      }
      if (record.matchState === "NOT_SEARCHED" && record.requestedRange !== null
        && isObjectRecord(record.requestedRange) && record.requestedRange.kind === "search_query") {
        issues.push(
          issue(
            "/matchState",
            "search_result_without_match_state",
            "a search range was requested and content was obtained, so whether it matched is a fact this record has",
          ),
        );
      }
      if (record.completeness === "NOT_OBTAINED") {
        issues.push(
          issue(
            "/completeness",
            "obtained_read_claims_nothing_obtained",
            "the read obtained bytes; NOT_OBTAINED contradicts its own outcome",
          ),
        );
      } else if (record.readOutcome === "READ_COMPLETE" && record.completeness !== "FULL_REQUESTED_RANGE") {
        issues.push(
          issue(
            "/completeness",
            "complete_read_not_full_range",
            "READ_COMPLETE means the whole requested range was obtained",
          ),
        );
      } else if (
        record.readOutcome === "READ_PARTIAL"
        && record.completeness === "FULL_REQUESTED_RANGE"
      ) {
        issues.push(
          issue(
            "/completeness",
            "partial_read_claims_full_range",
            "SRC-01: a partial read did not obtain the full requested range",
          ),
        );
      }
      if (typeof record.coversEntireDocument !== "boolean") {
        issues.push(
          issue(
            "/coversEntireDocument",
            "required_field",
            "content was obtained, so whether the requested range was the whole document is answerable: true or false, never null",
          ),
        );
      }
    }
  }

  // SRC-01, the sentence itself: full requested range does not mean full
  // document unless the request WAS the entire document.
  if (
    record.coversEntireDocument === true
    && isObjectRecord(record.requestedRange)
    && record.requestedRange.kind !== "entire_document"
  ) {
    issues.push(
      issue(
        "/coversEntireDocument",
        "full_document_claimed_for_partial_range",
        "SRC-01: the requested range was not the entire document, so obtaining all of it is not obtaining the document",
      ),
    );
  }

  readEnumArray(
    record.limitations,
    SOURCE_LIMITATIONS,
    "/limitations",
    "unknown_limitation",
    "limitations members come from SOURCE_LIMITATIONS",
    issues,
  );
  // SRC-02 again, from the other side: a provider report IS provider-only
  // attribution, and a record that does not say so reads as an observation.
  if (
    isObjectRecord(record.observation)
    && record.observation.mode === "PROVIDER_REPORTED"
    && Array.isArray(record.limitations)
    && !record.limitations.includes("provider_only_attribution")
  ) {
    issues.push(
      issue(
        "/limitations",
        "provider_report_without_attribution_limit",
        "SRC-02: a provider-reported source carries provider_only_attribution among its limitations",
      ),
    );
  }

  const policy = record.policy;
  if (!isObjectRecord(policy)) {
    issues.push(issue("/policy", "invalid_type", "policy is an object"));
  } else {
    rejectUnknownFields(
      policy,
      ["classification", "permittedAudiences", "retentionRule", "researchUse", "trainingUse"],
      "/policy",
      "policy",
      issues,
    );
    readEnum(
      policy.classification,
      ORACLE_DATA_CLASSIFICATIONS,
      "/policy/classification",
      "unknown_classification",
      "classification must come from ORACLE_DATA_CLASSIFICATIONS",
      issues,
    );
    readRefArray(policy.permittedAudiences, "/policy/permittedAudiences", "permittedAudiences", issues);
    if (!isRefText(policy.retentionRule)) {
      issues.push(issue("/policy/retentionRule", "required_field", "a source names the retention rule it is held under"));
    }
    readEnum(policy.researchUse, SOURCE_USE_PERMISSIONS, "/policy/researchUse", "unknown_use_permission", "researchUse must come from SOURCE_USE_PERMISSIONS", issues);
    readEnum(policy.trainingUse, SOURCE_USE_PERMISSIONS, "/policy/trainingUse", "unknown_use_permission", "trainingUse must come from SOURCE_USE_PERMISSIONS", issues);
  }

  if (!Array.isArray(record.relationships)) {
    issues.push(issue("/relationships", "invalid_type", "relationships is an array"));
  } else {
    record.relationships.forEach((raw, i) => {
      const path = `/relationships/${i}`;
      if (!isObjectRecord(raw)) {
        issues.push(issue(path, "invalid_type", "a relationship is an object"));
        return;
      }
      rejectUnknownFields(raw, ["kind", "sourceId"], path, "a relationship", issues);
      readEnum(raw.kind, SOURCE_RELATIONSHIP_KINDS, `${path}/kind`, "unknown_relationship_kind", "kind must come from SOURCE_RELATIONSHIP_KINDS", issues);
      if (!isIdentifier(raw.sourceId)) {
        issues.push(issue(`${path}/sourceId`, "invalid_id", "a relationship names another host-assigned source id"));
      } else if (raw.sourceId === record.sourceId) {
        issues.push(
          issue(`${path}/sourceId`, "self_relationship", "a source is not a syndication or derivative of itself"),
        );
      }
    });
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as SourceRecord, {});
}

/** The identity of a source record: SHA-256 over its canonical, validated bytes. */
export function sourceRecordDigest(record: SourceRecord): string {
  return digestValidated("source record", validateSourceRecord(record));
}

/**
 * What the model was actually handed: a stable id and the run and workspace it
 * belongs to.
 *
 * SRC-03. This is the whole of what a citation may refer to. Everything else on
 * a `SourceRecord` — the bytes, the digests, the provider receipt — stays on
 * the host side, so a model cannot restate any of it and have the restatement
 * believed.
 */
export type DeliveredSourceHandle = {
  readonly sourceId: string;
  readonly runRef: string;
  readonly workspaceRef: string;
  readonly presentationIndex: number | null;
};

export function validateDeliveredSourceHandle(
  input: unknown,
): ValidationResult<DeliveredSourceHandle> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];

  rejectUnknownFields(
    record,
    ["sourceId", "runRef", "workspaceRef", "presentationIndex"],
    "",
    "a delivered source handle",
    issues,
  );
  for (const field of ["sourceId", "runRef", "workspaceRef"] as const) {
    if (!isIdentifier(record[field])) {
      issues.push(issue(`/${field}`, "invalid_id", `${field} is a host-assigned identifier`));
    }
  }
  if (record.presentationIndex !== null && !isNonNegativeInt(record.presentationIndex)) {
    issues.push(
      issue("/presentationIndex", "invalid_type", "presentationIndex is a non-negative integer or explicitly null"),
    );
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as DeliveredSourceHandle, {});
}

/** The handle a validated source record projects to. A projection, not a decision. */
export function deliveredHandle(record: SourceRecord): DeliveredSourceHandle {
  return {
    sourceId: record.sourceId,
    runRef: record.runRef,
    workspaceRef: record.workspaceRef,
    presentationIndex: record.presentationIndex,
  };
}

/**
 * What a model proposes when it cites something.
 *
 * A citation names a `sourceId` and says what it is offered for. It carries no
 * digest, no locator and no retrieval claim, because a model asserting any of
 * those would be asserting an observation it did not make — CON-03, and the
 * reason this type is `ModelAuthored`.
 */
export type SourceCitationPayload = ModelAuthored<{
  sourceId: string;
  quotedSpan: { startOffset: number; endOffset: number } | null;
  offeredFor: string;
}>;

/** The host half of a citation: which report or claim the citation appears in. */
export type SourceCitationHost = {
  readonly citationId: string;
  readonly appearsInRef: string;
};

export type SourceCitation = AttestedEnvelope<SourceCitationHost, SourceCitationPayload>;

export function validateSourceCitation(input: unknown): ValidationResult<SourceCitation> {
  const envelope = validateAttestedEnvelope(input);
  if (!envelope.ok) return envelope;
  const record = envelope.value;
  const issues: ValidationIssue[] = [];

  if (record.envelopeKind !== "oracle_source_citation") {
    issues.push(
      issue(
        "/envelopeKind",
        "envelope_kind_mismatch",
        "this envelope carries a different record; a discriminator is refused, not approximately matched",
      ),
    );
  }

  const host = record.hostResolved;
  if (isObjectRecord(host)) {
    rejectUnknownFields(host, ["citationId", "appearsInRef"], "/hostResolved", "a citation's host half", issues);
    if (!isIdentifier(host.citationId)) {
      issues.push(issue("/hostResolved/citationId", "invalid_id", "citationId is host-assigned"));
    }
    if (!isRefText(host.appearsInRef)) {
      issues.push(issue("/hostResolved/appearsInRef", "invalid_ref", "appearsInRef names where this citation appears"));
    }
  }

  const payload = record.payload;
  if (isObjectRecord(payload)) {
    rejectUnknownFields(
      payload,
      ["sourceId", "quotedSpan", "offeredFor"],
      "/payload",
      "a citation's model-authored half",
      issues,
    );
    // Deliberately only a SHAPE check here. Whether this id was ever delivered
    // is not answerable from the citation alone, and pretending otherwise is
    // how a validator comes to look like a guarantee it never made — see
    // resolveCitations, which is the function that actually answers it.
    if (!isIdentifier(payload.sourceId)) {
      issues.push(issue("/payload/sourceId", "invalid_id", "a citation names a host-assigned source id"));
    }
    const span = payload.quotedSpan;
    if (span !== null) {
      if (!isObjectRecord(span)) {
        issues.push(issue("/payload/quotedSpan", "invalid_type", "quotedSpan is an object or explicitly null"));
      } else {
        rejectUnknownFields(span, ["startOffset", "endOffset"], "/payload/quotedSpan", "quotedSpan", issues);
        for (const field of ["startOffset", "endOffset"] as const) {
          if (!isNonNegativeInt(span[field])) {
            issues.push(issue(`/payload/quotedSpan/${field}`, "invalid_type", `${field} is a non-negative integer`));
          }
        }
        if (
          isNonNegativeInt(span.startOffset)
          && isNonNegativeInt(span.endOffset)
          && span.endOffset < span.startOffset
        ) {
          issues.push(issue("/payload/quotedSpan/endOffset", "inverted_range", "a span ends no earlier than it starts"));
        }
      }
    }
    if (!isProseText(payload.offeredFor)) {
      issues.push(issue("/payload/offeredFor", "required_field", "a citation says what it is offered for"));
    }
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as SourceCitation, {});
}

/** The identity of a citation: SHA-256 over its canonical, validated bytes. */
export function sourceCitationDigest(citation: SourceCitation): string {
  return digestValidated("source citation", validateSourceCitation(citation));
}

/**
 * SRC-03 / T05. Whether every citation refers to a source that was actually
 * delivered, in this citation's own run and workspace.
 *
 * `UNRESOLVED` rather than a boolean, and one issue per citation rather than
 * one for the set, because "some citation does not resolve" is not actionable
 * and naming which one is. `REFUSED` is separate again: a malformed citation or
 * a malformed handle is not an unresolved reference, it is not a reference.
 */
export type CitationResolution =
  | { readonly outcome: "RESOLVED"; readonly sourceIds: readonly string[] }
  | { readonly outcome: "UNRESOLVED"; readonly issues: readonly ValidationIssue[] }
  | { readonly outcome: "REFUSED"; readonly issues: readonly ValidationIssue[] };

export function resolveCitations(citations: unknown, delivered: unknown): CitationResolution {
  // Both arguments through the inert-snapshot boundary FIRST, as one record.
  //
  // `Array.isArray` plus `forEach` was not enough, and the repository-wide
  // hostile-key check said so before this shipped: `new Array(1)` is an array
  // whose one element `forEach` silently skips, so a citation list claiming one
  // citation resolved as a list of none — a vacuous RESOLVED, which is the
  // exact shape this function exists to prevent one level up. An array that
  // overrides `every`, one that lies about `length`, and a Proxy whose `length`
  // getter throws each broke it a different way.
  //
  // `toPlainRecord` already answers all of those, and answers them the same way
  // every validator in this repository does. Wrapping the two arguments in one
  // object also gives the refusals the paths a caller would expect.
  const plain = toPlainRecord({ citations, delivered });
  if (!plain.ok) return { outcome: "REFUSED", issues: plain.issues };
  const snapshot = plain.value;

  if (!Array.isArray(snapshot.citations)) {
    return {
      outcome: "REFUSED",
      issues: [issue("/citations", "invalid_type", "citations is an array")],
    };
  }
  if (!Array.isArray(snapshot.delivered)) {
    return {
      outcome: "REFUSED",
      issues: [issue("/delivered", "invalid_type", "the delivered source set is an array")],
    };
  }
  const citationList: readonly unknown[] = snapshot.citations;
  const deliveredList: readonly unknown[] = snapshot.delivered;

  const handles: DeliveredSourceHandle[] = [];
  const refusals: ValidationIssue[] = [];
  const deliveredIds = new Set<string>();
  deliveredList.forEach((raw, i) => {
    const parsed = validateDeliveredSourceHandle(raw);
    if (!parsed.ok) {
      for (const entry of parsed.issues) {
        refusals.push(issue(`/delivered/${i}${entry.path}`, entry.code, entry.message));
      }
      return;
    }
    // A duplicate id last-won silently, and the two entries can disagree about
    // the run or workspace that delivered the source — so which one survived
    // decided whether a citation resolved. The authorized-work set got this
    // treatment a round earlier; the delivered set is the same shape and the
    // same anchor, and an anchor that decides by insertion order is not one.
    if (deliveredIds.has(parsed.value.sourceId)) {
      refusals.push(
        issue(
          `/delivered/${i}/sourceId`,
          "duplicate_delivered_source",
          "the delivered set names one source twice; if the two entries disagree, which survives "
            + "decides whether a citation resolves",
        ),
      );
      return;
    }
    deliveredIds.add(parsed.value.sourceId);
    handles.push(parsed.value);
  });

  const parsedCitations: SourceCitation[] = [];
  citationList.forEach((raw, i) => {
    const parsed = validateSourceCitation(raw);
    if (!parsed.ok) {
      for (const entry of parsed.issues) {
        refusals.push(issue(`/citations/${i}${entry.path}`, entry.code, entry.message));
      }
      return;
    }
    parsedCitations.push(parsed.value);
  });
  if (refusals.length > 0) return { outcome: "REFUSED", issues: refusals };

  const byId = new Map(handles.map((handle) => [handle.sourceId, handle]));
  // SRC-03's specific trap: the number a reader saw beside the citation. It is
  // a real string that names a real source in one rendering and a different one
  // in the next, so it gets its own refusal rather than reading as an id that
  // happens not to exist.
  const byPresentation = new Set(
    handles
      .filter((handle) => handle.presentationIndex !== null)
      .map((handle) => String(handle.presentationIndex)),
  );

  const unresolved: ValidationIssue[] = [];
  const resolved: string[] = [];
  parsedCitations.forEach((citation, i) => {
    const path = `/citations/${i}/payload/sourceId`;
    const sourceId = citation.payload.sourceId;
    const handle = byId.get(sourceId);
    if (handle === undefined) {
      if (byPresentation.has(sourceId)) {
        unresolved.push(
          issue(
            path,
            "presentation_index_used_as_reference",
            "SRC-03: source numbering is presentation-only and does not survive re-rendering; cite the host-assigned id",
          ),
        );
        return;
      }
      unresolved.push(
        issue(
          path,
          "undelivered_source_id",
          "SRC-03: this source was never delivered to this run; a model cannot cite a source it did not receive by inventing an id",
        ),
      );
      return;
    }
    if (handle.runRef !== citation.runRef) {
      unresolved.push(
        issue(
          path,
          "foreign_run_source",
          "this source belongs to a different run; a delivered handle resolves only inside the run it was delivered to",
        ),
      );
      return;
    }
    if (handle.workspaceRef !== citation.workspaceRef) {
      unresolved.push(
        issue(
          path,
          "foreign_workspace_source",
          "this source belongs to a different workspace; resolving it here would cross an organizational boundary",
        ),
      );
      return;
    }
    resolved.push(sourceId);
  });

  if (unresolved.length > 0) return { outcome: "UNRESOLVED", issues: unresolved };
  return { outcome: "RESOLVED", sourceIds: resolved };
}

export const SOURCE_RECORD_SCHEMA_META: SchemaMeta = {
  id: "vinci.oracle.source-record",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};

export const SOURCE_CITATION_SCHEMA_META: SchemaMeta = {
  id: "vinci.oracle.source-citation",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};
