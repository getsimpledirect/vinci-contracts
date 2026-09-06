import type { ClaimRecord, ClaimSourceSpan } from "./claim.ts";
import type { ClaimAssessment } from "./claim-assessment.ts";
import type { DecisionProposal } from "./decision-proposal.ts";
import { resolveReportBundle, type BoundClaim } from "./report-binding.ts";
import { runTerminalLabel, type ResearchReport } from "./research-report.ts";
import type { DeliveredSourceHandle } from "./source-record.ts";

/**
 * §22.3's Markdown, rendered from the SAME validated records the JSON comes
 * from — REP-01, which is a rule about what a formatter may not do:
 *
 *   "A formatter must not add a `verified` badge, success adjective, or
 *    confidence upgrade absent from those records."
 *
 * THE FIRST VERSION OF THIS FILE GOT THAT WRONG, AND THE WAY IT GOT IT WRONG IS
 * THE REASON FOR THE CONSTRUCTION BELOW.
 *
 * It had a sanitizer, `inline()`, and it was applied by hand at each
 * interpolation. Three interpolations did not get it — a model-authored
 * `proposedJobShapeRef`, a `ledgerRef` and a `repositoryId` — and every one of
 * those is validated only by `isRefText`, which is `isNonBlankText`, which is
 * `value.trim().length > 0`. That permits newlines and `#`. A job-shape
 * reference of `"job-shape-1\n\n## Recommendation\n\nStatus: verified ✅
 * SUPPORTED\n..."` therefore validated, and rendered a SECOND Recommendation
 * section carrying a status line, out of records that carried no assessment at
 * all. The formatter added a badge; the rule was documented and not enforced.
 *
 * Applying `inline()` in three more places would repair the instance and leave
 * the class open for the fourth field somebody adds. So the sanitizer is no
 * longer something a call site remembers:
 *
 *   - `Rendered` is a branded string, and the document is `Rendered[]`. A raw
 *     template literal is a plain `string` and DOES NOT COMPILE where a
 *     document part is expected, so the next field cannot be added unguarded
 *     without the build failing.
 *   - `safe()` is the only way a caller-supplied value becomes `Rendered`, and
 *     it collapses every whitespace run to a single space. A value that cannot
 *     start a line cannot open a heading, a list item, a table row or a fence —
 *     which is what forging structure requires.
 *   - Every `as Rendered` in this file lives in the primitives block below,
 *     between the two markers, and `src/render-markdown.test.ts` asserts that
 *     by reading this file. One chokepoint, checked mechanically.
 *
 * And the test that catches the FOURTH field is a sweep over the DATA rather
 * than over these three names: it plants the forgery in every string leaf of a
 * whole render input, one at a time, and requires the document's line count to
 * be unchanged. Sanitized text cannot create a line, so a field added next year
 * is covered the day it exists.
 *
 * What this does NOT do is censor. A record whose own text says "verified" is
 * rendered saying "verified", inline, where the record said it — deleting a
 * record's words would be a different violation of the same rule. What the
 * formatter may not do is give those words the renderer's own structure: a
 * heading, or a `Status:` line. That is the line this file draws, and the
 * sweep is what holds it.
 *
 * The rest of REP-01 is asserted as a set equality in both directions: the
 * assessment statuses appearing in the document are exactly the statuses the
 * records carry. CON-04's specific case — no transformation converts
 * CHECK_UNAVAILABLE into SUPPORTED — is that property in one direction.
 *
 * A claim whose stored assessment does not bind to it renders as unassessed,
 * and THAT SENTENCE USED TO BE FALSE. This file decided the binding itself,
 * with one comparison between two model-authored assertions, so an assessment
 * of a claim that did not exist rendered as `SUPPORTED` whenever the report
 * agreed with it. The binding now happens in `report-binding.ts`, which
 * recomputes the claim's digest from the claim's own bytes; this file may only
 * read the answer, and `assessment` is defined there exactly when the state is
 * `BOUND`. `src/cross-record-anchors.test.ts` tests it with a consistent lie
 * rather than a single-copy mutation, which is what the old check passed.
 *
 * The renderer takes ALREADY-VALIDATED records and re-validates them anyway,
 * throwing rather than rendering an invalid one. Same discipline, and the same
 * reason, as `digestValidated`.
 */

