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
import type { ObservationWindow } from "./oracle-context.ts";
import {
  SOURCE_COMPLETENESS,
  SOURCE_OBSERVATION_MODES,
  type SourceCompleteness,
  type SourceObservationMode,
} from "./source-record.ts";
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
  readRefArray,
  readStringList,
  rejectUnknownFields,
} from "./lib/validate.ts";

/**
 * §5.6. The decision-facing record, and the three fields REP-02 refuses to let
 * anyone collapse.
 *
 * `reportCompleteness`, `assessmentCoverage` and `runTerminalState` answer three
 * different questions — did the report say everything it set out to say, was
 * every claim in it actually checked, and did the run finish — and INV-10 says
 * a completed Run, a supported claim, an authorized action and an accepted
 * outcome are four distinct states. A schema with one `status` field forces
 * whoever writes it to pick one and lose the rest, and the one they pick will
 * be the flattering one, because it is the one the summary is about.
 *
 * So there is no rule anywhere below relating these three to each other. A
 * COMPLETE report of a PARTIAL run with zero assessments is a valid record, and
 * it is a record a reader can act on precisely because none of its three
 * numbers was inferred from another.
 */

/** Did the report deliver what it set out to? Nothing about the run, nothing about assessment. */
export const REPORT_COMPLETENESS = ["COMPLETE", "PARTIAL", "FAILED"] as const;
export type ReportCompleteness = (typeof REPORT_COMPLETENESS)[number];

/** How the operational run ended. Nothing about whether the findings are any good. */
export const RUN_TERMINAL_STATES = ["SUCCEEDED", "PARTIALLY_COMPLETED", "FAILED", "ABORTED"] as const;
export type RunTerminalState = (typeof RUN_TERMINAL_STATES)[number];

/**
 * §22.2's `cost.state`. What is actually known about what this cost.
 *
 * `RECONCILIATION_PENDING` is not a smaller number than `MEASURED`; it is the
 * absence of one, and a reader deciding whether to authorise more work needs to
 * see which of the two they have.
 */
export const REPORT_COST_STATES = [
  "MEASURED",
  "ESTIMATED",
  "RECONCILIATION_PENDING",
  "UNAVAILABLE",
] as const;
export type ReportCostState = (typeof REPORT_COST_STATES)[number];

/** The cost states that carry an actual number. */
const COSTED_STATES: readonly ReportCostState[] = ["MEASURED", "ESTIMATED"];

export type ReportCost = {
  readonly state: ReportCostState;
  readonly amountMicrousd: number | null;
  readonly ledgerRef: string | null;
};

export type ReportRevision = {
  readonly repositoryId: string;
  readonly revision: string;
};

/** §22.3's "As of": the observation window and the revisions it was observed at. */
export type ReportScope = {
  readonly subject: string;
  readonly observationWindow: ObservationWindow;
  readonly revisions: readonly ReportRevision[];
};

/**
 * One claim in the report, by reference.
 *
 * §22.2 carries its own warning and this is it, made mechanical: "a strict
 * implementation must use the canonical independently stored assessment rather
 * than trusting an inline model-written `assessment_status`". So an entry names
 * the assessment; it does not carry a status. A field called `assessmentStatus`
 * here is refused BY THAT NAME rather than as an unknown field, because the
 * finding is not "this record has a typo" — it is "this report is asserting the
 * result of a check instead of pointing at it".
 *
 * `assessmentRef` is null when no assessment is stored, which is exactly the
 * §22.2 case, and is why REP-02's coverage numbers are checkable at all.
 */
export type ReportClaimEntry = {
  readonly claimRef: string;
  readonly claimDigest: string;
  readonly assessmentRef: string | null;
};

/** §22.3's source manifest: exact references, completeness, dates and methods. */
export type ReportSourceEntry = {
  readonly sourceId: string;
  readonly citationRefs: readonly string[];
  readonly completeness: SourceCompleteness;
  readonly observationMode: SourceObservationMode;
  readonly retrievedAt: string;
};

/**
 * REP-02's second field, as counts rather than a label.
 *
 * A label ("full", "partial") would be a summary of the numbers, and a summary
 * is what a consumer cannot check. These three are cross-checked against the
 * claim entries below, so a report cannot claim coverage it does not have — and
 * a reader who wants the ratio can compute it, which is the direction that
 * loses nothing.
 */
