import { describe, expect, it } from "vitest";
import { assertSchemaMetaComplete } from "@vinci/contracts";
import {
  BROADENING_COMMANDS,
  SESSION_ROLES,
  TIGHTENING_COMMANDS,
  isTightening,
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

  it("lets every acting role stop or restrict the worker", () => {
    // Reducing authority is safe by construction — the worst case is that work
    // stops, which is recoverable. Requiring an approval round trip before
    // someone can hit the brakes gets the trade backwards.
    for (const role of ["owner", "approver", "collaborator"] as const) {
      for (const command of TIGHTENING_COMMANDS) {
        expect(mayIssue(role, command), `${role} -> ${command}`).toBe(true);
      }
    }
  });

  it("classifies every tightening command as tightening, and nothing else", () => {
    for (const command of TIGHTENING_COMMANDS) expect(isTightening(command)).toBe(true);
    for (const command of ["send_message", "answer_question", "approve_pending_approval"] as const) {
      expect(isTightening(command)).toBe(false);
    }
  });

  it("gives a viewer no authority at all", () => {
    // A viewer that can steer is a collaborator with a misleading label.
    const everyCommand: RemoteCommandKind[] = [
      ...TIGHTENING_COMMANDS,
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
      expect(isTightening(bogus as never)).toBe(false);
    }
  });
});
