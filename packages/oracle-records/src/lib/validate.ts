import {
  isCanonicalTimestamp,
  isDigest,
  isIdentifier,
  isNonBlankText,
  plainActor,
  type PlainValue,
  type ValidationIssue,
} from "@getsimpledirect/vinci-contracts";

/**
 * Shared validation helpers for the Oracle record package.
 *
 * A private copy, deliberately. `packages/run/src/lib/validate.ts` carries the
 * same helpers and `packages/work-orders` a third set, because reaching across
 * a package's `src` for a helper is the coupling the layer rule exists to
 * prevent — a consumer installing one package would need the other's internals
 * on disk. The duplication is bounded (these are three-line predicates) and the
 * shared VOCABULARY, which is the thing that must not diverge, lives in
 * `@getsimpledirect/vinci-contracts` where both copies import it from.
 */

/** One validation issue, carrying a stable machine-readable code. */
export function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

/** Is `value` a plain data object (not null, not an array)? */
export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reject any key on `record` that is not in `allowed`.
 *
 * `alreadyReported` names paths some earlier, MORE SPECIFIC rule has already
 * refused. Without it a credential-shaped key collects two issues — one saying
 * "not a declared field" and one saying "a credential may not appear here" —
 * and a consumer switching on the first code it sees learns the generic one.
 * The specific refusal is the whole point of having a dedicated code.
 */
export function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  noun: string,
  issues: ValidationIssue[],
  alreadyReported?: ReadonlySet<string>,
): void {
  for (const key of Object.keys(record)) {
    if (alreadyReported?.has(`${path}/${key}`)) continue;
    if (!allowed.includes(key)) {
      issues.push(issue(`${path}/${key}`, "unknown_field", `${noun} carries only its declared fields`));
    }
  }
}

/** A safe integer >= 0. Negative zero is rejected. */
export function isNonNegativeInt(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
  );
}

/** A safe integer >= 1. */
export function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** Non-blank text no longer than 512 characters (used for refs). */
export function isRefText(value: unknown): value is string {
  return isNonBlankText(value) && (value as string).length <= 512;
}

/**
 * Prose a human reads: non-blank, and bounded so a record cannot become a
 * transport for a document. 4096 is far above any question or decision
 * statement and far below anything that would be smuggled through a field
 * described as a sentence.
 */
export function isProseText(value: unknown): value is string {
  return isNonBlankText(value) && (value as string).length <= 4096;
}

/**
 * A git object id: exactly 40 lowercase hex characters.
 *
 * Same rule and same reasoning as `packages/run/src/lib/validate.ts`: a commit
 * or tree id is a SHA-1 object name, and accepting a 64-hex digest here would
 * let the digest of anything at all stand where a revision is required.
 */
export function isGitObjectId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

/** Is `value` a member of the closed `members` set? */
export function isEnumMember(value: unknown, members: readonly string[]): value is string {
  return typeof value === "string" && (members as readonly string[]).includes(value);
}

/**
 * An array of refs, each non-blank and each distinct.
 *
 * Duplicates are refused rather than deduplicated: a list that names the same
 * grant twice and a list that names it once are different claims about what was
 * resolved, and collapsing them silently makes the record say something its
 * producer did not.
 */
export function readRefArray(
  value: unknown,
  path: string,
  noun: string,
  issues: ValidationIssue[],
): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    issues.push(issue(path, "invalid_type", `${noun} is an array`));
    return undefined;
  }
  const seen = new Set<string>();
  let ok = true;
  value.forEach((entry, i) => {
    if (!isRefText(entry)) {
      issues.push(issue(`${path}/${i}`, "invalid_ref", "a ref is non-blank text of at most 512 characters"));
      ok = false;
      return;
    }
    if (seen.has(entry)) {
      issues.push(issue(`${path}/${i}`, "duplicate_ref", `${noun} names the same ref twice`));
      ok = false;
      return;
    }
    seen.add(entry);
  });
  return ok ? (value as readonly string[]) : undefined;
}