export type AssessmentCoverage = {
  readonly claimsTotal: number;
  readonly claimsWithStoredAssessment: number;
  readonly claimsNotAssessed: number;
};

export type ResearchReport = {
  readonly schemaVersion: 1;
  readonly reportId: string;
  readonly requestRef: string;
  readonly runRef: string;
  readonly workspaceRef: string;
  readonly contextManifestDigest: string;
  /** §22.3's H1: the decision or question this report is about. */
  readonly decisionQuestion: string;
  /** REP-03: leads with the decision consequence. Bounded, and never the place limitations go. */
  readonly summary: string;
  readonly scope: ReportScope;
  readonly reportCompleteness: ReportCompleteness;
  readonly assessmentCoverage: AssessmentCoverage;
  readonly runTerminalState: RunTerminalState;
  readonly claims: readonly ReportClaimEntry[];
  readonly sourceManifest: readonly ReportSourceEntry[];
  readonly alternatives: readonly string[];
  readonly contradictions: readonly string[];
  readonly materialUnknowns: readonly string[];
  /** The proposal this report leads to — advisory, and a reference. See DecisionProposal. */
  readonly proposalRef: string | null;
  /** Required whenever the report is not COMPLETE: what stopped, and why. */
  readonly stopExplanation: string | null;
  readonly cost: ReportCost;
  readonly invalidationConditions: readonly string[];
  readonly issuedAt: string;
};

const REPORT_FIELDS = [
  "schemaVersion",
  "reportId",
  "requestRef",
  "runRef",
  "workspaceRef",
  "contextManifestDigest",
  "decisionQuestion",
  "summary",
  "scope",
  "reportCompleteness",
  "assessmentCoverage",
  "runTerminalState",
  "claims",
  "sourceManifest",
  "alternatives",
  "contradictions",
  "materialUnknowns",
  "proposalRef",
  "stopExplanation",
  "cost",
  "invalidationConditions",
  "issuedAt",
] as const;

const CLAIM_ENTRY_FIELDS = ["claimRef", "claimDigest", "assessmentRef"] as const;

/**
 * The inline-status field names §22.2 warns about, refused by name.
 *
 * Substring-matched and case-folded for the reason `AUTHORITY_TERMS` is:
 * `assessment_status`, `assessmentStatus` and `claimAssessmentStatus` are one
 * idea under three spellings, and a list of exact names covers whichever two
 * nobody thought of.
 */
const INLINE_ASSESSMENT_TERMS = ["assessmentstatus", "assessment_status", "status"] as const;

function validateClaimEntries(value: unknown, issues: ValidationIssue[]): number {
  if (!Array.isArray(value)) {
    issues.push(issue("/claims", "invalid_type", "claims is an array"));
    return -1;
  }
  let withAssessment = 0;
  value.forEach((raw, i) => {
    const at = `/claims/${i}`;
    if (!isObjectRecord(raw)) {
      issues.push(issue(at, "invalid_type", "a claim entry is an object"));
      return;
    }
    // §22.2's warning, BEFORE the allowlist and with its own code, so the
    // refusal names the mechanism rather than reading as a spelling mistake.
    const inline: string[] = [];
    for (const key of Object.keys(raw)) {
      const folded = key.toLowerCase();
      if (INLINE_ASSESSMENT_TERMS.some((term) => folded.includes(term))) {
        inline.push(key);
        issues.push(
          issue(
            `${at}/${key}`,
            "inline_assessment_status",
            "§22.2: a report references the canonical independently stored assessment; an inline, "
              + "model-written status is the thing a strict implementation must not trust",
          ),
        );
      }
    }
    rejectUnknownFields(
      raw,
      CLAIM_ENTRY_FIELDS,
      at,
      "a claim entry",
      issues,
      new Set(inline.map((key) => `${at}/${key}`)),
    );
    if (!isIdentifier(raw.claimRef)) {
      issues.push(issue(`${at}/claimRef`, "invalid_id", "claimRef is a host-assigned claim id"));
    }
    if (!isDigest(raw.claimDigest)) {
      issues.push(
        issue(
          `${at}/claimDigest`,
          "invalid_digest",
          "claimDigest binds the entry to the exact claim; without it the report cites a moving target",
        ),
      );
    }
    if (raw.assessmentRef === null) return;
    if (!isIdentifier(raw.assessmentRef)) {
      issues.push(
        issue(
          `${at}/assessmentRef`,
          "invalid_id",
          "assessmentRef names the stored assessment, or is explicitly null when none was stored",
        ),
      );
      return;
    }
    withAssessment += 1;
  });
  return withAssessment;
}

