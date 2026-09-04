import { generateKeyPairSync, sign, verify } from "node:crypto";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { assertSchemaMetaComplete } from "@getsimpledirect/vinci-contracts";
import {
  AUTHORITY_COMMAND_ENVELOPE_SCHEMA_META,
  GITHUB_ACTION_ATTRIBUTION_SCHEMA_META,
  GITHUB_ATTRIBUTION_ACTIONS,
  REMOTE_PROTOCOL_VERSION,
  githubActionAttributionDigest,
  githubActionAttributionPointer,
  githubActionAttributionSigningPayload,
  validateAuthorityCommandEnvelope,
  validateGitHubActionAttribution,
  validateGitHubActionAttributionPointer,
  type GitHubActionAttribution,
} from "./index.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SIGNATURE = Buffer.alloc(64, 0xa5).toString("base64url");

const binding = (overrides: Record<string, unknown> = {}) => ({
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  organizationId: null,
  workspaceId: "workspace-1",
  runId: "run-1",
  sessionId: "session-1",
  ...overrides,
});

const attribution = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  attributionId: "attr-01JTEST",
  binding: binding(),
  action: "pr.created",
  actor: { kind: "user", userId: "user-1" },
  subject: {
    repositoryNodeId: "R_kgDOExample",
    repositoryOwner: "getsimpledirect",
    repositoryName: "vinci-contracts",
    pullRequestNumber: 44,
    headSha: SHA_A,
  },
  transport: {
    provider: "github",
    sharedLogin: "github-actions[bot]",
    sharedLoginAuthoritative: false,
  },
  issuedAt: "2026-09-04T10:00:00.000Z",
  idempotencyKey: "github-delivery-1",
  issuerKeyId: "platform-key-1",
  signature: { alg: "Ed25519", value: SIGNATURE },
  ...overrides,
});

function issueCodes(result: { readonly ok: boolean; readonly issues?: readonly { readonly code: string }[] }): string[] {
  return result.ok ? [] : (result.issues ?? []).map(({ code }) => code);
}

function validated(overrides: Record<string, unknown> = {}): GitHubActionAttribution {
  const result = validateGitHubActionAttribution(attribution(overrides));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("test fixture must validate");
  return result.value;
}

