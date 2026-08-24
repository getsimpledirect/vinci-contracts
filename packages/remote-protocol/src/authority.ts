import {
  fail,
  isCanonicalTimestamp,
  ok,
  toPlainRecord,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import { isSessionRole, type SessionRole } from "./session.ts";

/**
 * What a remote device may ask a host to do.
 *
 * Split deliberately into two sets, because the difference is the whole point.
 */

/**
 * Commands that reduce what the worker may do WITHOUT destroying its work.
 *
 * Available to any role that may act at all. The justification is that the
 * worst outcome of an unauthorized brake is that work stops and can be
 * resumed — recoverable, so requiring an approval round trip before someone
 * can slow a worker down gets the trade backwards.
 *
 * Note what is NOT here: `abort`. An earlier version of this file listed abort
 * alongside these and reused the same "worst case is a recoverable pause"
 * argument for it. That argument is about pausing. It does not establish that
 * aborting is recoverable, and this package — which defines a protocol, not a
 * host — cannot establish it: whether an aborted run loses uncommitted work
 * depends on host lifecycle semantics it does not control.
 *
 * Reusing a safety argument for a case it was not made about is how a
 * destructive action acquires a permissive default.
 */
export const REVERSIBLE_BRAKING_COMMANDS = [
  "pause",
  "restrict_to_read_only",
  "deny_pending_approval",
] as const;

/**
 * Terminal commands. Not reversible braking, and not broadening either.
 *
 * `abort` ends a run. Until the host lifecycle proves otherwise, assume it may
 * discard in-flight and uncommitted work. It is therefore narrowly authorized:
 * the run's owner only.
 *
 * That is not a hardship, because `pause` covers the urgent case. Anyone who
 * may act can stop a worker immediately; only the owner can throw the work
 * away. Braking is universal, termination is owned.
 */
export const TERMINAL_COMMANDS = ["abort"] as const;

export const BROADENING_COMMANDS = [] as const;

export const STEERING_COMMANDS = ["send_message", "answer_question"] as const;

export type RemoteCommandKind =
  | (typeof REVERSIBLE_BRAKING_COMMANDS)[number]
  | (typeof TERMINAL_COMMANDS)[number]
  | (typeof STEERING_COMMANDS)[number]
  | "approve_pending_approval";

/**
 * Which roles may issue which commands.
 *
 * A viewer may do nothing but watch. That is what the word means, and a viewer
 * that can steer is a collaborator with a misleading label.
 */
const PERMITTED: Readonly<Record<SessionRole, readonly RemoteCommandKind[]>> = {
  // The host is not a remote device; it receives commands rather than sending
  // them, and is listed so the map is total.
  host: [],
  // The owner is the only role that may end a run, because ending it may
  // discard work and this package cannot prove otherwise.
  owner: [
    ...REVERSIBLE_BRAKING_COMMANDS,
    ...TERMINAL_COMMANDS,
    "send_message",
    "answer_question",
    "approve_pending_approval",
  ],
  approver: [...REVERSIBLE_BRAKING_COMMANDS, "approve_pending_approval"],
  collaborator: [...REVERSIBLE_BRAKING_COMMANDS, "send_message", "answer_question"],
  viewer: [],
};

/**
 * May a device in this role issue this command?
 *
 * Returns false for anything unrecognised — it does not throw.
 *
 * This is an authority check, and a thrown TypeError in an authority check is
 * not fail-closed in practice. It gets handled by whatever try/catch is
 * upstream, and the two usual outcomes are a crash in a request path or a
 * broad catch that logs and continues — the second of which means the check was
 * skipped. `false` is unambiguous: no authority, no exception to swallow.
 *
 * A review marked the throwing version "correct boundary". It is not: the
 * caller cannot distinguish "this role may not" from "this code broke", and
 * only one of those is safe to proceed past.
 */
export function mayIssue(role: SessionRole, command: RemoteCommandKind): boolean {
  // typeof first, before anything indexes with `role`.
  //
  // The previous version guarded the lookup RESULT and not the lookup ITSELF.
  // Indexing an object with an exotic key coerces the key to a property name,
  // and that coercion runs code the caller supplied: a proxy with a throwing
  // get trap, an object whose toString throws, and Object.create(null) all
  // threw out of this function while its own comment promised it would not.
  //
  // A typeof check is used rather than try/catch deliberately. A catch would
  // swallow a genuine programming error alongside hostile input and report
  // both as "no authority", hiding real bugs. Refusing non-strings up front
  // separates the two.
  // Membership in the CLOSED VOCABULARY, before any indexing happens.
  //
  // A typeof guard was not enough, and the reason is worth stating because the
  // first fix looked complete. `"toString"` IS a string, so it passed the
  // typeof check; `PERMITTED["toString"]` then resolved through the prototype
  // chain to Object.prototype.toString, which is a function and therefore not
  // `undefined`, so the undefined-guard let it through, and `.includes` threw.
  // Same for constructor, valueOf, hasOwnProperty and __proto__.
  //
  // The lesson is that `PERMITTED[role] === undefined` asks "is this key
  // absent?" and gets the wrong answer for every key JavaScript puts on every
  // object. Asking `isSessionRole(role)` instead asks the question actually
  // meant — is this one of the five roles we defined — and no inherited
  // property can satisfy it.
  if (!isSessionRole(role)) return false;
  if (typeof command !== "string") return false;
  const permitted = PERMITTED[role];
  // Belt and braces: a role in the vocabulary that is missing from the map is a
  // programming error, and denying is the safe reading of it.
  if (!Array.isArray(permitted)) return false;
  return permitted.includes(command);
}

/**
 * Does this command only reduce authority, without destroying work?
 *
 * Exported so a host applies the rule rather than re-deriving it. Anything not
 * reversible braking needs either the approval path or owner authority, and a
 * host that hand-rolls the distinction will eventually disagree with this one.
 */
export function isReversibleBraking(command: RemoteCommandKind): boolean {
  if (typeof command !== "string") return false;
  return (REVERSIBLE_BRAKING_COMMANDS as readonly string[]).includes(command);
}

/** Terminal, and deliberately not grouped with braking. */
export function isTerminal(command: RemoteCommandKind): boolean {
  if (typeof command !== "string") return false;
  return (TERMINAL_COMMANDS as readonly string[]).includes(command);
}

/**
 * A remote decision is PROVISIONAL until the host confirms it.
 *
 * The relay carries authority requests; it does not manufacture authority. A
 * phone tap is a statement of intent that the host validates against what it
 * actually offered, whether the request is still open, and whether it has
 * expired. Treating the relay's acknowledgement as the decision would let a
 * compromised or merely buggy relay approve things nobody approved.
 */
export type RemoteDecisionState =
  | { readonly kind: "provisional"; readonly submittedAt: string }
  | { readonly kind: "confirmed"; readonly confirmedAt: string }
  | { readonly kind: "rejected_by_host"; readonly reason: RemoteDecisionRejection };

export const REMOTE_DECISION_REJECTIONS = [
  /** The chosen option was not one the host offered. */
  "option_not_offered",
  /** The approval expired before the decision arrived. */
  "expired",
  /** The request was already settled, locally or by another device. */
  "already_settled",
  /** The device's role does not permit this decision. */
  "not_permitted",
  /** The session moved on; the request no longer exists. */
  "session_changed",
] as const;

export type RemoteDecisionRejection = (typeof REMOTE_DECISION_REJECTIONS)[number];

/**
 * Validate a remote decision state arriving from untrusted input.
 *
 * This exists because the package was claiming validation coverage it did not
 * have. `RemoteDecisionState` was type-only: the timestamps it carries were
 * never checked for canonical form, and the rejection arm's `reason` was never
 * checked against the closed vocabulary. A type is a compile-time statement
 * about code we wrote; it says nothing about bytes off a relay, and a relay is
 * precisely the thing the surrounding comment says not to trust.
 *
 * Fail-closed, on an inert snapshot, like every validator here. An unrecognised
 * `kind` is rejected rather than preserved — the documented exception to the
 * unknown-field rule, because a decision state nobody understands must not be
 * carried forward as though it were understood.
 */
export function validateRemoteDecisionState(
  input: unknown,
): ValidationResult<RemoteDecisionState> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];
  const add = (path: string, code: string, message: string) => issues.push({ path, code, message });

  // A null-prototype map, so `in` and indexing cannot reach Object.prototype.
  // With an ordinary object literal, `"toString" in KEYS` is TRUE — the `in`
  // operator walks the prototype chain — and the lookup then returned a
  // function whose `.includes` threw. Object.hasOwn below is the explicit
  // own-key question; the null prototype makes it impossible to get wrong twice.
  const KEYS: Record<string, readonly string[]> = Object.assign(Object.create(null), {
    provisional: ["kind", "submittedAt"],
    confirmed: ["kind", "confirmedAt"],
    rejected_by_host: ["kind", "reason"],
  });

  const kind = record.kind;
  if (typeof kind !== "string" || !Object.hasOwn(KEYS, kind)) {
    // Fail closed and stop: without a known kind there is no shape to check
    // the remaining fields against, and guessing one would invent authority.
    return fail([
      {
        path: "/kind",
        code: "invalid_enum",
        message: "a decision is provisional, confirmed or rejected_by_host",
      },
    ]);
  }

  const allowed = KEYS[kind] as readonly string[];
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      add(`/${key}`, "unknown_field", `a ${kind} decision carries only its declared fields`);
    }
  }

  if (kind === "provisional" && !isCanonicalTimestamp(record.submittedAt)) {
    add("/submittedAt", "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z");
  }
  if (kind === "confirmed" && !isCanonicalTimestamp(record.confirmedAt)) {
    add("/confirmedAt", "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z");
  }
  if (kind === "rejected_by_host"
      && !(REMOTE_DECISION_REJECTIONS as readonly unknown[]).includes(record.reason)) {
    add("/reason", "invalid_enum", "unrecognised rejection reason");
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as RemoteDecisionState, {});
}

export const REMOTE_DECISION_STATE_SCHEMA_META: SchemaMeta = {
  id: "vinci.remote-decision-state",
  version: 1,
  /**
   * Frozen, like the session binding beside it: the validator rejects unknown
   * fields, and a schema that refuses additions has not left room for them.
   */
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  /**
   * An unrecognised `kind` is rejected rather than preserved — the documented
   * exception to the unknown-field rule for state members. A decision state
   * nobody understands must not be carried forward as though it were
   * understood, because the thing it decides is authority.
   */
  migration: "none",
};
