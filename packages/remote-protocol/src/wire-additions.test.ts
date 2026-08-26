import { describe, expect, it } from "vitest";
import { assertSchemaMetaComplete } from "@getsimpledirect/vinci-contracts";
import {
  AUTHORITY_COMMAND_ENVELOPE_SCHEMA_META,
  AUTHORITY_RESULT_ENVELOPE_SCHEMA_META,
  E2E_SUITE_V1,
  MAX_AUTHORITY_COMMAND_LIFETIME_MS,
  REMOTE_DECISION_REJECTIONS,
  REMOTE_DECISION_STATE_SCHEMA_META,
  REMOTE_PROTOCOL_VERSION,
  REPLAY_GAP_SCHEMA_META,
  SESSION_BINDING_REF_SCHEMA_META,
  SESSION_BINDING_SCHEMA_META,
  SESSION_KEY_WRAP_SCHEMA_META,
  authorityCommandSigningPayload,
  bindingRefMatches,
  validateAuthorityCommandEnvelope,
  validateAuthorityResultEnvelope,
  validateRemoteDecisionState,
  validateReplayGap,
  validateSessionBindingRef,
  validateSessionKeyWrap,
} from "./index.ts";

const NOW = "2026-08-26T12:05:00.000Z";
const SHA256 = "a".repeat(64);
const base64UrlBytes = (length: number): string => Buffer.alloc(length, 0xa5).toString("base64url");

const bindingRef = (overrides: Record<string, unknown> = {}) => ({
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  organizationId: null,
  workspaceId: "ws-1",
  runId: "run-1",
  sessionId: "sess-1",
  ...overrides,
});

const sessionBinding = (overrides: Record<string, unknown> = {}) => ({
  ...bindingRef(),
  schemaVersion: SESSION_BINDING_SCHEMA_META.version,
  hostDeviceId: "dev-1",
  policyId: "pol-1",
  policyVersion: 1,
  retentionClass: "zdr_0d",
  ...overrides,
});

const commandEnvelope = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: AUTHORITY_COMMAND_ENVELOPE_SCHEMA_META.version,
  commandId: "cmd-1",
  binding: bindingRef(),
  command: "pause",
  params: {},
  assertedRole: "owner",
  sequence: 0,
  idempotencyKey: "idem-1",
  issuedAt: "2026-08-26T12:00:00.000Z",
  expiresAt: "2026-08-26T12:10:00.000Z",
  signerKeyId: "device-key-1",
  signature: { alg: "Ed25519", value: "AQID" },
  ...overrides,
});

const resultEnvelope = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: AUTHORITY_RESULT_ENVELOPE_SCHEMA_META.version,
  commandId: "cmd-1",
  binding: bindingRef(),
  result: "confirmed",
  decidedAt: "2026-08-26T12:06:00.000Z",
  hostKeyId: "host-key-1",
  signature: { alg: "Ed25519", value: "AQID" },
  ...overrides,
});

function issueCodes(result: { readonly ok: boolean; readonly issues?: readonly { readonly code: string }[] }): string[] {
  return result.ok ? [] : (result.issues ?? []).map(({ code }) => code);
}

describe("SessionBindingRef is literal channel identity", () => {
  it("requires the minimal five-field identity including present-null organization", () => {
    expect(validateSessionBindingRef(bindingRef()).ok).toBe(true);
    expect(validateSessionBindingRef(bindingRef({ organizationId: "org-1" })).ok).toBe(true);

    const { organizationId: _removed, ...absent } = bindingRef();
    expect(issueCodes(validateSessionBindingRef(absent))).toContain("required_field");
    expect(issueCodes(validateSessionBindingRef(bindingRef({ protocolVersion: 2 })))).toContain("protocol_version_mismatch");
    expect(issueCodes(validateSessionBindingRef(bindingRef({ runId: "free text is forbidden" })))).toContain("invalid_id");
    expect(issueCodes(validateSessionBindingRef(bindingRef({ extra: true })))).toContain("unknown_field");
  });

  it("matches every identity field exactly and never treats absent as null", () => {
    expect(bindingRefMatches(bindingRef() as never, sessionBinding() as never)).toBe(true);
    for (const changed of [
      { protocolVersion: 2 },
      { organizationId: "org-1" },
      { workspaceId: "ws-2" },
      { runId: "run-2" },
      { sessionId: "sess-2" },
    ]) {
      expect(bindingRefMatches(bindingRef(changed) as never, sessionBinding() as never)).toBe(false);
    }
    const { organizationId: _removed, ...absent } = bindingRef();
    expect(bindingRefMatches(absent as never, sessionBinding() as never)).toBe(false);
  });

  it("refuses hostile values without throwing or manufacturing a match", () => {
    const hostile = JSON.parse('{"protocolVersion":1,"organizationId":null,"workspaceId":"ws-1","runId":"run-1","sessionId":"sess-1","__proto__":{"polluted":true}}');
    expect(() => bindingRefMatches(hostile, sessionBinding() as never)).not.toThrow();
    expect(bindingRefMatches(hostile, sessionBinding() as never)).toBe(false);
    expect(() => bindingRefMatches(bindingRef() as never, new Proxy({}, { get() { throw new Error("trap"); } }) as never)).not.toThrow();
  });
});