describe("GitHubActionAttribution v1", () => {
  it("accepts exactly the four actions and their applicable optional identifiers", () => {
    const cases = [
      { action: "pr.created", subject: { ...attribution().subject, baseSha: SHA_B } },
      { action: "pr.head_updated", subject: { ...attribution().subject, baseSha: SHA_B } },
      { action: "pr.review_submitted", subject: { ...attribution().subject, reviewNodeId: "PRR_kwDOExample" } },
      { action: "pr.merge_recorded", subject: { ...attribution().subject, mergeCommitSha: SHA_B } },
    ];
    expect(cases.map((entry) => entry.action)).toEqual(GITHUB_ATTRIBUTION_ACTIONS);
    for (const entry of cases) {
      expect(validateGitHubActionAttribution(attribution(entry)).ok, entry.action).toBe(true);
    }

    // Optional means absent stays honest; issuers do not invent missing provider data.
    expect(validateGitHubActionAttribution(attribution({ action: "pr.review_submitted" })).ok).toBe(true);
    expect(validateGitHubActionAttribution(attribution({ action: "pr.merge_recorded" })).ok).toBe(true);
  });

  it("keeps GitHub's shared login outside the central Actor union", () => {
    expect(validateGitHubActionAttribution(attribution({
      actor: { kind: "system", component: "vinci-governance-cloud" },
    })).ok).toBe(true);
    expect(issueCodes(validateGitHubActionAttribution(attribution({
      actor: { kind: "github", login: "github-actions[bot]" },
    })))).toContain("invalid_actor");
    expect(issueCodes(validateGitHubActionAttribution(attribution({
      transport: { provider: "github", sharedLogin: "github-actions[bot]", sharedLoginAuthoritative: true },
    })))).toContain("transport_identity_forbidden");
    const { actor: _actor, ...withoutActor } = attribution();
    expect(issueCodes(validateGitHubActionAttribution(withoutActor))).toContain("invalid_actor");
  });

  it("rejects identifiers on actions where they have no meaning", () => {
    expect(issueCodes(validateGitHubActionAttribution(attribution({
      action: "pr.created",
      subject: { ...attribution().subject, reviewNodeId: "PRR_kwDOExample" },
    })))).toContain("unknown_field");
    expect(issueCodes(validateGitHubActionAttribution(attribution({
      action: "pr.review_submitted",
      subject: { ...attribution().subject, mergeCommitSha: SHA_B },
    })))).toContain("unknown_field");
    expect(issueCodes(validateGitHubActionAttribution(attribution({
      action: "pr.merge_recorded",
      subject: { ...attribution().subject, reviewNodeId: "PRR_kwDOExample" },
    })))).toContain("unknown_field");
  });

  it("drives the strict scalar, nested, and signature rejection rules", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["schema_version_mismatch", { schemaVersion: 2 }],
      ["invalid_id", { attributionId: "not an id" }],
      ["invalid_action", { action: "issue.created" }],
      ["invalid_timestamp", { issuedAt: "2026-09-04T10:00:00Z" }],
      ["invalid_signature_algorithm", { signature: { alg: "none", value: SIGNATURE } }],
      ["invalid_signature_value", { signature: { alg: "Ed25519", value: "AQID" } }],
      ["invalid_provider", { transport: { provider: "gitlab", sharedLogin: "bot", sharedLoginAuthoritative: false } }],
      ["invalid_shared_login", { transport: { provider: "github", sharedLogin: "\n", sharedLoginAuthoritative: false } }],
      ["invalid_git_sha", { subject: { ...attribution().subject, headSha: "abc123" } }],
      ["invalid_git_sha", { subject: { ...attribution().subject, headSha: "A".repeat(40) } }],
      ["invalid_pull_request_number", { subject: { ...attribution().subject, pullRequestNumber: 0 } }],
      ["protocol_version_mismatch", { binding: binding({ protocolVersion: 2 }) }],
      ["unknown_field", { githubActor: "shared-login" }],
      ["unknown_field", { subject: { ...attribution().subject, branch: "main" } }],
      ["unknown_field", { signature: { alg: "Ed25519", value: SIGNATURE, key: "secret" } }],
    ];
    for (const [code, overrides] of cases) {
      expect(issueCodes(validateGitHubActionAttribution(attribution(overrides))), code).toContain(code);
    }
  });

  it("requires an exact full head SHA and safe positive PR number", () => {
    for (const pullRequestNumber of [-0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(validateGitHubActionAttribution(attribution({
        subject: { ...attribution().subject, pullRequestNumber },
      })).ok, String(pullRequestNumber)).toBe(false);
    }
    expect(validateGitHubActionAttribution(attribution({
      subject: { ...attribution().subject, pullRequestNumber: Number.MAX_SAFE_INTEGER },
    })).ok).toBe(true);
    for (const headSha of [SHA_A.slice(1), `${SHA_A}0`, "main", "A".repeat(40)]) {
      expect(validateGitHubActionAttribution(attribution({
        subject: { ...attribution().subject, headSha },
      })).ok, headSha).toBe(false);
    }
  });

  it("returns one deep immutable snapshot and refuses hostile objects without throwing", () => {
    const input = attribution();
    const result = validateGitHubActionAttribution(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.actor)).toBe(true);
    expect(Object.isFrozen(result.value.subject)).toBe(true);
    input.subject.repositoryName = "changed-after-validation";
    expect(result.value.subject.repositoryName).toBe("vinci-contracts");

    const hostile = JSON.parse(JSON.stringify(attribution()).replace(
      '"headSha"',
      '"__proto__":{"polluted":true},"headSha"',
    ));
    expect(() => validateGitHubActionAttribution(hostile)).not.toThrow();
    expect(issueCodes(validateGitHubActionAttribution(hostile))).toContain("forbidden_key");
    const proxy = new Proxy({}, { ownKeys() { throw new Error("trap"); } });
    expect(() => validateGitHubActionAttribution(proxy)).not.toThrow();
    expect(validateGitHubActionAttribution(proxy).ok).toBe(false);
  });
});