/**
 * The first term in `terms` that appears in `key`, case-folded, or null.
 *
 * Substring rather than exact match, so `policyRef`, `policy_ref`,
 * `applicablePolicy` and `policyRefsResolved` are one forbidden idea rather
 * than four names somebody has to have thought of.
 *
 * WHAT THIS IS NOT. An earlier version of this comment claimed "the term, not
 * the field, is what is forbidden", which reads as a rule about authority. It
 * is a rule about FOURTEEN WORD STEMS. A review found twenty-one
 * authority-bearing key names it does not match — `authorizedBy`,
 * `authorization`, `approvalRef`, `entitlements`, `privileges`, `capabilities`,
 * `roleAssignment`, `clearance`, `canMerge`, `signedBy`, `sudo`, `runAs` and
 * more — in minutes, because "authorized" does not contain "authority". A stem
 * list cannot be completed by adding stems; that is the same defect one level
 * up, and the next reviewer would find the twenty-second spelling just as fast.
 *
 * So this is a NAMING net over the common spellings, and its value is the
 * distinct issue code: a caller learns "you put an authority field in the model
 * half" instead of "unknown field". The DEFENCE is each record's own payload
 * allowlist, which is a closed list of declared names and therefore refuses
 * every spelling including the twenty-one above. `src/authority-terms.test.ts`
 * pins both halves of that, in both directions.
 *
 * The cost of the substring rule is that a legitimate field may not contain one
 * of these words. That cost is asserted rather than assumed — see
 * `src/conformance.test.ts`.
 */
export function forbiddenTermIn(key: string, terms: readonly string[]): string | null {
  const folded = key.toLowerCase();
  for (const term of terms) {
    if (folded.includes(term)) return term;
  }
  return null;
}

/**
 * Walk a plain subtree and refuse any key carrying a forbidden term, at any
 * depth, with `code` — never with the generic `unknown_field`.
 *
 * The depth matters. A payload field is refused at the top level by its own
 * allowlist anyway, so a top-level-only check would be satisfied by a rule that
 * was already there and would say nothing new. The claim being made is that the
 * model-authored subtree contains NO authority anywhere in it, and that claim
 * is only true if something looks everywhere in it.
 *
 * The distinct code is what makes the negative control discriminating: a test
 * asserting "the payload was refused" passes when an unrelated allowlist
 * refuses first, and would still pass with this rule deleted.
 */
export function rejectForbiddenKeysDeep(
  node: PlainValue,
  path: string,
  terms: readonly string[],
  code: string,
  message: (key: string, term: string) => string,
  issues: ValidationIssue[],
): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => {
      rejectForbiddenKeysDeep(child, `${path}/${i}`, terms, code, message, issues);
    });
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [key, child] of Object.entries(node as Readonly<Record<string, PlainValue>>)) {
    const term = forbiddenTermIn(key, terms);
    if (term !== null) {
      issues.push(issue(`${path}/${key}`, code, message(key, term)));
      continue;
    }
    rejectForbiddenKeysDeep(child, `${path}/${key}`, terms, code, message, issues);
  }
}

/**
 * Terms that make a key an authority claim, however it is spelled.
 *
 * CON-03 says the host resolves source ids, principal identities, artifact
 * digests, tool observations and cost receipts. These are those things, as word
 * stems, so that `policyRef`, `policy_ref`, `applicablePolicy` and
 * `policyRefsResolved` are one forbidden idea rather than four names somebody
 * has to have thought of.
 *
 * The price is that no model-authored field may contain one of these words.
 * That price is asserted rather than assumed: `src/conformance.test.ts` checks
 * every declared payload field name in this package against this list, so a
 * future field that trips it fails a test instead of silently producing a
 * record type nobody can construct.
 */