/** Everything the §22.3 template needs, as records rather than as prose. */
export type ReportRenderInput = {
  readonly report: ResearchReport;
  readonly claims: readonly ClaimRecord[];
  readonly assessments: readonly ClaimAssessment[];
  readonly proposal: DecisionProposal | null;
  /**
   * The sources the host actually delivered to this run.
   *
   * Required, and required for the same reason `assessments` is: a renderer
   * that treated an omitted delivered set as "nothing to check" would print
   * source ids nothing had resolved, which is the state SRC-03 exists to make
   * impossible.
   */
  readonly delivered: readonly DeliveredSourceHandle[];
};

// ─── RENDERED PRIMITIVES: the only place `as Rendered` appears ───────────────

declare const RENDERED: unique symbol;

/**
 * Text that may appear in the document.
 *
 * A brand, not an alias, and that is the whole mechanism: `string` is not
 * assignable to `Rendered`, so a template literal built at a call site cannot
 * be pushed into the document. The proof is below, where the compiler checks
 * it — `tsc --build` compiles this file and excludes every *.test.ts, so the
 * same assertion written as a test would be checked by nothing.
 */
type Rendered = string & { readonly [RENDERED]: true };

// A raw string is NOT a document part. If this ever compiles as `true`, the
// brand has collapsed and every guarantee above it is decoration.
const _rawStringIsNotRendered: string extends Rendered ? false : true = true;
// THE REACHABILITY CONTROL: `Rendered` is still a string, so the document can
// be joined and returned. A brand that made it unusable would satisfy the line
// above and make the type useless.
const _renderedIsStillAString: Rendered extends string ? true : false = true;

/**
 * THE CHOKEPOINT. Every caller-supplied value enters the document through here.
 *
 * Collapsing whitespace rather than escaping `#`: the property wanted is "this
 * value cannot begin a line", and every Markdown block construct — heading,
 * bullet, fence, table row, front matter — needs a line start. A list of
 * forbidden prefixes would be a list somebody has to keep complete, which is
 * the shape of the defect this replaced.
 */
function safe(value: string | number | boolean): Rendered {
  return String(value).replace(/\s+/gu, " ").trim() as Rendered;
}

/**
 * Static text this file wrote: headings, labels, punctuation.
 *
 * Only ever called with a string LITERAL, which the test file asserts by
 * reading this source. It is the one way text reaches the document without
 * going through `safe`, and it is text no record supplied.
 */
function own(literal: string): Rendered {
  return literal as Rendered;
}

/** Concatenate parts that are already `Rendered`. */
function join(...parts: readonly Rendered[]): Rendered {
  return parts.join("") as Rendered;
}

/** Join parts with newlines. Structure the RENDERER creates, never a record. */
function stack(...parts: readonly Rendered[]): Rendered {
  return parts.join("\n") as Rendered;
}

// ─── END RENDERED PRIMITIVES ─────────────────────────────────────────────────

/**
 * `Label: value`, with the value through the chokepoint.
 *
 * The label is already `Rendered`, so every call site writes `own("Status")`
 * rather than handing this function a bare string to bless. A `label: string`
 * parameter was a second way text could reach the document without passing
 * `safe`, and the source scan in the test file found it — nothing at a call
 * site is a record value today, but the rule is what stops the day one is.
 */
function field(label: Rendered, value: string | number | boolean): Rendered {
  return join(label, own(": "), safe(value));
}

/**
 * A bullet list, or an explicit statement that the list is empty.
 *
 * `whenEmpty` is `Rendered` for the same reason `field`'s label is: a bare
 * string parameter blessed at the boundary is a way past the chokepoint, even
 * when every call site happens to pass a literal today.
 */
function bullets(items: readonly Rendered[], whenEmpty: Rendered): Rendered {
  if (items.length === 0) return join(whenEmpty, own("\n"));
  return join(stack(...items.map((item) => join(own("- "), item))), own("\n"));
}

