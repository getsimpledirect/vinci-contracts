import { toPlainRecord, type ValidationIssue } from "@getsimpledirect/vinci-contracts";
import { claimRecordDigest, validateClaimRecord, type ClaimRecord } from "./claim.ts";
import { validateClaimAssessment, type ClaimAssessment } from "./claim-assessment.ts";
import { validateDecisionProposal, type DecisionProposal } from "./decision-proposal.ts";
import { issue } from "./lib/validate.ts";
import { validateResearchReport, type ReportClaimEntry, type ResearchReport } from "./research-report.ts";
import { validateDeliveredSourceHandle, type DeliveredSourceHandle } from "./source-record.ts";

/**
 * THE CROSS-RECORD BINDING, in one place, anchored OUTSIDE the records it checks.
 *
 * This module exists because the renderer decided whether an assessment
 * belonged to a claim with a single comparison — `assessment.claimDigest !==
 * entry.claimDigest` — and BOTH of those are fields of the document being
 * checked. Make the two copies agree and the check is defeated. A review
 * demonstrated it: a claim reading "PRODUCTION IS SAFE TO DEPLOY WITHOUT
 * REVIEW.", an assessment naming a claim that does not exist
 * (`oracle-claim-999`) and asserting a fabricated digest, and a report entry
 * asserting the same fabricated digest, rendered as
 * `- oracle-claim-1 [OBSERVED] SUPPORTED`. The validated claim record was in
 * scope four lines away and `claimRecordDigest` was never called.
 *
 * That is the same defect as the OUT-04 credit key, one layer deeper, and the
 * same defect the fixtures carried: a comment in the test helpers said a
 * computed digest "agrees with itself however wrong both are" — correct about
 * the test, and never applied to the production code doing exactly that.
 *
 * THE RULE THIS PACKAGE NOW FOLLOWS, after two reviews found the same class:
 *
 *   A cross-record rule must be anchored on something neither record can
 *   write. There are exactly three anchors available, and every binding below
 *   names which one it uses:
 *
 *     (a) RECOMPUTATION — derive the value from the referenced record's own
 *         bytes and compare. `resolveContextBinding` recomputes the manifest
 *         digest; this module recomputes `claimRecordDigest`.
 *     (b) A SECOND ARGUMENT the caller supplies from host state —
 *         `resolveCitations(citations, delivered)`,
 *         `mapProposalToJobShape(proposal, allowlist)`,
 *         `resolveOutcomeCredits(outcomes, authorizedWork)`.
 *     (c) THE ENVELOPE SPLIT — a host-attested half against a model-authored
 *         half, inside one record. `basis_report_mismatch` uses this.
 *
 * A comparison of two model-authored fields is none of those and establishes
 * nothing, however many fields it compares.
 *
 * WHAT THIS MODULE STILL CANNOT DO, stated rather than implied: it verifies
 * that an assessment is ABOUT the claim a report entry names. It cannot verify
 * that the assessment's `status` was earned, because a `ClaimAssessment` is not
 * an attested envelope — see the note on the authoring path in
 * `claim-assessment.ts`.
 */

/** Why a claim entry is not bound to an assessment. `BOUND` is the only arm that renders a status. */
export const CLAIM_BINDING_STATES = [
  "BOUND",
  "NO_STORED_ASSESSMENT",
  "CLAIM_NOT_SUPPLIED",
  "ASSESSMENT_NOT_SUPPLIED",
  "CLAIM_DIGEST_MISMATCH",
  "ASSESSMENT_BINDS_ANOTHER_CLAIM",
  "CLAIM_OUTSIDE_REPORT_SCOPE",
] as const;
export type ClaimBindingState = (typeof CLAIM_BINDING_STATES)[number];

export type BoundClaim = {
  readonly entry: ReportClaimEntry;
  readonly claim: ClaimRecord | undefined;
  /** Present ONLY when `state` is `BOUND`. Nothing downstream may read a status without it. */
  readonly assessment: ClaimAssessment | undefined;
  readonly state: ClaimBindingState;
  /** Human-readable reason, for a renderer to print. Empty when bound. */
  readonly detail: string;
  /** Source ids this claim cites that were never delivered to this run (SRC-03). */
  readonly unresolvedSourceIds: readonly string[];
};

