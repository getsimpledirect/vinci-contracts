#!/usr/bin/env node
/**
 * Regenerate the ReviewPublicationAttribution v1 cross-language vector.
 *
 * Run after `npm run build`. The private key is the fixed RFC 8032 test seed;
 * it exists only to make the fixture reproducible and is never an issuer key.
 */
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatReviewPublicationReference,
  reviewPublicationAttributionDigest,
  reviewPublicationAttributionSigningPayload,
} from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const seed = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
  format: "der",
  type: "pkcs8",
});
const publicDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
const publicKey = publicDer.subarray(publicDer.length - 32).toString("base64url");

const unsigned = {
  schemaVersion: 1,
  purpose: "guard_review.publish",
  audience: "vinci-acceptance",
  actor: { kind: "verifier", verifierId: "verifier-01JTEST", independent: true },
  binding: {
    protocolVersion: 1,
    organizationId: "organization-1",
    workspaceId: "workspace-1",
    runId: "review-run-1",
    sessionId: "session-1",
  },
  subject: {
    provider: "github",
    repositoryNodeId: "R_kgDOExample",
    pullRequestNumber: 10,
    headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    headTreeSha: "cccccccccccccccccccccccccccccccccccccccc",
  },
  verdict: "GO",
  recordSetDigest: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  idempotencyKey: "review-publication-01JTEST",
  issuedAt: "2026-09-04T12:00:00.000Z",
  expiresAt: "2026-09-04T12:10:00.000Z",
  issuerKeyId: "vgc-platform-key-1",
  signature: { alg: "Ed25519", value: "" },
};
const payload = reviewPublicationAttributionSigningPayload(unsigned);
const signature = sign(null, payload, privateKey).toString("base64url");
const attribution = { ...unsigned, signature: { alg: "Ed25519", value: signature } };
const digest = reviewPublicationAttributionDigest(attribution);
const publicationDigest = createHash("sha256")
  .update("guard-review-publication-vector-v1", "utf8")
  .digest("hex");
const pointer = formatReviewPublicationReference("grv_01JTEST", publicationDigest);
if (!pointer.ok) throw new Error("the generator constructed an invalid review reference");
const changed = (overrides) => JSON.stringify({ ...attribution, ...overrides });
const invalid = [
  { name: "wrong purpose", code: "invalid_purpose", input: changed({ purpose: "guard_review.read" }) },
  { name: "wrong audience", code: "invalid_audience", input: changed({ audience: "vinci-governor" }) },
  { name: "wrong verdict", code: "invalid_verdict", input: changed({ verdict: "VERIFIED_PASS" }) },
  { name: "uppercase record digest", code: "invalid_digest", input: changed({ recordSetDigest: "D".repeat(64) }) },
  { name: "invalid idempotency key", code: "invalid_id", input: changed({ idempotencyKey: "has space" }) },
  { name: "wrong provider", code: "invalid_provider", input: changed({ subject: { ...attribution.subject, provider: "gitlab" } }) },
  { name: "abbreviated head", code: "invalid_git_sha", input: changed({ subject: { ...attribution.subject, headSha: "abc123" } }) },
  { name: "reversed time", code: "invalid_time_order", input: changed({ expiresAt: attribution.issuedAt }) },
  { name: "lifetime over bound", code: "lifetime_exceeded", input: changed({ expiresAt: "2026-09-04T12:10:00.001Z" }) },
  { name: "duplicate decoded key", code: "duplicate_field", input: JSON.stringify(attribution).replace('{"schemaVersion":1,', '{"schemaVersion":1,"schema\\u0056ersion":1,') },
  { name: "unsafe integer", code: "unsafe_integer", input: JSON.stringify(attribution).replace('"pullRequestNumber":10', '"pullRequestNumber":9007199254740992') },
  { name: "fractional integer spelling", code: "ambiguous_number", input: JSON.stringify(attribution).replace('"pullRequestNumber":10', '"pullRequestNumber":10.0') },
  { name: "non-NFC identity", code: "non_canonical_unicode", input: changed({ actor: { kind: "verifier", verifierId: "e\u0301", independent: true } }) },
];

writeFileSync(join(here, "valid-v1.json"), `${JSON.stringify(attribution, null, 2)}\n`);
writeFileSync(join(here, "invalid-v1.json"), `${JSON.stringify(invalid, null, 2)}\n`);
writeFileSync(join(here, "canonical.txt"), payload);
writeFileSync(join(here, "digest.txt"), `${digest}\n`);
writeFileSync(join(here, "public-key.txt"), `${publicKey}\n`);
writeFileSync(join(here, "signature.txt"), `${signature}\n`);
writeFileSync(join(here, "pointer.txt"), `${pointer.value}\n`);
console.log(`review-publication-attribution-v1: ${digest}`);
