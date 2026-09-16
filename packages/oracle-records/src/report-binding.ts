import { toPlainRecord, type ValidationIssue } from "@getsimpledirect/vinci-contracts";
import { claimRecordDigest, validateClaimRecord, type ClaimRecord } from "./claim.ts";
import { validateClaimAssessment, type ClaimAssessment } from "./claim-assessment.ts";
import { validateDecisionProposal, type DecisionProposal } from "./decision-proposal.ts";
import { isObjectRecord, issue } from "./lib/validate.ts";
import {
  researchReportDigest,
  validateResearchReport,
  type ReportClaimEntry,
  type ResearchReport,
} from "./research-report.ts";
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
 *
 * `evidenceIsMissing` exists because of a rendering question a review put
 * directly: a BOUND, SUPPORTED claim whose every cited source was never
 * delivered used to render under "What the evidence establishes", with the
 * NOT DELIVERED note beneath it. Both facts were on the page and a skimming
 * reader resolves that pair in the flattering direction — which is the reading
 * REP-01 exists to prevent, arriving through layout rather than through a word.
 * A claim with no resolvable evidence is not evidence, whatever its stored
 * status says, so the renderer now leads with the gap. The STATUS is not
 * changed and not hidden: CON-04 forbids transforming one status into another,
 * and this transforms none — it decides which section the claim is read in.
 */

/** Why a claim entry is not bound to an assessment. `BOUND` is the only arm that renders a status. */
export const CLAIM_BINDING_STATES = [
  "BOUND",
  "NO_STORED_ASSESSMENT",
  "CLAIM_NOT_SUPPLIED",
  "ASSESSMENT_NOT_SUPPLIED",
  "CLAIM_DIGEST_MISMATCH",
  "ASSESSMENT_BINDS_ANOTHER_CLAIM",
  "ASSESSMENT_BINDS_ANOTHER_REPORT",
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
  /**
   * Source ids this claim's evidence cites that were never delivered to this
   * run (SRC-03) — from the claim's own spans AND from the bound assessment's
   * reviewed spans.
   *
   * The reviewed spans used to raise an issue and never reach this list, so a
   * renderer marked an unresolved CLAIM span inline and printed an unresolved
   * REVIEWED span as fact. The reviewed spans are the ones an assessment says
   * it actually read, which makes them the worse half to leave unmarked.
   */
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

/**
 * Does this claim rest on evidence that resolved?
 *
 * True when the claim cites nothing at all, or when every id it cites was
 * undelivered. A renderer uses it to decide where a claim is READ, never what
 * its status SAYS.
 */
export function evidenceIsMissing(bound: unknown): boolean {
  // NOT through `toPlainRecord`, and the reason is worth stating: a legitimate
  // `BoundClaim` carries `assessment: undefined` when no assessment is stored,
  // and `toPlainRecord` REFUSES a value JSON cannot carry. Routing through it
  // made every unbound claim read as "evidence missing" — correct by accident
  // for the renderer, which never asks about those, and wrong as an answer.
  //
  // So: every field is read ONCE into a local, every read is shape-checked, and
  // the whole body is wrapped against a throwing accessor. The first version
  // stopped at the top level and threw on six inner shapes — `claim: null`,
  // `sourceSpans: [null]`, `assessment: "str"`, `reviewedSpans: null` — out of
  // a function whose own contract says a guard must refuse rather than throw.
  // And a wrong-typed `unresolvedSourceIds` coerced to an empty set, which
  // reads as "nothing is unresolved": a value guard failing OPEN on a wrong
  // type, in the direction that puts a claim under "what the evidence
  // establishes". Every shape this cannot read now answers `true`: missing.
  try {
    if (!isObjectRecord(bound)) return true;

    const claim = bound.claim;
    if (!isObjectRecord(claim) || !Array.isArray(claim.sourceSpans)) return true;
    const cited = new Set<string>();
    for (const span of claim.sourceSpans) {
      if (!isObjectRecord(span) || typeof span.sourceId !== "string") return true;
      cited.add(span.sourceId);
    }

    const assessment = bound.assessment;
    if (assessment !== undefined && assessment !== null) {
      if (!isObjectRecord(assessment)) return true;
      if (Object.hasOwn(assessment, "reviewedSpans")) {
        const reviewed = assessment.reviewedSpans;
        if (!Array.isArray(reviewed)) return true;
        for (const span of reviewed) {
          if (!isObjectRecord(span) || typeof span.sourceId !== "string") return true;
          cited.add(span.sourceId);
        }
      }
    }

    if (cited.size === 0) return true;

    const declared = bound.unresolvedSourceIds;
    if (!Array.isArray(declared)) return true;
    const unresolved = new Set<string>();
    for (const id of declared) {
      if (typeof id !== "string") return true;
      unresolved.add(id);
    }
    return [...cited].every((id) => unresolved.has(id));
  } catch {
    // A throwing accessor is data this cannot read, and unreadable is missing.
    return true;
  }
}

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

  // (a) RECOMPUTATION, for the OTHER digest an assessment asserts.
  //
  // `reportDigest` shipped as shape-checked and nothing else, in a module whose
  // whole subject is recomputing the digest beside it. A third review found it
  // one field over from the defect the second review found, with the anchor —
  // this report, and the exported `researchReportDigest` — already in scope. It
  // was not a table row and it was not a declared limit, which is the part
  // worth keeping in mind: the sweep missed a row, so the sweep's table is now
  // checked against the fields records actually carry (see
  // `cross-record-anchors.test.ts`).
  const reportDigest = researchReportDigest(report);

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
    if (
      assessment.reportDigest !== null
      && assessment.reportDigest !== reportDigest
    ) {
      // Null is the honest "this assessment stands alone"; a NON-NULL value is
      // a claim about which report it was issued against, and a claim about
      // another record is exactly what has to be recomputed rather than read.
      return unbound(
        "ASSESSMENT_BINDS_ANOTHER_REPORT",
        `assessment ${entry.assessmentRef} was issued against a different report`,
        "assessment_binds_another_report",
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
    const reviewed = "reviewedSpans" in assessment ? assessment.reviewedSpans : [];
    const unresolvedReviewed = resolveSpanIds(
      reviewed.map((span) => span.sourceId),
      `${at}/reviewedSpans`,
    );
    return {
      entry,
      claim,
      assessment,
      state: "BOUND",
      detail: "",
      unresolvedSourceIds: [...new Set([...unresolvedSourceIds, ...unresolvedReviewed])],
    };
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