export type ReportBundleResolution =
  | {
      readonly outcome: "RESOLVED";
      readonly report: ResearchReport;
      readonly claims: readonly BoundClaim[];
      readonly proposal: DecisionProposal | null;
      /**
       * Non-fatal findings: unbound claims, undelivered source ids, a proposal
       * that does not belong to this report. Reported rather than thrown,
       * because a report whose bindings do not all hold is exactly the document
       * a reader must still be able to see — with the gaps named.
       */
      readonly issues: readonly ValidationIssue[];
    }
  | { readonly outcome: "REFUSED"; readonly issues: readonly ValidationIssue[] };

/** The keys a bundle must carry. Omission is loud: absent is not the same as empty. */
const BUNDLE_KEYS = ["report", "claims", "assessments", "proposal", "delivered"] as const;

function refuse(path: string, code: string, message: string): ReportBundleResolution {
  return { outcome: "REFUSED", issues: [issue(path, code, message)] };
}

/**
 * Bind a report to its claims, assessments, proposal and delivered sources.
 *
 * Every record is validated first, and every binding is recomputed rather than
 * compared between two assertions.
 */
export function resolveReportBundle(input: unknown): ReportBundleResolution {
  const plain = toPlainRecord(input);
  if (!plain.ok) return { outcome: "REFUSED", issues: plain.issues };
  const snapshot = plain.value;

  for (const key of BUNDLE_KEYS) {
    if (!Object.hasOwn(snapshot, key)) {
      return refuse(
        `/${key}`,
        "required_field",
        `${key} is required; omitting it is not the same as supplying an empty one`,
      );
    }
  }
  const parsedReport = validateResearchReport(snapshot.report);
  if (!parsedReport.ok) return { outcome: "REFUSED", issues: parsedReport.issues };
  const report = parsedReport.value;

  for (const key of ["claims", "assessments", "delivered"] as const) {
    if (!Array.isArray(snapshot[key])) {
      return refuse(`/${key}`, "invalid_type", `${key} is an array`);
    }
  }

  const refusals: ValidationIssue[] = [];
  const claims = new Map<string, ClaimRecord>();
  const claimDigests = new Map<string, string>();
  (snapshot.claims as readonly unknown[]).forEach((raw, i) => {
    const parsed = validateClaimRecord(raw);
    if (!parsed.ok) {
      for (const entry of parsed.issues) {
        refusals.push(issue(`/claims/${i}${entry.path}`, entry.code, entry.message));
      }
      return;
    }
    claims.set(parsed.value.claimId, parsed.value);
    // (a) RECOMPUTATION. The anchor: the claim's OWN canonical bytes. Every
    // digest assertion below is compared against this and never against
    // another assertion.
    claimDigests.set(parsed.value.claimId, claimRecordDigest(parsed.value));
  });

  const assessments = new Map<string, ClaimAssessment>();
  (snapshot.assessments as readonly unknown[]).forEach((raw, i) => {
    const parsed = validateClaimAssessment(raw);
    if (!parsed.ok) {
      for (const entry of parsed.issues) {
        refusals.push(issue(`/assessments/${i}${entry.path}`, entry.code, entry.message));
      }
      return;
    }
    assessments.set(parsed.value.assessmentId, parsed.value);
  });

  const delivered = new Map<string, DeliveredSourceHandle>();
  (snapshot.delivered as readonly unknown[]).forEach((raw, i) => {
    const parsed = validateDeliveredSourceHandle(raw);
    if (!parsed.ok) {
      for (const entry of parsed.issues) {
        refusals.push(issue(`/delivered/${i}${entry.path}`, entry.code, entry.message));
      }
      return;
    }
    delivered.set(parsed.value.sourceId, parsed.value);
  });

  let proposal: DecisionProposal | null = null;
  if (snapshot.proposal !== null) {
    const parsed = validateDecisionProposal(snapshot.proposal);
    if (!parsed.ok) {
      for (const entry of parsed.issues) {
        refusals.push(issue(`/proposal${entry.path}`, entry.code, entry.message));
      }
    } else {
      proposal = parsed.value;
    }
  }
  if (refusals.length > 0) return { outcome: "REFUSED", issues: refusals };

  const issues: ValidationIssue[] = [];

  // (b) The delivered set, supplied by the caller from host state. SRC-03 held
  // on the citation envelope and on nothing the report actually prints ids
  // from, so a claim could cite a source that was never delivered and the
  // renderer would print the id.
  const resolveSpanIds = (ids: readonly string[], path: string): string[] => {
    const unresolved: string[] = [];
    ids.forEach((sourceId) => {
      const handle = delivered.get(sourceId);
      if (handle === undefined) {
        unresolved.push(sourceId);
        issues.push(
          issue(
            path,
            "undelivered_source_id",
            `SRC-03: ${sourceId} was never delivered to this run; a claim cannot cite a source it did not receive`,
          ),
        );
        return;
      }
      if (handle.runRef !== report.runRef || handle.workspaceRef !== report.workspaceRef) {
        unresolved.push(sourceId);
        issues.push(
          issue(
            path,
            "foreign_run_source",
            `${sourceId} was delivered to a different run or workspace than this report's`,
          ),
        );
      }
    });
    return unresolved;
  };

  const bound: BoundClaim[] = report.claims.map((entry, i) => {
    const at = `/report/claims/${i}`;
    const claim = claims.get(entry.claimRef);
    const unresolvedSourceIds =
      claim === undefined
        ? []
        : resolveSpanIds(
          claim.sourceSpans.map((span) => span.sourceId),
          `${at}/sourceSpans`,
        );

    const unbound = (state: ClaimBindingState, detail: string, code?: string): BoundClaim => {
      if (code !== undefined) issues.push(issue(at, code, detail));
      return { entry, claim, assessment: undefined, state, detail, unresolvedSourceIds };
    };

    if (claim === undefined) {
      return unbound("CLAIM_NOT_SUPPLIED", "the claim record was not supplied to this rendering");
    }
    const computed = claimDigests.get(entry.claimRef);
    if (computed !== entry.claimDigest) {
      // The report ASSERTS a digest for this claim and the claim's own bytes
      // say otherwise. Under the old comparison this was invisible whenever
      // the assessment asserted the same wrong value.
      return unbound(
        "CLAIM_DIGEST_MISMATCH",
        "the report's claim digest does not match the claim record's own bytes",
        "claim_digest_mismatch",
      );
    }
    if (
      claim.runRef !== report.runRef
      || claim.workspaceRef !== report.workspaceRef
      || claim.contextManifestDigest !== report.contextManifestDigest
    ) {
      return unbound(
        "CLAIM_OUTSIDE_REPORT_SCOPE",
        "the claim was made in a different run, workspace or context than this report",
        "claim_outside_report_scope",
      );
    }
    if (entry.assessmentRef === null) {
      return unbound("NO_STORED_ASSESSMENT", "no stored assessment");
    }
    const assessment = assessments.get(entry.assessmentRef);
    if (assessment === undefined) {
      return unbound(
        "ASSESSMENT_NOT_SUPPLIED",
        `assessment ${entry.assessmentRef} was not supplied to this rendering`,
      );
    }
    if (assessment.claimRef !== entry.claimRef || assessment.claimDigest !== computed) {
      // BOTH halves, against the RECOMPUTED digest. The old check compared the
      // assessment's assertion to the report's assertion and never asked the
      // claim; it also never compared claimRef at all, so an assessment of
      // `oracle-claim-999` bound to `oracle-claim-1`.
      return unbound(
        "ASSESSMENT_BINDS_ANOTHER_CLAIM",
        `assessment ${entry.assessmentRef} is about a different claim, or a different version of this one`,
        "assessment_binds_another_claim",
      );
    }
    if (assessment.status !== "NOT_ASSESSED") {
      const reviewed = "reviewedSpans" in assessment ? assessment.reviewedSpans : [];
      resolveSpanIds(
        reviewed.map((span) => span.sourceId),
        `${at}/reviewedSpans`,
      );
    }
    return { entry, claim, assessment, state: "BOUND", detail: "", unresolvedSourceIds };
  });

  // The report names a proposal; the proposal names a report. Neither is an
  // anchor for the other on its own, so BOTH directions are checked — a
  // one-directional check is satisfied by a proposal that names this report
  // while this report names a different proposal.
  if (proposal !== null) {
    if (report.proposalRef !== proposal.hostResolved.proposalId) {
      issues.push(
        issue(
          "/proposal/hostResolved/proposalId",
          "proposal_not_named_by_report",
          "this report names a different proposal; a proposal rendered beside a report it does not "
            + "belong to is a recommendation attributed to evidence that never produced it",
        ),
      );
    }
    if (proposal.hostResolved.reportRef !== report.reportId) {
      issues.push(
        issue(
          "/proposal/hostResolved/reportRef",
          "proposal_bound_to_another_report",
          "the proposal is bound to a different report",
        ),
      );
    }
  }

  return { outcome: "RESOLVED", report, claims: bound, proposal, issues };
}