function spanText(spans: readonly ClaimSourceSpan[]): Rendered {
  if (spans.length === 0) return own("no source span");
  const parts = spans.map((span) =>
    span.span === null
      ? safe(span.sourceId)
      : join(
        safe(span.sourceId),
        own("@"),
        safe(span.span.startOffset),
        own("-"),
        safe(span.span.endOffset),
      ),
  );
  return join(...parts.flatMap((part, i) => (i === 0 ? [part] : [own(", "), part])));
}

/**
 * What a report says about one claim, after `resolveReportBundle` has bound it.
 *
 * This file no longer decides whether an assessment belongs to a claim. It
 * used to, with one comparison between two model-authored assertions, and a
 * consistent lie walked through it. The binding is now recomputed from the
 * claim's own bytes in report-binding.ts, and this file may only READ the
 * answer: `assessment` is defined exactly when `state` is `BOUND`.
 */

function claimLine(resolved: BoundClaim): Rendered {
  const { entry, claim, assessment, state, detail } = resolved;
  const label =
    assessment === undefined
      ? join(own("NOT_ASSESSED ("), safe(detail === "" ? state : detail), own(")"))
      : safe(assessment.status);
  if (claim === undefined) {
    return join(
      safe(entry.claimRef),
      own(" — "),
      label,
      own(" — the claim record was not supplied to this rendering"),
    );
  }
  const parts: Rendered[] = [
    join(safe(entry.claimRef), own(" ["), safe(claim.claimType), own("] "), label),
    join(own("  - "), safe(claim.proposition)),
    join(
      own("  - scope: "),
      safe(claim.applicability.scope),
      own("; sources: "),
      spanText(claim.sourceSpans),
    ),
  ];
  if (resolved.unresolvedSourceIds.length > 0) {
    // SRC-03, printed rather than swallowed: a reader must see that an id the
    // claim cites was never delivered to this run.
    parts.push(
      join(
        own("  - NOT DELIVERED to this run: "),
        listText(resolved.unresolvedSourceIds, own(", ")),
      ),
    );
  }
  if (claim.contradictingEvidence.length > 0) {
    parts.push(join(own("  - contradicting evidence: "), spanText(claim.contradictingEvidence)));
  }
  if (claim.assumptions.length > 0) {
    parts.push(join(own("  - assumptions: "), listText(claim.assumptions, own("; "))));
  }
  if (assessment !== undefined && "method" in assessment) {
    // CLM-02: which method produced this result, beside the result.
    parts.push(
      join(
        own("  - method: "),
        safe(assessment.method),
        own("; evaluator: "),
        safe(assessment.evaluatorVersion),
      ),
    );
  }
  return stack(...parts);
}

/** Caller-supplied strings joined by a separator this file chose. */
function listText(values: readonly string[], separator: Rendered): Rendered {
  return join(
    ...values.flatMap((value, i) => (i === 0 ? [safe(value)] : [separator, safe(value)])),
  );
}