describe("canonical digest, Ed25519 signature, and compact pointer", () => {
  it("pins canonical bytes independently of input key order and signature value", () => {
    const first = validated();
    const secondResult = validateGitHubActionAttribution({
      signature: { value: Buffer.alloc(64, 0x5a).toString("base64url"), alg: "Ed25519" },
      issuerKeyId: "platform-key-1",
      idempotencyKey: "github-delivery-1",
      issuedAt: "2026-09-04T10:00:00.000Z",
      transport: { sharedLoginAuthoritative: false, sharedLogin: "github-actions[bot]", provider: "github" },
      subject: {
        headSha: SHA_A,
        pullRequestNumber: 44,
        repositoryName: "vinci-contracts",
        repositoryOwner: "getsimpledirect",
        repositoryNodeId: "R_kgDOExample",
      },
      actor: { userId: "user-1", kind: "user" },
      action: "pr.created",
      binding: {
        sessionId: "session-1",
        runId: "run-1",
        workspaceId: "workspace-1",
        organizationId: null,
        protocolVersion: 1,
      },
      attributionId: "attr-01JTEST",
      schemaVersion: 1,
    });
    expect(secondResult.ok).toBe(true);
    if (!secondResult.ok) return;
    const second = secondResult.value;
    expect(githubActionAttributionSigningPayload(first)).toEqual(githubActionAttributionSigningPayload(second));
    expect(githubActionAttributionDigest(first)).toBe(githubActionAttributionDigest(second));
    expect(new TextDecoder().decode(githubActionAttributionSigningPayload(first))).toBe(
      `{"action":"pr.created","actor":{"kind":"user","userId":"user-1"},"attributionId":"attr-01JTEST","binding":{"organizationId":null,"protocolVersion":1,"runId":"run-1","sessionId":"session-1","workspaceId":"workspace-1"},"idempotencyKey":"github-delivery-1","issuedAt":"2026-09-04T10:00:00.000Z","issuerKeyId":"platform-key-1","schemaVersion":1,"signature":{"alg":"Ed25519"},"subject":{"headSha":"${SHA_A}","pullRequestNumber":44,"repositoryName":"vinci-contracts","repositoryNodeId":"R_kgDOExample","repositoryOwner":"getsimpledirect"},"transport":{"provider":"github","sharedLogin":"github-actions[bot]","sharedLoginAuthoritative":false}}`,
    );
  });

  it("covers every semantic compartment in the digest", () => {
    const baseline = githubActionAttributionDigest(validated());
    const changes: Array<[string, Record<string, unknown>]> = [
      ["attributionId", { attributionId: "attr-02JTEST" }],
      ["binding", { binding: binding({ runId: "run-2" }) }],
      ["action", { action: "pr.head_updated" }],
      ["actor", { actor: { kind: "worker", workerId: "worker-1" } }],
      ["subject", { subject: { ...attribution().subject, pullRequestNumber: 45 } }],
      ["transport", { transport: { ...attribution().transport, sharedLogin: "vinci-bot" } }],
      ["issuedAt", { issuedAt: "2026-09-04T10:00:00.001Z" }],
      ["idempotencyKey", { idempotencyKey: "github-delivery-2" }],
      ["issuerKeyId", { issuerKeyId: "platform-key-2" }],
    ];
    for (const [field, overrides] of changes) {
      expect(githubActionAttributionDigest(validated(overrides)), field).not.toBe(baseline);
    }
  });

  it("verifies an Ed25519 signature and makes semantic tampering detectable", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const unsigned = validated();
    const value = sign(null, githubActionAttributionSigningPayload(unsigned), privateKey).toString("base64url");
    const signed = validated({ signature: { alg: "Ed25519", value } });
    expect(verify(null, githubActionAttributionSigningPayload(signed), publicKey, Buffer.from(value, "base64url"))).toBe(true);

    const tampered = validated({
      signature: { alg: "Ed25519", value },
      subject: { ...attribution().subject, headSha: SHA_B },
    });
    expect(verify(null, githubActionAttributionSigningPayload(tampered), publicKey, Buffer.from(value, "base64url"))).toBe(false);
    expect(githubActionAttributionDigest(tampered)).not.toBe(githubActionAttributionDigest(signed));
  });

  it("emits and strictly validates only the compact digest pointer", () => {
    const value = validated();
    const pointer = githubActionAttributionPointer(value);
    expect(pointer).toBe(`vinci-attribution: attr-01JTEST@sha256:${githubActionAttributionDigest(value)}`);
    const parsed = validateGitHubActionAttributionPointer(pointer);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      attributionId: "attr-01JTEST",
      digest: githubActionAttributionDigest(value),
    });
    for (const malformed of [
      `vinci-attribution: attr-01JTEST@sha256:${"A".repeat(64)}`,
      `vinci-attribution: George@${githubActionAttributionDigest(value)}`,
      `vinci-attribution: attr-01JTEST @sha256:${githubActionAttributionDigest(value)}`,
      `${pointer}\nactor: George`,
      { pointer },
    ]) {
      expect(validateGitHubActionAttributionPointer(malformed).ok).toBe(false);
    }
  });
});

describe("compatibility and schema policy", () => {
  it("adds a frozen v1 schema without changing existing authority envelopes", () => {
    expect(() => assertSchemaMetaComplete(GITHUB_ACTION_ATTRIBUTION_SCHEMA_META)).not.toThrow();
    expect(GITHUB_ACTION_ATTRIBUTION_SCHEMA_META).toEqual({
      id: "vinci.github-action-attribution",
      version: 1,
      compatibility: "frozen",
      unknownFields: "reject",
      malformedData: "fail-closed",
      migration: "none",
    });
    expect(AUTHORITY_COMMAND_ENVELOPE_SCHEMA_META.version).toBe(1);
    const command = {
      schemaVersion: 1,
      commandId: "cmd-1",
      binding: binding(),
      command: "pause",
      params: {},
      assertedRole: "owner",
      sequence: 0,
      idempotencyKey: "idem-1",
      issuedAt: "2026-09-04T10:00:00.000Z",
      expiresAt: "2026-09-04T10:10:00.000Z",
      signerKeyId: "device-key-1",
      signature: { alg: "Ed25519", value: "AQID" },
    };
    expect(validateAuthorityCommandEnvelope(command, "2026-09-04T10:05:00.000Z").ok).toBe(true);
    expect(issueCodes(validateAuthorityCommandEnvelope({ ...command, actor: { kind: "user", userId: "u" } }, "2026-09-04T10:05:00.000Z"))).toContain("unknown_field");
  });
});