describe("AuthorityCommandEnvelope is a closed relay filter", () => {
  it.each([
    ["pause", {}, "owner"],
    ["restrict_to_read_only", {}, "collaborator"],
    ["abort", {}, "owner"],
    ["deny_pending_approval", { approvalId: "approval-1" }, "collaborator"],
    ["approve_pending_approval", { approvalId: "approval-1" }, "approver"],
    ["approve_pending_approval", { approvalId: "approval-1", narrowedGrantRefId: "grant-1" }, "owner"],
    ["answer_question", { questionId: "question-1", answerId: "answer-1" }, "collaborator"],
    ["send_message", { messageDigest: SHA256, byteCount: 123 }, "owner"],
  ])("accepts the closed %s params", (command, params, assertedRole) => {
    expect(validateAuthorityCommandEnvelope(commandEnvelope({ command, params, assertedRole }), NOW).ok).toBe(true);
  });

  it("drives every command-envelope rejection code", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["schema_version_mismatch", { schemaVersion: 2 }, "schema version"],
      ["invalid_id", { commandId: "not an id" }, "identifier"],
      ["invalid_command", { command: "grant_full_access" }, "unknown command"],
      ["invalid_role", { assertedRole: "superuser" }, "unknown role"],
      ["not_permitted", { command: "abort", assertedRole: "collaborator" }, "relay role filter"],
      ["invalid_sequence", { sequence: -0 }, "negative zero"],
      ["invalid_timestamp", { issuedAt: "2026-08-26T12:00:00Z" }, "canonical timestamp"],
      ["invalid_time_order", { expiresAt: "2026-08-26T12:00:00.000Z" }, "time order"],
      ["lifetime_exceeded", { expiresAt: "2026-08-26T12:10:00.001Z" }, "maximum lifetime"],
      ["expired", { issuedAt: "2026-08-26T11:50:00.000Z", expiresAt: "2026-08-26T12:00:00.000Z" }, "expiry"],
      ["invalid_signature_algorithm", { signature: { alg: "none", value: "AQID" } }, "algorithm"],
      ["invalid_base64url", { signature: { alg: "Ed25519", value: "not+url" } }, "signature syntax"],
      ["invalid_digest", { command: "send_message", params: { messageDigest: "raw message", byteCount: 3 } }, "message digest"],
      ["invalid_count", { command: "send_message", params: { messageDigest: SHA256, byteCount: -1 } }, "byte count"],
      ["unknown_field", { params: { freeText: "never" } }, "closed params"],
    ];
    for (const [code, overrides, label] of cases) {
      expect(issueCodes(validateAuthorityCommandEnvelope(commandEnvelope(overrides), NOW)), label).toContain(code);
    }
    expect(issueCodes(validateAuthorityCommandEnvelope(commandEnvelope(), "not-a-time"))).toContain("invalid_validation_time");
  });

  it("rejects every command/params mismatch and never carries free text", () => {
    const mismatches = [
      { command: "pause", params: { approvalId: "approval-1" } },
      { command: "deny_pending_approval", params: {} },
      { command: "approve_pending_approval", params: { approvalId: "approval-1", answerId: "answer-1" } },
      { command: "answer_question", params: { questionId: "question-1", answer: "free text" } },
      { command: "send_message", params: { messageDigest: SHA256, byteCount: 3, message: "free text" } },
    ];
    for (const mismatch of mismatches) {
      expect(validateAuthorityCommandEnvelope(commandEnvelope(mismatch), NOW).ok, mismatch.command).toBe(false);
    }
  });

  it("rejects NaN and every invalid sequence boundary", () => {
    for (const sequence of [Number.NaN, -0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(validateAuthorityCommandEnvelope(commandEnvelope({ sequence }), NOW).ok, String(sequence)).toBe(false);
    }
    expect(validateAuthorityCommandEnvelope(commandEnvelope({ sequence: Number.MAX_SAFE_INTEGER }), NOW).ok).toBe(true);
  });

  it("pins the ten-minute lifetime constant and boundary", () => {
    expect(MAX_AUTHORITY_COMMAND_LIFETIME_MS).toBe(600_000);
    expect(validateAuthorityCommandEnvelope(commandEnvelope(), NOW).ok).toBe(true);
    expect(validateAuthorityCommandEnvelope(commandEnvelope({ expiresAt: "2026-08-26T12:10:00.001Z" }), NOW).ok).toBe(false);
  });

  it("canonicalizes stable unsigned UTF-8 bytes and excludes the signature", () => {
    const first = validateAuthorityCommandEnvelope(commandEnvelope(), NOW);
    const second = validateAuthorityCommandEnvelope({
      signature: { value: "BAUG", alg: "Ed25519" },
      expiresAt: "2026-08-26T12:10:00.000Z",
      issuedAt: "2026-08-26T12:00:00.000Z",
      idempotencyKey: "idem-1",
      sequence: 0,
      assertedRole: "owner",
      params: {},
      command: "pause",
      binding: bindingRef(),
      commandId: "cmd-1",
      signerKeyId: "device-key-1",
      schemaVersion: 1,
    }, NOW);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const a = authorityCommandSigningPayload(first.value);
    const b = authorityCommandSigningPayload(second.value);
    expect(a).toEqual(b);
    const text = new TextDecoder().decode(a);
    expect(text).not.toContain("signature");
    expect(text).toContain('"command":"pause"');
  });

  it("changes signing bytes for every covered authority field but not signature.value", () => {
    const validated = (overrides: Record<string, unknown> = {}) => {
      const result = validateAuthorityCommandEnvelope(commandEnvelope(overrides), NOW);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("test fixture must validate");
      return authorityCommandSigningPayload(result.value);
    };
    const baseline = validated();
    for (const [field, overrides] of [
      ["command", { command: "restrict_to_read_only" }],
      ["binding.runId", { binding: bindingRef({ runId: "run-2" }) }],
      ["sequence", { sequence: 1 }],
      ["expiresAt", { expiresAt: "2026-08-26T12:09:00.000Z" }],
    ] as const) {
      expect(validated(overrides), field).not.toEqual(baseline);
    }
    expect(validated({ signature: { alg: "Ed25519", value: "BAUG" } })).toEqual(baseline);
  });

  it("judges expiry deterministically against the required caller-supplied now", () => {
    const envelope = commandEnvelope();
    const beforeExpiry = validateAuthorityCommandEnvelope(envelope, "2026-08-26T12:09:59.999Z");
    const atExpiry = validateAuthorityCommandEnvelope(envelope, "2026-08-26T12:10:00.000Z");
    expect(beforeExpiry.ok).toBe(true);
    expect(issueCodes(atExpiry)).toContain("expired");
    expect(validateAuthorityCommandEnvelope(envelope, "2026-08-26T12:10:00.000Z")).toEqual(atExpiry);
  });

  it("does not confuse shape validation with signature verification", () => {
    expect(validateAuthorityCommandEnvelope(commandEnvelope({ signature: { alg: "Ed25519", value: "AAAA" } }), NOW).ok).toBe(true);
  });
});

