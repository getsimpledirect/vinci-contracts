import { toPlainRecord, type ValidationResult } from "@getsimpledirect/vinci-contracts";
import { validateClaimRecord, type ClaimRecord, type ClaimSourceSpan } from "./claim.ts";
import {
  validateClaimAssessment,
  type AssessmentStatus,
  type ClaimAssessment,
} from "./claim-assessment.ts";
import { validateDecisionProposal, type DecisionProposal } from "./decision-proposal.ts";
import {
  validateResearchReport,
  type ReportClaimEntry,
  type ResearchReport,
} from "./research-report.ts";

/**
 * §22.3's Markdown, rendered from the SAME validated records the JSON comes
 * from — REP-01, which is a rule about what a formatter may not do:
 *
 *   "A formatter must not add a `verified` badge, success adjective, or
 *    confidence upgrade absent from those records."
 *
 * The mechanism here is that there is nowhere for one to come from. Every
 * status this file prints is a status token copied out of a record; there is no
 * table mapping a status to a friendlier word, no summary line computed from a
 * count, and no branch that prints something different when everything happens
 * to be fine. `src/render-markdown.test.ts` asserts the whole property rather
 * than an example: the set of assessment statuses appearing in the output is
 * exactly the set the records carry, checked in BOTH directions, so a rendering
 * that invented SUPPORTED and one that swallowed CHECK_UNAVAILABLE both fail.
 *
 * CON-04's specific case — no transformation converts CHECK_UNAVAILABLE into
 * SUPPORTED — is that property in one direction, and it is also why a claim
 * whose stored assessment does not bind to it renders as unassessed rather than
 * as whatever the unbound assessment said.
 *
 * The renderer takes ALREADY-VALIDATED records and re-validates them anyway,
 * throwing rather than rendering an invalid one. Same discipline, and the same
 * reason, as `digestValidated`: a document rendered from a record nothing
 * checked is a document that says whatever the record said.
 */

/** Everything the §22.3 template needs, as records rather than as prose. */
export type ReportRenderInput = {
  readonly report: ResearchReport;
  readonly claims: readonly ClaimRecord[];
  readonly assessments: readonly ClaimAssessment[];
  readonly proposal: DecisionProposal | null;
};

function parsed<T>(label: string, result: ValidationResult<T>): T {
  if (!result.ok) {
    const first = result.issues[0];
    throw new Error(
      `cannot render an invalid ${label}: ${first?.path ?? "/"} ${first?.code ?? "invalid"}`,
    );
  }
  return result.value;
}

/**
 * Model-authored prose, made safe to put in a Markdown document.
 *
 * Newlines become spaces. Not cosmetic: a heading in this format is a line
 * beginning with `#`, so a proposition containing a newline and `## Recommendation`
 * would forge a section of the report — the formatter adding something absent
 * from the records, arriving from the one direction REP-01's wording does not
 * obviously cover. Collapsing runs of whitespace removes the ability to start a
 * line at all, which is a property of the transformation rather than a list of
 * forbidden strings.
 */
