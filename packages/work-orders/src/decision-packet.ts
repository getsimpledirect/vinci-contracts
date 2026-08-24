import {
  fail,
  isCanonicalTimestamp,
  isIdentifier,
  isNonBlankText,
  ok,
  safeLabel,
  toPlainRecord,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";

/**
 * Everything a human needs to make one decision, carried rather than referenced.
 *
 * The reason this is a record and not a notification with a link: attention
 * spent reconstructing context is attention the decision did not get. A message
 * saying "run 47 needs your approval, see dashboard" charges a person the full
 * cost of an interruption and then makes them go assemble the facts themselves.
 * By the time they have, they have paid twice and are deciding while annoyed.
 *
 * So a packet must carry the question, the options, what each option causes,
 * and the evidence the choice rests on. If it cannot be assembled, the system
 * does not understand the decision well enough to be asking for it — which is
 * itself the useful signal, and is why validation here is strict rather than
 * lenient.
 */
export type DecisionPacket = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workOrderId: string;
  /** What is being asked, in one sentence a person can answer. */
  readonly question: string;
  /** What the asker will do if nobody answers. Never silence. */
  readonly defaultIfUnanswered: string;
  readonly options: readonly DecisionOption[];
  /** Evidence ids the choice rests on. Empty means the asker has no basis. */
  readonly evidenceIds: readonly string[];
  readonly raisedAt: string;
  /** After this, the default applies. A decision with no deadline never closes. */
  readonly expiresAt: string;
};

export type DecisionOption = {
  readonly id: string;
  /** The choice, as the person would say it. */
  readonly label: string;
  /**
   * What actually happens if this is chosen.
   *
   * Required, and separate from the label. "Approve" is a label; "the worker
   * gets write access to the production bucket for one hour" is a consequence.
   * A person choosing between labels alone is guessing, and their approval
   * carries none of the authority it appears to.
   */
  readonly consequence: string;
  /** Whether this option is the destructive one, for display ordering only. */
  readonly irreversible: boolean;
};

const MAX_OPTIONS = 8;

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

function validateOption(
  raw: unknown,
  path: string,
  issues: ValidationIssue[],
  seenIds: Set<string>,
): void {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.push(issue(path, "invalid_type", `expected an object, got ${safeLabel(raw)}`));
    return;
  }
  const option = raw as Record<string, unknown>;
  for (const key of Object.keys(option)) {
    if (!["id", "label", "consequence", "irreversible"].includes(key)) {
      issues.push(issue(`${path}/${key}`, "unknown_field", "an option carries only its declared fields"));
    }
  }
  if (!isIdentifier(option.id)) {
    issues.push(issue(`${path}/id`, "invalid_id", "an option id is an identifier"));
  } else if (seenIds.has(option.id)) {
    issues.push(issue(`${path}/id`, "duplicate_option", "two options share an id"));
  } else {
    seenIds.add(option.id);
  }
  if (!isNonBlankText(option.label)) {
    issues.push(issue(`${path}/label`, "required_field", "an option needs a label"));
  }
  if (!isNonBlankText(option.consequence)) {
    issues.push(
      issue(
        `${path}/consequence`,
        "required_field",
        "say what this option DOES; a label alone makes the chooser guess",
      ),
    );
  }
  if (typeof option.irreversible !== "boolean") {
    issues.push(issue(`${path}/irreversible`, "invalid_type", "irreversible is strictly boolean"));
  }
}

/** Validate a decision packet from untrusted input. */
export function validateDecisionPacket(input: unknown): ValidationResult<DecisionPacket> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];

  const known = [
    "schemaVersion", "id", "workOrderId", "question", "defaultIfUnanswered",
    "options", "evidenceIds", "raisedAt", "expiresAt",
  ];
  for (const key of Object.keys(record)) {
    if (!known.includes(key)) {
      issues.push(issue(`/${key}`, "unknown_field", "a packet carries only its declared fields"));
    }
  }
  if (record.schemaVersion !== 1) {
    issues.push(issue("/schemaVersion", "invalid_schema_version", "this schema is version 1"));
  }
  for (const field of ["id", "workOrderId"] as const) {
    if (!isIdentifier(record[field])) {
      issues.push(issue(`/${field}`, "invalid_id", `${field} is an identifier`));
    }
  }
  if (!isNonBlankText(record.question)) {
    issues.push(issue("/question", "required_field", "a packet must state its question"));
  }
  if (!isNonBlankText(record.defaultIfUnanswered)) {
    issues.push(
      issue(
        "/defaultIfUnanswered",
        "required_field",
        // Silence is an answer whether or not anyone chose it, so it must be
        // written down before it is given.
        "say what happens if nobody answers; an unstated default is still a default",
      ),
    );
  }

  const seenOptionIds = new Set<string>();
  if (!Array.isArray(record.options)) {
    issues.push(issue("/options", "invalid_type", "options is an array"));
  } else if (record.options.length < 2) {
    issues.push(
      issue(
        "/options",
        "not_a_decision",
        // The whole point of the budget is that being asked costs something.
        "a decision needs at least two options; one option is a notification "
          + "that charges a person for a choice they were never given",
      ),
    );
  } else if (record.options.length > MAX_OPTIONS) {
    issues.push(
      issue("/options", "too_many_options", `at most ${MAX_OPTIONS} options; beyond that this is research, not a decision`),
    );
  } else {
    record.options.forEach((option, i) => validateOption(option, `/options/${i}`, issues, seenOptionIds));
  }

  if (!Array.isArray(record.evidenceIds) || record.evidenceIds.length === 0) {
    issues.push(
      issue("/evidenceIds", "evidence_required", "a decision must cite what it rests on"),
    );
  } else {
    record.evidenceIds.forEach((id, i) => {
      if (!isIdentifier(id)) {
        issues.push(issue(`/evidenceIds/${i}`, "invalid_id", "an evidence id is an identifier"));
      }
    });
  }

  for (const field of ["raisedAt", "expiresAt"] as const) {
    if (!isCanonicalTimestamp(record[field])) {
      issues.push(issue(`/${field}`, "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z"));
    }
  }
  if (
    isCanonicalTimestamp(record.raisedAt)
    && isCanonicalTimestamp(record.expiresAt)
    && Date.parse(record.expiresAt) <= Date.parse(record.raisedAt)
  ) {
    issues.push(
      issue("/expiresAt", "expiry_not_after_raised", "a packet that expires when raised was never askable"),
    );
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as DecisionPacket, {});
}

export const DECISION_PACKET_SCHEMA_META: SchemaMeta = {
  id: "vinci.decision-packet",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};