function validateSourceManifest(value: unknown, issues: ValidationIssue[]): void {
  if (!Array.isArray(value)) {
    issues.push(issue("/sourceManifest", "invalid_type", "sourceManifest is an array"));
    return;
  }
  const seen = new Set<string>();
  value.forEach((raw, i) => {
    const at = `/sourceManifest/${i}`;
    if (!isObjectRecord(raw)) {
      issues.push(issue(at, "invalid_type", "a manifest entry is an object"));
      return;
    }
    rejectUnknownFields(
      raw,
      ["sourceId", "citationRefs", "completeness", "observationMode", "retrievedAt"],
      at,
      "a source manifest entry",
      issues,
    );
    if (!isIdentifier(raw.sourceId)) {
      issues.push(issue(`${at}/sourceId`, "invalid_id", "a manifest entry names the host-assigned source id"));
    } else if (seen.has(raw.sourceId)) {
      // One source listed twice inflates the apparent breadth of the evidence,
      // which is the number a reader weighs a report by.
      issues.push(issue(`${at}/sourceId`, "duplicate_source_entry", "a manifest names each source once"));
    } else {
      seen.add(raw.sourceId);
    }
    readRefArray(raw.citationRefs, `${at}/citationRefs`, "citationRefs", issues);
    readEnum(
      raw.completeness,
      SOURCE_COMPLETENESS,
      `${at}/completeness`,
      "unknown_completeness",
      "completeness must come from SOURCE_COMPLETENESS; the manifest reports what the read obtained, "
        + "not what the report wishes it had",
      issues,
    );
    readEnum(
      raw.observationMode,
      SOURCE_OBSERVATION_MODES,
      `${at}/observationMode`,
      "unknown_observation_mode",
      "SRC-02: the manifest says who observed the bytes, because a provider-reported citation and a "
        + "retrieval support different claims",
      issues,
    );
    if (!isCanonicalTimestamp(raw.retrievedAt)) {
      issues.push(issue(`${at}/retrievedAt`, "invalid_timestamp", "retrievedAt is a canonical timestamp"));
    }
  });
}

