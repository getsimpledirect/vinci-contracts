import { describe, expect, it } from "vitest";
import { assertSchemaMetaComplete } from "@getsimpledirect/vinci-contracts";
import {
  BROADENING_COMMANDS,
  SESSION_ROLES,
  REVERSIBLE_BRAKING_COMMANDS,
  TERMINAL_COMMANDS,
  isReversibleBraking,
  isTerminal,
  validateRemoteDecisionState,
  mayIssue,
  type RemoteCommandKind,
  type SessionRole,
  SESSION_BINDING_SCHEMA_META,
  validateSessionBinding,
} from "./index.ts";

describe("a remote device may tighten authority, never broaden it", () => {
  it("offers no command that broadens what a worker may do", () => {
    // set_permission_mode: full_access is deliberately absent. A phone that can
    // silently raise a worker to full access turns an unlocked device into
    // privilege escalation, through a channel whose whole premise is that the
    // human is NOT at the machine.
    expect(BROADENING_COMMANDS).toHaveLength(0);
  });

  it("lets every acting role apply reversible braking", () => {
    // Reducing authority WITHOUT destroying work is safe by construction — the
    // worst case is that work pauses and resumes. Requiring an approval round
    // trip before someone can hit the brakes gets the trade backwards.
    //
    // This test deliberately iterates REVERSIBLE_BRAKING_COMMANDS and not "all
    // tightening commands". The previous version iterated a list that included
    // `abort` under this same comment, which asserted that terminating a run is
    // recoverable. Nothing establishes that.
    for (const role of ["owner", "approver", "collaborator"] as const) {
      for (const command of REVERSIBLE_BRAKING_COMMANDS) {
        expect(mayIssue(role, command), `${role} -> ${command}`).toBe(true);
      }
    }
  });

  it("lets only the owner abort", () => {
    // Aborting may discard in-flight work. This package defines a protocol, not
    // a host, so it cannot prove otherwise and does not assume it.
    expect(mayIssue("owner", "abort")).toBe(true);
    for (const role of ["approver", "collaborator", "viewer", "host"] as const) {
      expect(mayIssue(role, "abort"), `${role} must not abort`).toBe(false);
    }
  });

  it("keeps the urgent path open to everyone who may act", () => {
    // Narrowing abort costs nothing operationally BECAUSE pause is universal.
    // If this ever fails, the abort restriction has become a safety problem:
    // someone watching a worker misbehave would have no way to stop it.
    for (const role of ["owner", "approver", "collaborator"] as const) {
      expect(mayIssue(role, "pause"), `${role} must be able to pause`).toBe(true);
    }
  });

  it("does not classify a terminal command as reversible braking", () => {
    for (const command of REVERSIBLE_BRAKING_COMMANDS) {
      expect(isReversibleBraking(command)).toBe(true);
      expect(isTerminal(command)).toBe(false);
    }
    for (const command of TERMINAL_COMMANDS) {
      expect(isTerminal(command)).toBe(true);
      expect(isReversibleBraking(command), `${command} is not reversible`).toBe(false);
    }
    for (const command of ["send_message", "answer_question", "approve_pending_approval"] as const) {
      expect(isReversibleBraking(command)).toBe(false);
      expect(isTerminal(command)).toBe(false);
    }
  });

  it("gives a viewer no authority at all", () => {
    // A viewer that can steer is a collaborator with a misleading label.
    const everyCommand: RemoteCommandKind[] = [
      ...REVERSIBLE_BRAKING_COMMANDS,
      ...TERMINAL_COMMANDS,
      "send_message",
      "answer_question",
      "approve_pending_approval",
    ];
    for (const command of everyCommand) {
      expect(mayIssue("viewer", command), command).toBe(false);
    }
  });

  it("lets only owners and approvers approve", () => {
    expect(mayIssue("owner", "approve_pending_approval")).toBe(true);
    expect(mayIssue("approver", "approve_pending_approval")).toBe(true);
    // A collaborator may deny and may steer, but granting authority is not the
    // same act as withholding it.
    expect(mayIssue("collaborator", "approve_pending_approval")).toBe(false);
    expect(mayIssue("collaborator", "deny_pending_approval")).toBe(true);
  });

  it("declares a permission list for every role", () => {
    // A role missing from the map would throw at the call site rather than
    // refuse, which is the wrong failure.
    for (const role of SESSION_ROLES) {
      expect(() => mayIssue(role as SessionRole, "pause")).not.toThrow();
    }
  });
});