export const AUTHORITY_TERMS = [
  "authority",
  "principal",
  "workspace",
  "grant",
  "budget",
  "digest",
  "policy",
  "credential",
  "token",
  "actor",
  "attest",
  "signature",
  "permission",
  "receipt",
] as const;

/**
 * Terms that make a key a place to put a secret. CTX-03: the model receives the
 * semantic contents it needs, and credentials and opaque authority tokens stay
 * outside its context.
 *
 * Deliberately overlapping with {@link AUTHORITY_TERMS} on `credential` and
 * `token` and deliberately a separate list: the two rules refuse for different
 * reasons and carry different codes, and merging them would make a context
 * record's refusal read as an authority-smuggling finding.
 */
export const CONTEXT_SECRET_TERMS = [
  "credential",
  "token",
  "secret",
  "password",
  "apikey",
  "authorization",
  "bearer",
  "privatekey",
] as const;

/** The code a model-authored payload's authority key is refused with. */
export const AUTHORITY_IN_PAYLOAD_CODE = "authority_field_in_model_payload";

/**
 * Refuse an authority-bearing key anywhere in a model-authored subtree.
 *
 * `payload` must already have been through `toPlainRecord`; this walks inert
 * data and never touches the caller's original input.
 */
export function rejectAuthorityFieldsInPayload(
  payload: PlainValue,
  path: string,
  issues: ValidationIssue[],
): void {
  rejectForbiddenKeysDeep(
    payload,
    path,
    AUTHORITY_TERMS,
    AUTHORITY_IN_PAYLOAD_CODE,
    (key, term) =>
      `the model-authored payload may not carry ${key}: the term "${term}" names something the `
      + "host resolves, and the same name is accepted on the envelope (CON-03, INV-01)",
    issues,
  );
}

/** Record `code` at `path` unless `value` is a member of `members`. */
export function readEnum(
  value: unknown,
  members: readonly string[],
  path: string,
  code: string,
  message: string,
  issues: ValidationIssue[],
): void {
  if (!isEnumMember(value, members)) issues.push(issue(path, code, message));
}

/** An array whose members all come from `members`, each named at most once. */
export function readEnumArray(
  value: unknown,
  members: readonly string[],
  path: string,
  code: string,
  message: string,
  issues: ValidationIssue[],
): void {
  if (!Array.isArray(value)) {
    issues.push(issue(path, "invalid_type", "expected an array"));
    return;
  }
  const seen = new Set<string>();
  value.forEach((entry, i) => {
    if (!isEnumMember(entry, members)) {
      issues.push(issue(`${path}/${i}`, code, message));
      return;
    }
    if (seen.has(entry)) {
      issues.push(issue(`${path}/${i}`, "duplicate_member", "a member is listed twice"));
      return;
    }
    seen.add(entry);
  });
}

/**
 * A non-negative cost in micro-USD.
 *
 * Split from the generic integer check so a refusal names the reason. CON-02
 * lists negative costs and non-finite numbers separately and they fail in
 * different places, which is worth knowing when reading a refusal:
 *
 *   - A NON-FINITE number never reaches here. `toPlainRecord` refuses the whole
 *     record at the shared inert-snapshot boundary, with `unsupported_value` at
 *     path `""` and a message naming the non-finite number. That is earlier and
 *     stricter than this function, and it is also less specific: the refusal
 *     names the record rather than the field. Changing that would mean changing
 *     a frozen layer-0 boundary five packages depend on, so this package pins
 *     the behaviour in a test rather than working around it.
 *   - `-0` does not reach here either: the same boundary normalizes it to `0`,
 *     which is what `canonicalize` would encode anyway. One value, one identity.
 *   - A NEGATIVE integer is well-formed data that means something impossible,
 *     and that is the case this function is for. Zero is legitimate and is
 *     neither.
 */
export function readCost(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (isNonNegativeInt(value)) return;
  if (typeof value === "number" && Number.isSafeInteger(value) && value < 0) {
    issues.push(issue(path, "negative_cost", "a cost is never negative"));
    return;
  }
  issues.push(issue(path, "invalid_type", "a cost is a non-negative safe integer of micro-USD"));
}