describe("AuthorityResultEnvelope carries the host decision", () => {
  it("requires rejection exactly when rejected_by_host", () => {
    expect(validateAuthorityResultEnvelope(resultEnvelope()).ok).toBe(true);
    expect(validateAuthorityResultEnvelope(resultEnvelope({ result: "provisional" })).ok).toBe(true);
    for (const rejection of REMOTE_DECISION_REJECTIONS) {
      expect(validateAuthorityResultEnvelope(resultEnvelope({ result: "rejected_by_host", rejection })).ok, rejection).toBe(true);
    }
    expect(issueCodes(validateAuthorityResultEnvelope(resultEnvelope({ result: "rejected_by_host" })))).toContain("invalid_rejection");
    expect(issueCodes(validateAuthorityResultEnvelope(resultEnvelope({ rejection: "expired" })))).toContain("unexpected_rejection");
    expect(issueCodes(validateAuthorityResultEnvelope(resultEnvelope({ result: "invented" })))).toContain("invalid_result");
  });

  it("makes credential_revoked and binding_mismatch real rejection reasons", () => {
    expect(REMOTE_DECISION_REJECTIONS).toContain("credential_revoked");
    expect(REMOTE_DECISION_REJECTIONS).toContain("binding_mismatch");
    for (const reason of ["credential_revoked", "binding_mismatch"] as const) {
      expect(validateRemoteDecisionState({ kind: "rejected_by_host", reason }).ok).toBe(true);
    }
  });

  it("rejects malformed host fields and does not verify cryptography", () => {
    expect(issueCodes(validateAuthorityResultEnvelope(resultEnvelope({ decidedAt: "today" })))).toContain("invalid_timestamp");
    expect(issueCodes(validateAuthorityResultEnvelope(resultEnvelope({ signature: { alg: "RSA", value: "AQID" } })))).toContain("invalid_signature_algorithm");
    expect(validateAuthorityResultEnvelope(resultEnvelope({ signature: { alg: "Ed25519", value: "AAAA" } })).ok).toBe(true);
  });
});

