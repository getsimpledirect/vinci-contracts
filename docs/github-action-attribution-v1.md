# GitHub action attribution v1

`GitHubActionAttribution` is the signed, immutable answer to “which Vinci actor
caused this GitHub pull-request action?” It lives in
`@getsimpledirect/vinci-remote-protocol` because it binds the existing central
`Actor` to the existing `SessionBindingRef` and follows that package's signed
wire-envelope conventions. It does not add a GitHub-specific actor or a second
session identity.

The four actions are `pr.created`, `pr.head_updated`, `pr.review_submitted`, and
`pr.merge_recorded`. Every attribution identifies the repository by its stable
GitHub node id, then carries owner and repository name only as informational
labels. It also fixes the pull-request number and exact full lowercase head SHA.
The base SHA is optional for all four actions; a review node id is optional only
for `pr.review_submitted`; a merge commit SHA is optional only for
`pr.merge_recorded`. Missing optional provider data stays missing—an issuer must
not guess it.

## Trust and verification

The issuer must derive `actor` from authenticated server-side Vinci state and
must copy the already-established `SessionBindingRef`. It must never derive an
actor from the GitHub credential, commit author, pull-request author, display
name, request body, branch name, or caller-supplied actor field. The observed
GitHub credential is retained under `transport.sharedLogin` for operations only;
the adjacent literal `sharedLoginAuthoritative: false` makes its trust status
part of the signed wire record.

Validation is intentionally split into two steps:

1. `validateGitHubActionAttribution` snapshots hostile input, rejects every
   unknown field, enforces the action-dependent subject fields, validates the
   central actor and binding, requires canonical timestamps and identifiers,
   and requires a canonical 64-byte Ed25519 signature value.
2. The consumer resolves `issuerKeyId` through the existing key directory,
   requires a currently usable Ed25519 key with role `platform-issuer`, and
   verifies `githubActionAttributionSigningPayload(attribution)`. Shape
   validation alone is not signature verification.

The signing payload is the shared canonical JSON encoding in UTF-8. It covers
every semantic field and `signature.alg`, and excludes only `signature.value`.
`githubActionAttributionDigest` is SHA-256 of those exact bytes, so the digest
and signature cover the same meaning. Any actor, binding, action, GitHub
subject, transport, timestamp, idempotency key, issuer key id, or attribution id
change produces different signing bytes and a different digest.

GitHub comments, check summaries, commit bodies, and other text surfaces should
carry only:

```text
vinci-attribution: <attributionId>@sha256:<digest>
```

They must not carry a free-form actor name as attribution. The durable envelope
identified by that pointer is the record; the text surface is only a lookup and
integrity hint.

## Threat model

- **Shared-credential impersonation:** all actions may use one GitHub App or bot
  login. The login is signed as explicitly non-authoritative metadata; the
  central `Actor` is server-derived.
- **Caller-supplied identity:** a request may claim a different actor or inject
  GitHub-specific actor fields. Closed nested schemas reject those fields, and
  the issuer must ignore request identity claims in favor of authenticated
  session state.
- **Repository rename or transfer:** owner/name can change. Consumers key the
  GitHub subject by `repositoryNodeId`, never by the informational labels.
- **Branch movement and abbreviated SHAs:** a branch name or short SHA can point
  somewhere else later. The subject accepts only an exact full lowercase
  40-hex head SHA.
- **Replay and duplicate delivery:** `attributionId` is immutable and
  `idempotencyKey` records the delivery/operation identity. A repeated key is a
  retry only when the derived digest is identical; conflicting reuse must be
  rejected by the future issuer/store.
- **Tampering or pointer substitution:** Ed25519 covers the canonical record and
  the pointer carries the same record digest. Consumers must compare both id and
  digest before trusting a fetched envelope.
- **Key confusion or rotation:** `issuerKeyId` is not enough by itself. The
  resolved key must be Ed25519, usable at the verification policy's time, and
  carry the existing `platform-issuer` role.

This phase defines contracts only. It does not issue records, consume them in
Acceptance, post GitHub comments, deploy, merge, release, train/evaluate models,
or change infrastructure templates.