describe("a session is transport identity; a run is work identity", () => {
  const binding = (o: Record<string, unknown> = {}) => ({
    sessionId: "sess-1",
    runId: "run-1",
    workspaceId: "ws-1",
    organizationId: null,
    hostDeviceId: "dev-1",
    policyId: "pol-1",
    policyVersion: 1,
    retentionClass: "zdr_0d",
    ...o,
  });

  it("carries a runId distinct from the sessionId", () => {
    // Keying work to the session id reads naturally while there is one session
    // per run, then becomes wrong the first time a worker restarts: approvals,
    // receipts and evidence would all reference a transport artifact that no
    // longer exists.
    const result = validateSessionBinding(binding());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.runId).not.toBe(result.value.sessionId);
  });

  it("lets many sessions belong to one run", () => {
    const first = validateSessionBinding(binding({ sessionId: "sess-1" }));
    const second = validateSessionBinding(binding({ sessionId: "sess-2" }));
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(first.value.runId).toBe(second.value.runId);
  });

  it("requires organizationId to be present and explicitly null, not absent", () => {
    // An absent organization is indistinguishable from one nobody set.
    const { organizationId: _dropped, ...withoutOrg } = binding();
    expect(validateSessionBinding(withoutOrg).ok).toBe(false);
    expect(validateSessionBinding(binding({ organizationId: null })).ok).toBe(true);
    expect(validateSessionBinding(binding({ organizationId: "org-1" })).ok).toBe(true);
  });

  it("requires a policy version and a known retention class", () => {
    for (const bad of [0, -1, 1.5, "1", 2 ** 53]) {
      expect(validateSessionBinding(binding({ policyVersion: bad })).ok, String(bad)).toBe(false);
    }
    expect(validateSessionBinding(binding({ retentionClass: "forever" })).ok).toBe(false);
  });

  it("refuses an unknown field", () => {
    expect(validateSessionBinding(binding({ extra: 1 })).ok).toBe(false);
  });

  it("declares a compatibility policy its validator honours", () => {
    expect(SESSION_BINDING_SCHEMA_META.unknownFields).toBe("reject");
    expect(SESSION_BINDING_SCHEMA_META.compatibility).toBe("frozen");
    expect(() => assertSchemaMetaComplete(SESSION_BINDING_SCHEMA_META)).not.toThrow();
  });
});

describe("an authority check refuses rather than throwing", () => {
  // A thrown TypeError in an authority check is not fail-closed in practice: it
  // is handled by whatever try/catch is upstream, and a broad catch that logs
  // and continues means the check was skipped. A review marked the throwing
  // version "correct boundary" — but the caller cannot tell "this role may not"
  // from "this code broke", and only one is safe to proceed past.
  it.each([
    ["an invented role", "superuser"],
    ["an empty string", ""],
    ["null", null],
    ["undefined", undefined],
    ["a number", 123],
    ["an object", {}],
  ])("returns false for %s without throwing", (_label, role) => {
    let result: boolean | undefined;
    expect(() => {
      result = mayIssue(role as never, "approve_pending_approval");
    }).not.toThrow();
    expect(result).toBe(false);
  });

  it("still answers correctly for every real role", () => {
    for (const role of SESSION_ROLES) {
      expect(typeof mayIssue(role as SessionRole, "pause")).toBe("boolean");
    }
    expect(mayIssue("owner", "pause")).toBe(true);
    expect(mayIssue("viewer", "pause")).toBe(false);
  });

  it("never classifies an unknown command as tightening", () => {
    // Tightening bypasses the approval path, so a wrong answer here is the
    // dangerous direction.
    for (const bogus of ["set_permission_mode", "grant_full_access", "", "escalate"]) {
      expect(isReversibleBraking(bogus as never)).toBe(false);
      expect(isTerminal(bogus as never)).toBe(false);
    }
  });
});