/** An array of statements. Returns undefined if any member is not one. */
export function readStringList(
  value: unknown,
  path: string,
  noun: string,
  issues: ValidationIssue[],
): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    issues.push(issue(path, "invalid_type", `${noun} is an array`));
    return undefined;
  }
  let sound = true;
  value.forEach((entry, i) => {
    if (!isProseText(entry)) {
      issues.push(issue(`${path}/${i}`, "invalid_type", `${noun} holds statements`));
      sound = false;
    }
  });
  return sound ? (value as readonly string[]) : undefined;
}

/**
 * A list of pointers into delivered sources, each optionally into a span.
 *
 * Shared by the claim record (what the claim is offered on) and the claim
 * assessment (what the evaluator ACTUALLY reviewed), which is the pair CLM-01
 * turns on: those two lists are different facts, and a single validator for
 * both is what keeps them the same SHAPE so a consumer can compare them.
 *
 * `sourceId` is the host-assigned id, never the presentation number — SRC-03.
 * Whether the id was ever delivered is `resolveCitations`' question, not this
 * one; a shape check that pretended otherwise would look like a guarantee it
 * never made.
 */
export function readSourceSpans(
  value: unknown,
  path: string,
  noun: string,
  issues: ValidationIssue[],
): void {
  if (!Array.isArray(value)) {
    issues.push(issue(path, "invalid_type", `${noun} is an array`));
    return;
  }
  value.forEach((raw, i) => {
    const at = `${path}/${i}`;
    if (!isObjectRecord(raw)) {
      issues.push(issue(at, "invalid_type", "a source span is an object"));
      return;
    }
    rejectUnknownFields(raw, ["sourceId", "span"], at, "a source span", issues);
    if (!isIdentifier(raw.sourceId)) {
      issues.push(
        issue(
          `${at}/sourceId`,
          "invalid_id",
          "SRC-03: a span names the host-assigned source id, never the number a reader saw",
        ),
      );
    }
    const span = raw.span;
    if (span === null) return;
    if (!isObjectRecord(span)) {
      issues.push(issue(`${at}/span`, "invalid_type", "span is an object or explicitly null"));
      return;
    }
    rejectUnknownFields(span, ["startOffset", "endOffset"], `${at}/span`, "a span", issues);
    for (const field of ["startOffset", "endOffset"] as const) {
      if (!isNonNegativeInt(span[field])) {
        issues.push(
          issue(`${at}/span/${field}`, "invalid_type", `${field} is a non-negative integer`),
        );
      }
    }
    if (
      isNonNegativeInt(span.startOffset)
      && isNonNegativeInt(span.endOffset)
      && span.endOffset < span.startOffset
    ) {
      issues.push(
        issue(`${at}/span/endOffset`, "inverted_range", "a span ends no earlier than it starts"),
      );
    }
  });
}

/** The schema versions this build reads. An unsupported one is refused, never downgraded. */
export const SUPPORTED_SCHEMA_VERSIONS = [1] as const;

/**
 * Record an issue unless `value` is a readable schema version.
 *
 * Note what this deliberately does NOT do: there is no branch that reads an
 * unknown version as the nearest known one. A downgrade is not implemented, so
 * it cannot happen by accident — which is the only form of "cannot be silently
 * downgraded" that survives a future edit. T07's negative rests on this.
 */
export function checkSchemaVersion(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if ((SUPPORTED_SCHEMA_VERSIONS as readonly unknown[]).includes(value)) return;
  issues.push(
    issue(
      path,
      "unsupported_schema_version",
      `this build reads schema version ${SUPPORTED_SCHEMA_VERSIONS.join(", ")} only; an `
        + "unsupported version is refused, never read as a lower one",
    ),
  );
}

export { isCanonicalTimestamp, isDigest, isIdentifier, isNonBlankText, plainActor };