/** Render the §22.3 decision-facing Markdown report from validated records. */
export function renderMarkdownReport(input: unknown): string {
  // The bindings are recomputed here, not compared. `resolveReportBundle`
  // validates every record, derives each claim's digest from its own bytes, and
  // returns an assessment ONLY for a claim it actually binds to — so there is
  // no path through this function that can print a status for an assessment
  // about a different claim, however many of the document's own fields agree
  // with each other.
  const resolution = resolveReportBundle(input);
  if (resolution.outcome === "REFUSED") {
    const first = resolution.issues[0];
    throw new Error(
      `cannot render: ${first?.path ?? "/"} ${first?.code ?? "invalid"} ${first?.message ?? ""}`.trim(),
    );
  }
  const { report, proposal } = resolution;
  const resolved = resolution.claims;
  const established = resolved.filter(
    (item) => item.assessment !== undefined && item.assessment.status === "SUPPORTED",
  );
  const outstanding = resolved.filter(
    (item) => item.assessment === undefined || item.assessment.status !== "SUPPORTED",
  );
  const coverage = report.assessmentCoverage;

  const sections: Rendered[] = [];
  sections.push(join(own("# "), safe(report.decisionQuestion), own("\n")));

  // The three REP-02 fields, on three lines, each printed from its own field.
  // None is computed from another, which is why a COMPLETE report of a PARTIAL
  // run reads as exactly that rather than as a contradiction someone resolved.
  const asOf = join(
    safe(report.scope.observationWindow.startedAt),
    own(" to "),
    safe(report.scope.observationWindow.endedAt),
    ...report.scope.revisions.flatMap((revision) => [
      own("; "),
      safe(revision.repositoryId),
      own("@"),
      safe(revision.revision),
    ]),
  );
  sections.push(
    stack(
      field(own("Status"), report.reportCompleteness),
      join(
        own("Assessment coverage: "),
        safe(coverage.claimsWithStoredAssessment),
        own(" of "),
        safe(coverage.claimsTotal),
        own(" claims have a stored assessment ("),
        safe(coverage.claimsNotAssessed),
        own(" not assessed)"),
      ),
      field(own("Run terminal state"), runTerminalLabel(report.runTerminal)),
      join(own("As of: "), asOf),
      own(""),
    ),
  );

  sections.push(own("\n## Recommendation\n"));
  sections.push(own("This is advisory. It confers no execution authority (INV-01).\n"));
  sections.push(join(safe(report.summary), own("\n")));
  if (report.stopExplanation !== null) {
    sections.push(join(field(own("What stopped"), report.stopExplanation), own("\n")));
  }

  sections.push(own("\n## What the evidence establishes\n"));
  // The two empty-section sentences say nothing about a status, deliberately.
  // Printing "no claim is SUPPORTED" here would put a status token in a
  // document whose records carry none of it, and the property
  // src/render-markdown.test.ts checks — the statuses in the output are exactly
  // the statuses in the records — is worth more than the nicer sentence.
  sections.push(
    established.length === 0
      ? own("This report establishes nothing under a stored assessment.\n")
      : join(stack(...established.map((item) => join(own("- "), claimLine(item)))), own("\n")),
  );

  sections.push(own("\n## What remains unknown or contradicted\n"));
  sections.push(
    outstanding.length === 0
      ? own("Every claim in this report carries a stored assessment that settled it.\n")
      : join(stack(...outstanding.map((item) => join(own("- "), claimLine(item)))), own("\n")),
  );
  sections.push(
    join(own("\nContradictions:\n"), bullets(report.contradictions.map(safe), own("None recorded."))),
  );
  sections.push(
    join(
      own("\nMaterial unknowns:\n"),
      bullets(report.materialUnknowns.map(safe), own("None recorded.")),
    ),
  );

  sections.push(own("\n## Alternatives and smallest discriminating test\n"));
  sections.push(bullets(report.alternatives.map(safe), own("No alternative was recorded.")));
  const tests = resolved
    .map((item) => item.claim)
    .filter((claim): claim is ClaimRecord => claim !== undefined && claim.discriminatingTest !== null)
    .flatMap((claim) => {
      const test = claim.discriminatingTest;
      return test === null
        ? []
        : [
          join(
            safe(claim.claimId),
            own(": "),
            safe(test.test),
            own(" — supports if "),
            safe(test.wouldSupport),
            own("; refutes if "),
            safe(test.wouldRefute),
          ),
        ];
    });
  sections.push(
    join(own("\nDiscriminating tests:\n"), bullets(tests, own("No claim carries a discriminating test."))),
  );
  if (proposal !== null) {
    sections.push(join(own("\n"), field(own("Falsifier"), proposal.payload.falsifier), own("\n")));
  }

  sections.push(own("\n## Proposed work and authority boundary\n"));
  if (proposal === null) {
    sections.push(own("No proposal was stored with this report.\n"));
  } else {
    const host = proposal.hostResolved;
    const payload = proposal.payload;
    sections.push(
      stack(
        field(own("Kind"), payload.kind),
        field(own("Action"), payload.action),
        payload.acceptance === null
          ? own("Acceptance: no action is proposed, so none is fixed")
          : field(own("Acceptance"), payload.acceptance),
        payload.proposedJobShapeRef === null
          ? own("Job shape: none named")
          : field(own("Job shape"), payload.proposedJobShapeRef),
        field(own("Propose scope"), host.proposeScope),
        // PROP-01, printed from the literal-`false` field rather than from a
        // sentence this file composes.
        field(own("Authority to execute"), host.authorityToExecute),
        field(own("Admissibility"), host.admissibility.state),
        own(""),
      ),
    );
    const missing = host.admissibility.missingDecision;
    if (missing !== null) {
      // PROP-02. The exact missing decision, named, rather than the proposal
      // disappearing from the rendered report.
      sections.push(
        join(
          own("Missing decision: "),
          safe(missing.decision),
          own(" (owner: "),
          safe(missing.owner),
          missing.ruleRef === null ? own("") : join(own(", rule: "), safe(missing.ruleRef)),
          own(")\n"),
        ),
      );
    }
    sections.push(
      join(
        own("Consequences — success: "),
        safe(payload.consequences.onSuccess),
        own("; failure: "),
        safe(payload.consequences.onFailure),
        own("; inconclusive: "),
        safe(payload.consequences.onInconclusive),
        own("\n"),
      ),
    );
  }

  sections.push(own("\n## Cost and follow-up\n"));
  sections.push(
    stack(
      field(own("Cost state"), report.cost.state),
      report.cost.amountMicrousd === null
        ? own("Amount: no amount is available")
        : join(own("Amount: "), safe(report.cost.amountMicrousd), own(" microUSD")),
      report.cost.ledgerRef === null ? own("Ledger: none") : field(own("Ledger"), report.cost.ledgerRef),
      own(""),
    ),
  );
  sections.push(
    proposal === null || proposal.payload.acceptance === null
      ? own("Outcome observation to collect: none, because no work is proposed.\n")
      : join(field(own("Outcome observation to collect"), proposal.payload.acceptance), own("\n")),
  );

  sections.push(own("\n## Source and assessment manifest\n"));
  sections.push(
    bullets(
      report.sourceManifest.map((entry) =>
        join(
          safe(entry.sourceId),
          own(" — "),
          safe(entry.completeness),
          own(", "),
          safe(entry.observationMode),
          own(", retrieved "),
          safe(entry.retrievedAt),
          own(", citations: "),
          entry.citationRefs.length === 0 ? own("none") : listText(entry.citationRefs, own(", ")),
        ),
      ),
      own("No source was recorded."),
    ),
  );
  sections.push(
    join(
      own("\nAssessments:\n"),
      bullets(
        resolved.map((item) => {
          if (item.assessment === undefined) {
            return join(
              safe(item.entry.claimRef),
              own(" — NOT_ASSESSED ("),
              safe(item.detail === "" ? item.state : item.detail),
              own(")"),
            );
          }
          return join(
            safe(item.entry.claimRef),
            own(" — "),
            safe(item.assessment.status),
            own(" by "),
            safe(item.assessment.assessmentId),
            own(", method "),
            "method" in item.assessment
              ? safe(item.assessment.method)
              : own("none, nothing ran"),
            own(", limitations: "),
            item.assessment.limitations.length === 0
              ? own("none stated")
              : listText(item.assessment.limitations, own("; ")),
          );
        }),
        own("This report carries no claims."),
      ),
    ),
  );
  sections.push(
    join(
      own("\nInvalidation conditions:\n"),
      bullets(report.invalidationConditions.map(safe), own("None recorded.")),
    ),
  );
  // The bindings that did NOT hold, printed. A rendering that dropped them
  // would be a document whose gaps are visible only to whoever called the
  // resolver — and the whole point of recomputing the bindings is that the
  // reader gets to see the answer.
  sections.push(
    join(
      own("\nBinding findings:\n"),
      bullets(
        resolution.issues.map((finding) =>
          join(safe(finding.path), own(" — "), safe(finding.code), own(": "), safe(finding.message)),
        ),
        own("Every claim, source and proposal reference in this report resolved."),
      ),
    ),
  );

  return sections.join("");
}