describe("ReplayGap is a control-plane range", () => {
  const gap = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: REPLAY_GAP_SCHEMA_META.version,
    binding: bindingRef(),
    requestedSeq: 3,
    oldestAvailableSeq: 4,
    newestAvailableSeq: 9,
    ...overrides,
  });

  it("enforces requested < oldest <= newest", () => {
    expect(validateReplayGap(gap()).ok).toBe(true);
    expect(validateReplayGap(gap({ oldestAvailableSeq: 9, newestAvailableSeq: 9 })).ok).toBe(true);
    for (const overrides of [
      { requestedSeq: 4 },
      { oldestAvailableSeq: 10 },
      { requestedSeq: 9, oldestAvailableSeq: 9, newestAvailableSeq: 9 },
    ]) {
      expect(issueCodes(validateReplayGap(gap(overrides)))).toContain("invalid_replay_gap");
    }
  });

  it("rejects malformed sequences", () => {
    for (const requestedSeq of [-0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(issueCodes(validateReplayGap(gap({ requestedSeq })))).toContain("invalid_sequence");
    }
  });
});

describe("the E2E suite and key wrap are data, not cryptography", () => {
  const wrap = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: SESSION_KEY_WRAP_SCHEMA_META.version,
    binding: bindingRef(),
    suiteId: E2E_SUITE_V1.id,
    recipientDeviceId: "device-1",
    recipientKeyId: "key-1",
    ephemeralPublicKey: base64UrlBytes(32),
    wrappedKey: "BAUG",
    createdAt: "2026-08-26T12:00:00.000Z",
    ...overrides,
  });

  it("pins the mandatory suite as an exact data record", () => {
    expect(E2E_SUITE_V1).toEqual({
      id: "vinci-e2e-1",
      keyAgreement: "X25519",
      signature: "Ed25519",
      aead: "XChaCha20-Poly1305",
      kdf: "HKDF-SHA-256",
    });
    expect(validateSessionKeyWrap(wrap()).ok).toBe(true);
  });

  it("drives key-wrap rejection codes", () => {
    expect(issueCodes(validateSessionKeyWrap(wrap({ suiteId: "private-suite" })))).toContain("unsupported_suite");
    expect(issueCodes(validateSessionKeyWrap(wrap({ recipientDeviceId: "free text" })))).toContain("invalid_id");
    expect(issueCodes(validateSessionKeyWrap(wrap({ ephemeralPublicKey: "not+url" })))).toContain("invalid_base64url");
    expect(issueCodes(validateSessionKeyWrap(wrap({ createdAt: "today" })))).toContain("invalid_timestamp");
    expect(issueCodes(validateSessionKeyWrap(wrap({ plaintextKey: "secret" })))).toContain("unknown_field");
  });

  it("requires a canonical 32-byte X25519 key and bounds wrappedKey to 64 bytes", () => {
    for (const length of [31, 33]) {
      expect(issueCodes(validateSessionKeyWrap(wrap({ ephemeralPublicKey: base64UrlBytes(length) })))).toContain("invalid_public_key_length");
    }
    expect(issueCodes(validateSessionKeyWrap(wrap({ ephemeralPublicKey: `${base64UrlBytes(32)}=` })))).toContain("invalid_base64url");
    expect(validateSessionKeyWrap(wrap({ wrappedKey: base64UrlBytes(64) })).ok).toBe(true);
    expect(issueCodes(validateSessionKeyWrap(wrap({ wrappedKey: base64UrlBytes(65) })))).toContain("wrapped_key_too_large");
  });
});

describe("new schema metadata answers every compatibility question", () => {
  it("is complete, closed, and explicit about the v2 rejection migration", () => {
    const metas = [
      SESSION_BINDING_REF_SCHEMA_META,
      AUTHORITY_COMMAND_ENVELOPE_SCHEMA_META,
      AUTHORITY_RESULT_ENVELOPE_SCHEMA_META,
      REPLAY_GAP_SCHEMA_META,
      SESSION_KEY_WRAP_SCHEMA_META,
      REMOTE_DECISION_STATE_SCHEMA_META,
    ];
    for (const meta of metas) {
      expect(() => assertSchemaMetaComplete(meta), meta.id).not.toThrow();
      expect(meta.unknownFields, meta.id).toBe("reject");
    }
    expect(REMOTE_DECISION_STATE_SCHEMA_META.version).toBe(2);
    expect(REMOTE_DECISION_STATE_SCHEMA_META.migration).not.toBe("none");
  });
});