/** Validate a research report from untrusted input. */
export function validateResearchReport(input: unknown): ValidationResult<ResearchReport> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];

  rejectUnknownFields(record, REPORT_FIELDS, "", "a research report", issues);
  checkSchemaVersion(record.schemaVersion, "/schemaVersion", issues);

  for (const field of ["reportId", "requestRef", "runRef", "workspaceRef"] as const) {
    if (!isIdentifier(record[field])) {
      issues.push(issue(`/${field}`, "invalid_id", `${field} is a host-assigned identifier`));
    }
  }
  if (!isDigest(record.contextManifestDigest)) {
    issues.push(
      issue(
        "/contextManifestDigest",
        "invalid_digest",
        "contextManifestDigest is 64 lowercase hex characters; §22.2's immutable scoped manifest",
      ),
    );
  }
  if (!isProseText(record.decisionQuestion)) {
    issues.push(
      issue("/decisionQuestion", "required_field", "REP-03: a report names the decision it is about"),
    );
  }
  if (!isProseText(record.summary)) {
    issues.push(
      issue("/summary", "required_field", "REP-03: a report leads with the decision consequence"),
    );
  }

  const scope = record.scope;
  if (!isObjectRecord(scope)) {
    issues.push(issue("/scope", "invalid_type", "scope is an object"));
  } else {
    rejectUnknownFields(scope, ["subject", "observationWindow", "revisions"], "/scope", "scope", issues);
    if (!isRefText(scope.subject)) {
      issues.push(issue("/scope/subject", "required_field", "a report names what it is about"));
    }
    const window = scope.observationWindow;
    if (!isObjectRecord(window)) {
      issues.push(issue("/scope/observationWindow", "invalid_type", "observationWindow is an object"));
    } else {
      rejectUnknownFields(
        window,
        ["startedAt", "endedAt"],
        "/scope/observationWindow",
        "an observation window",
        issues,
      );
      for (const field of ["startedAt", "endedAt"] as const) {
        if (!isCanonicalTimestamp(window[field])) {
          issues.push(
            issue(`/scope/observationWindow/${field}`, "invalid_timestamp", `${field} is a canonical timestamp`),
          );
        }
      }
      if (isStrictlyAfter(window.startedAt, window.endedAt)) {
        issues.push(
          issue(
            "/scope/observationWindow/endedAt",
            "inverted_window",
            "an observation window does not end before it starts",
          ),
        );
      }
    }
    if (!Array.isArray(scope.revisions)) {
      issues.push(issue("/scope/revisions", "invalid_type", "revisions is an array"));
    } else {
      scope.revisions.forEach((raw, i) => {
        const at = `/scope/revisions/${i}`;
        if (!isObjectRecord(raw)) {
          issues.push(issue(at, "invalid_type", "a revision entry is an object"));
          return;
        }
        rejectUnknownFields(raw, ["repositoryId", "revision"], at, "a revision entry", issues);
        if (!isRefText(raw.repositoryId)) {
          issues.push(issue(`${at}/repositoryId`, "required_field", "a revision names its repository"));
        }
        if (!isGitObjectId(raw.revision)) {
          issues.push(
            issue(
              `${at}/revision`,
              "invalid_git_object_id",
              "a revision is 40 lowercase hex characters; a report's as-of is verifiable or it is decoration",
            ),
          );
        }
      });
    }
  }

  readEnum(
    record.reportCompleteness,
    REPORT_COMPLETENESS,
    "/reportCompleteness",
    "unknown_report_completeness",
    "reportCompleteness must come from REPORT_COMPLETENESS",
    issues,
  );
  readEnum(
    record.runTerminalState,
    RUN_TERMINAL_STATES,
    "/runTerminalState",
    "unknown_run_terminal_state",
    "runTerminalState must come from RUN_TERMINAL_STATES; INV-10 keeps a finished run and a finished "
      + "report apart",
    issues,
  );

  const withAssessment = validateClaimEntries(record.claims, issues);
  validateSourceManifest(record.sourceManifest, issues);

  const coverage = record.assessmentCoverage;
  if (!isObjectRecord(coverage)) {
    issues.push(issue("/assessmentCoverage", "invalid_type", "assessmentCoverage is an object"));
  } else {
    rejectUnknownFields(
      coverage,
      ["claimsTotal", "claimsWithStoredAssessment", "claimsNotAssessed"],
      "/assessmentCoverage",
      "assessment coverage",
      issues,
    );
    for (const field of ["claimsTotal", "claimsWithStoredAssessment", "claimsNotAssessed"] as const) {
      if (!isNonNegativeInt(coverage[field])) {
        issues.push(issue(`/assessmentCoverage/${field}`, "invalid_type", `${field} is a non-negative integer`));
      }
    }
    // REP-02's "missing assessment must be visible to every consumer", as
    // arithmetic. The numbers are declared AND cross-checked: declared, so a
    // consumer reading only the coverage block sees them; cross-checked, so a
    // report cannot declare coverage its own claim list contradicts. Skipped
    // entirely when the claim list did not parse, since every count would then
    // be a finding about the same defect.
    if (withAssessment >= 0 && Array.isArray(record.claims)) {
      const total = record.claims.length;
      if (isNonNegativeInt(coverage.claimsTotal) && coverage.claimsTotal !== total) {
        issues.push(
          issue(
            "/assessmentCoverage/claimsTotal",
            "assessment_coverage_miscounted",
            `claimsTotal says ${coverage.claimsTotal} and the report carries ${total} claims`,
          ),
        );
      }
      if (
        isNonNegativeInt(coverage.claimsWithStoredAssessment)
        && coverage.claimsWithStoredAssessment !== withAssessment
      ) {
        issues.push(
          issue(
            "/assessmentCoverage/claimsWithStoredAssessment",
            "assessment_coverage_miscounted",
            `claimsWithStoredAssessment says ${coverage.claimsWithStoredAssessment} and ${withAssessment} `
              + "claim entries name a stored assessment",
          ),
        );
      }
      if (
        isNonNegativeInt(coverage.claimsNotAssessed)
        && coverage.claimsNotAssessed !== total - withAssessment
      ) {
        issues.push(
          issue(
            "/assessmentCoverage/claimsNotAssessed",
            "assessment_coverage_miscounted",
            `claimsNotAssessed says ${coverage.claimsNotAssessed} and ${total - withAssessment} claim `
              + "entries name no stored assessment",
          ),
        );
      }
    }
  }

  readStringList(record.alternatives, "/alternatives", "alternatives", issues);
  readStringList(record.contradictions, "/contradictions", "contradictions", issues);
  readStringList(record.materialUnknowns, "/materialUnknowns", "materialUnknowns", issues);
  readStringList(record.invalidationConditions, "/invalidationConditions", "invalidationConditions", issues);

  if (record.proposalRef !== null && !isIdentifier(record.proposalRef)) {
    issues.push(
      issue(
        "/proposalRef",
        "invalid_id",
        "proposalRef names a stored DecisionProposal, or is explicitly null; a report proposes nothing "
          + "by containing prose (INV-01)",
      ),
    );
  }

  if (record.stopExplanation !== null && !isProseText(record.stopExplanation)) {
    issues.push(issue("/stopExplanation", "invalid_type", "stopExplanation is prose or explicitly null"));
  }
  // The one rule that DOES read reportCompleteness, and it reads nothing else:
  // a report that did not deliver everything says what stopped. Deliberately
  // not a rule about the run or about coverage — INV-10.
  if (
    isEnumMember(record.reportCompleteness, REPORT_COMPLETENESS)
    && record.reportCompleteness !== "COMPLETE"
    && record.stopExplanation === null
  ) {
    issues.push(
      issue(
        "/stopExplanation",
        "incomplete_report_without_stop_explanation",
        "REP-02: a partial or failed report explains what stopped; concision must not erase limitations (REP-03)",
      ),
    );
  }

  const cost = record.cost;
  if (!isObjectRecord(cost)) {
    issues.push(issue("/cost", "invalid_type", "cost is an object"));
  } else {
    rejectUnknownFields(cost, ["state", "amountMicrousd", "ledgerRef"], "/cost", "cost", issues);
    readEnum(
      cost.state,
      REPORT_COST_STATES,
      "/cost/state",
      "unknown_cost_state",
      "cost.state must come from REPORT_COST_STATES",
      issues,
    );
    if (cost.amountMicrousd !== null) readCost(cost.amountMicrousd, "/cost/amountMicrousd", issues);
    if (cost.ledgerRef !== null && !isRefText(cost.ledgerRef)) {
      issues.push(issue("/cost/ledgerRef", "invalid_ref", "ledgerRef is a ref or explicitly null"));
    }
    if (isEnumMember(cost.state, REPORT_COST_STATES)) {
      const costed = (COSTED_STATES as readonly string[]).includes(cost.state);
      if (costed && cost.amountMicrousd === null) {
        issues.push(
          issue(
            "/cost/amountMicrousd",
            "costed_state_without_amount",
            `${cost.state} says a number is known; null says it is not`,
          ),
        );
      }
      if (!costed && cost.amountMicrousd !== null) {
        issues.push(
          issue(
            "/cost/amountMicrousd",
            "uncosted_state_with_amount",
            `${cost.state} says no number is available; carrying one anyway is how an estimate becomes a `
              + "measurement between two readers",
          ),
        );
      }
    }
  }

  if (!isCanonicalTimestamp(record.issuedAt)) {
    issues.push(issue("/issuedAt", "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision"));
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as ResearchReport, {});
}

/** The identity of a report: SHA-256 over its canonical, validated bytes. */
export function researchReportDigest(report: ResearchReport): string {
  return digestValidated("research report", validateResearchReport(report));
}

export const RESEARCH_REPORT_SCHEMA_META: SchemaMeta = {
  id: "vinci.oracle.research-report",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};