function inline(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** A bullet list, or an explicit statement that the list is empty. */
function bullets(items: readonly string[], whenEmpty: string): string {
  if (items.length === 0) return `${whenEmpty}\n`;
  return `${items.map((item) => `- ${inline(item)}`).join("\n")}\n`;
}

function spanText(spans: readonly ClaimSourceSpan[]): string {
  if (spans.length === 0) return "no source span";
  return spans
    .map((span) =>
      span.span === null
        ? span.sourceId
        : `${span.sourceId}@${span.span.startOffset}-${span.span.endOffset}`,
    )
    .join(", ");
}

/**
 * What a report says about one claim, after the bindings are checked.
 *
 * `status` is null exactly when no assessment stands for this claim — no
 * reference, no record supplied, or a record that does not bind to this version
 * of the claim. All three render as unassessed and none of them renders as the
 * status of an assessment that was not about this claim.
 */
type ResolvedClaim = {
  readonly entry: ReportClaimEntry;
  readonly claim: ClaimRecord | undefined;
  readonly assessment: ClaimAssessment | undefined;
  readonly status: AssessmentStatus | null;
  readonly note: string;
};

function resolveClaim(
  entry: ReportClaimEntry,
  claims: ReadonlyMap<string, ClaimRecord>,
  assessments: ReadonlyMap<string, ClaimAssessment>,
): ResolvedClaim {
  const claim = claims.get(entry.claimRef);
  if (entry.assessmentRef === null) {
    return { entry, claim, assessment: undefined, status: null, note: "no stored assessment" };
  }
  const assessment = assessments.get(entry.assessmentRef);
  if (assessment === undefined) {
    return {
      entry,
      claim,
      assessment: undefined,
      status: null,
      note: `assessment ${entry.assessmentRef} was not supplied to this rendering`,
    };
  }
  if (assessment.claimDigest !== entry.claimDigest) {
    // T12's stale-binding case, reached through the renderer. The assessment is
    // a real, valid assessment — of a different version of this claim — and
    // printing its status here would be the confidence upgrade REP-01 forbids,
    // arriving from a record that never made the claim.
    return {
      entry,
      claim,
      assessment: undefined,
      status: null,
      note: `assessment ${entry.assessmentRef} does not bind to this version of the claim`,
    };
  }
  return { entry, claim, assessment, status: assessment.status, note: "" };
}

function claimLine(resolved: ResolvedClaim): string {
  const { entry, claim, status, note } = resolved;
  const label = status === null ? `NOT_ASSESSED (${note})` : status;
  if (claim === undefined) {
    return `- ${entry.claimRef} — ${label} — the claim record was not supplied to this rendering`;
  }
  const parts = [
    `- ${entry.claimRef} [${claim.claimType}] ${label}`,
    `  - ${inline(claim.proposition)}`,
    `  - scope: ${inline(claim.applicability.scope)}; sources: ${spanText(claim.sourceSpans)}`,
  ];
  if (claim.contradictingEvidence.length > 0) {
    parts.push(`  - contradicting evidence: ${spanText(claim.contradictingEvidence)}`);
  }
  if (claim.assumptions.length > 0) {
    parts.push(`  - assumptions: ${claim.assumptions.map(inline).join("; ")}`);
  }
  if (resolved.assessment !== undefined && "method" in resolved.assessment) {
    // CLM-02: which method produced this result, beside the result.
    parts.push(`  - method: ${resolved.assessment.method}; evaluator: ${inline(resolved.assessment.evaluatorVersion)}`);
  }
  return parts.join("\n");
}

/** Render the §22.3 decision-facing Markdown report from validated records. */
export function renderMarkdownReport(input: unknown): string {
  const plain = toPlainRecord(input);
  if (!plain.ok) {
    const first = plain.issues[0];
    throw new Error(`cannot render: ${first?.path ?? "/"} ${first?.code ?? "invalid"}`);
  }
  const snapshot = plain.value;
  // Every key REQUIRED, and each of the three lists required to be a list.
  //
  // The lenient reading — treat a missing `assessments` as an empty one — is
  // the defect this package is about, one level out: a caller that forgot to
  // pass the assessments would get a document rendering every claim as
  // unassessed, which is a true-looking statement about the records and a false
  // one about the world. An omission has to be loud.
  for (const field of ["report", "claims", "assessments", "proposal"] as const) {
    if (!Object.hasOwn(snapshot, field)) {
      throw new Error(`cannot render: ${field} is required; omitting it is not the same as empty`);
    }
  }
  const report = parsed("research report", validateResearchReport(snapshot.report));
  if (!Array.isArray(snapshot.claims) || !Array.isArray(snapshot.assessments)) {
    throw new Error("cannot render: claims and assessments are arrays");
  }
  const claimList = snapshot.claims;
  const assessmentList = snapshot.assessments;
  const claims = new Map<string, ClaimRecord>();
  for (const raw of claimList) {
    const claim = parsed("claim record", validateClaimRecord(raw));
    claims.set(claim.claimId, claim);
  }
  const assessments = new Map<string, ClaimAssessment>();
  for (const raw of assessmentList) {
    const assessment = parsed("claim assessment", validateClaimAssessment(raw));
    assessments.set(assessment.assessmentId, assessment);
  }
  const proposal =
    snapshot.proposal === null
      ? null
      : parsed("decision proposal", validateDecisionProposal(snapshot.proposal));

  const resolved = report.claims.map((entry) => resolveClaim(entry, claims, assessments));
  const established = resolved.filter((item) => item.status === "SUPPORTED");
  const outstanding = resolved.filter((item) => item.status !== "SUPPORTED");

  const coverage = report.assessmentCoverage;
  const asOf = [
    `${report.scope.observationWindow.startedAt} to ${report.scope.observationWindow.endedAt}`,
    ...report.scope.revisions.map((revision) => `${revision.repositoryId}@${revision.revision}`),
  ].join("; ");

  const sections: string[] = [];
  sections.push(`# ${inline(report.decisionQuestion)}\n`);
  // The three REP-02 fields, on three lines, each printed from its own field.
  // None is computed from another, which is why a COMPLETE report of a PARTIAL
  // run reads as exactly that rather than as a contradiction someone resolved.
  sections.push(
    [
      `Status: ${report.reportCompleteness}`,
      `Assessment coverage: ${coverage.claimsWithStoredAssessment} of ${coverage.claimsTotal} `
        + `claims have a stored assessment (${coverage.claimsNotAssessed} not assessed)`,
      `Run terminal state: ${report.runTerminalState}`,
      `As of: ${asOf}`,
      "",
    ].join("\n"),
  );

  sections.push("\n## Recommendation\n");
  sections.push("This is advisory. It confers no execution authority (INV-01).\n");
  sections.push(`${inline(report.summary)}\n`);
  if (report.stopExplanation !== null) {
    sections.push(`What stopped: ${inline(report.stopExplanation)}\n`);
  }

  sections.push("\n## What the evidence establishes\n");
  // The two empty-section sentences say nothing about a status, deliberately.
  // Printing "no claim is SUPPORTED" here would put a status token in a
  // document whose records carry none of it, and the property
  // src/render-markdown.test.ts checks — the statuses in the output are exactly
  // the statuses in the records — is worth more than the nicer sentence.
  sections.push(
    established.length === 0
      ? "This report establishes nothing under a stored assessment.\n"
      : `${established.map(claimLine).join("\n")}\n`,
  );

  sections.push("\n## What remains unknown or contradicted\n");
  sections.push(
    outstanding.length === 0
      ? "Every claim in this report carries a stored assessment that settled it.\n"
      : `${outstanding.map(claimLine).join("\n")}\n`,
  );
  sections.push(`\nContradictions:\n${bullets([...report.contradictions], "None recorded.")}`);
  sections.push(`\nMaterial unknowns:\n${bullets([...report.materialUnknowns], "None recorded.")}`);

  sections.push("\n## Alternatives and smallest discriminating test\n");
  sections.push(bullets([...report.alternatives], "No alternative was recorded."));
  const tests = resolved
    .map((item) => item.claim)
    .filter((claim): claim is ClaimRecord => claim !== undefined && claim.discriminatingTest !== null)
    .map((claim) => {
      const test = claim.discriminatingTest;
      return test === null
        ? ""
        : `${claim.claimId}: ${inline(test.test)} — supports if ${inline(test.wouldSupport)}; `
          + `refutes if ${inline(test.wouldRefute)}`;
    });
  sections.push(`\nDiscriminating tests:\n${bullets(tests, "No claim carries a discriminating test.")}`);
  if (proposal !== null) {
    sections.push(`\nFalsifier: ${inline(proposal.payload.falsifier)}\n`);
  }

  sections.push("\n## Proposed work and authority boundary\n");
  if (proposal === null) {
    sections.push("No proposal was stored with this report.\n");
  } else {
    const host = proposal.hostResolved;
    const payload = proposal.payload;
    sections.push(
      [
        `Kind: ${payload.kind}`,
        `Action: ${inline(payload.action)}`,
        `Acceptance: ${payload.acceptance === null ? "no action is proposed, so none is fixed" : inline(payload.acceptance)}`,
        `Job shape: ${payload.proposedJobShapeRef ?? "none named"}`,
        `Propose scope: ${host.proposeScope}`,
        // PROP-01, printed from the literal-`false` field rather than from a
        // sentence this file composes.
        `Authority to execute: ${String(host.authorityToExecute)}`,
        `Admissibility: ${host.admissibility.state}`,
        "",
      ].join("\n"),
    );
    const missing = host.admissibility.missingDecision;
    if (missing !== null) {
      // PROP-02. The exact missing decision, named, rather than the proposal
      // disappearing from the rendered report.
      sections.push(
        `Missing decision: ${inline(missing.decision)} (owner: ${inline(missing.owner)}${
          missing.ruleRef === null ? "" : `, rule: ${inline(missing.ruleRef)}`
        })\n`,
      );
    }
    sections.push(
      `Consequences — success: ${inline(payload.consequences.onSuccess)}; `
        + `failure: ${inline(payload.consequences.onFailure)}; `
        + `inconclusive: ${inline(payload.consequences.onInconclusive)}\n`,
    );
  }

  sections.push("\n## Cost and follow-up\n");
  const amount =
    report.cost.amountMicrousd === null
      ? "no amount is available"
      : `${report.cost.amountMicrousd} microUSD`;
  sections.push(
    [
      `Cost state: ${report.cost.state}`,
      `Amount: ${amount}`,
      `Ledger: ${report.cost.ledgerRef ?? "none"}`,
      "",
    ].join("\n"),
  );
  sections.push(
    proposal === null || proposal.payload.acceptance === null
      ? "Outcome observation to collect: none, because no work is proposed.\n"
      : `Outcome observation to collect: ${inline(proposal.payload.acceptance)}\n`,
  );

  sections.push("\n## Source and assessment manifest\n");
  sections.push(
    bullets(
      report.sourceManifest.map(
        (entry) =>
          `${entry.sourceId} — ${entry.completeness}, ${entry.observationMode}, retrieved `
          + `${entry.retrievedAt}, citations: ${entry.citationRefs.length === 0 ? "none" : entry.citationRefs.join(", ")}`,
      ),
      "No source was recorded.",
    ),
  );
  sections.push(
    `\nAssessments:\n${bullets(
      resolved.map((item) => {
        if (item.assessment === undefined) {
          return `${item.entry.claimRef} — NOT_ASSESSED (${item.note})`;
        }
        const limits =
          item.assessment.limitations.length === 0
            ? "none stated"
            : item.assessment.limitations.map(inline).join("; ");
        return `${item.entry.claimRef} — ${item.assessment.status} by ${item.assessment.assessmentId}, `
          + `method ${"method" in item.assessment ? item.assessment.method : "none, nothing ran"}, `
          + `limitations: ${limits}`;
      }),
      "This report carries no claims.",
    )}`,
  );
  sections.push(
    `\nInvalidation conditions:\n${bullets([...report.invalidationConditions], "None recorded.")}`,
  );

  return sections.join("");
}