describe("an authority check refuses hostile input rather than throwing", () => {
  // Every one of these threw out of mayIssue before the typeof guard, because
  // the guard tested the lookup RESULT and not the lookup ITSELF: indexing an
  // object coerces the key, and coercion runs caller-supplied code.
  const hostile: Array<[string, unknown]> = [
    ["a proxy with a throwing get trap", new Proxy({}, { get() { throw new Error("trap"); } })],
    ["an object whose toString throws", { toString() { throw new Error("toString"); } }],
    ["a null-prototype object", Object.create(null)],
    // Inherited keys. Every one of these IS a string, so a typeof guard passes
    // them, and an ordinary object lookup then finds Object.prototype's member
    // rather than undefined. The first fix here guarded coercion and missed
    // these entirely.
    ["the string toString", "toString"],
    ["the string constructor", "constructor"],
    ["the string valueOf", "valueOf"],
    ["the string hasOwnProperty", "hasOwnProperty"],
    ["the string __proto__", "__proto__"],
    ["the string isPrototypeOf", "isPrototypeOf"],
    ["a symbol", Symbol("owner")],
    ["null", null],
    ["undefined", undefined],
    ["a number", 7],
    ["an array", ["owner"]],
  ];

  for (const [label, role] of hostile) {
    it(`returns false for ${label}`, () => {
      expect(() => mayIssue(role as never, "pause")).not.toThrow();
      expect(mayIssue(role as never, "pause")).toBe(false);
      expect(mayIssue(role as never, "abort")).toBe(false);
    });
  }

  it("still answers correctly for real roles", () => {
    // Positive control. A function that returns false for everything satisfies
    // every test above and is useless.
    expect(mayIssue("owner", "pause")).toBe(true);
    expect(mayIssue("owner", "abort")).toBe(true);
    expect(mayIssue("collaborator", "send_message")).toBe(true);
  });

  it("refuses a hostile command as well as a hostile role", () => {
    const trap = new Proxy({}, { get() { throw new Error("trap"); } });
    expect(() => mayIssue("owner", trap as never)).not.toThrow();
    expect(mayIssue("owner", trap as never)).toBe(false);
  });
});

describe("a remote decision state is validated, not assumed", () => {
  const provisional = { kind: "provisional", submittedAt: "2026-08-23T12:00:00.000Z" };

  it("accepts each well-formed arm", () => {
    // Positive controls first.
    expect(validateRemoteDecisionState(provisional).ok).toBe(true);
    expect(validateRemoteDecisionState({
      kind: "confirmed", confirmedAt: "2026-08-23T12:00:00.000Z",
    }).ok).toBe(true);
    expect(validateRemoteDecisionState({
      kind: "rejected_by_host", reason: "expired",
    }).ok).toBe(true);
  });

  it("rejects an inherited property name as a kind", () => {
    // `"toString" in KEYS` is true for an ordinary object literal, because the
    // `in` operator walks the prototype chain. The lookup then returned a
    // function and `.includes` threw out of a fail-closed validator.
    for (const kind of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(() => validateRemoteDecisionState({ kind }), kind).not.toThrow();
      expect(validateRemoteDecisionState({ kind }).ok, kind).toBe(false);
    }
  });

  it("rejects an unrecognised kind rather than carrying it forward", () => {
    for (const kind of ["approved", "", "PROVISIONAL", 1, null]) {
      expect(validateRemoteDecisionState({ kind }).ok, String(kind)).toBe(false);
    }
  });

  it("rejects a non-canonical timestamp", () => {
    for (const submittedAt of [
      "2026-08-23T12:00:00Z",        // no milliseconds
      "2026-08-23T12:00:00.000+01:00", // not UTC
      "2026-02-29T12:00:00.000Z",    // a date that does not exist
      "not a date", 0, null, undefined,
    ]) {
      expect(
        validateRemoteDecisionState({ kind: "provisional", submittedAt }).ok,
        String(submittedAt),
      ).toBe(false);
    }
  });

  it("rejects an unrecognised rejection reason", () => {
    expect(validateRemoteDecisionState({
      kind: "rejected_by_host", reason: "because_i_said_so",
    }).ok).toBe(false);
  });

  it("rejects fields belonging to a different arm", () => {
    // A confirmed decision carrying a submittedAt is either a confused producer
    // or an attempt to have one record read as two different decisions.
    expect(validateRemoteDecisionState({
      kind: "confirmed",
      confirmedAt: "2026-08-23T12:00:00.000Z",
      submittedAt: "2026-08-23T12:00:00.000Z",
    }).ok).toBe(false);
    expect(validateRemoteDecisionState({ ...provisional, reason: "expired" }).ok).toBe(false);
  });
});
