# Remote protocol contracts

## ReviewPublicationAttribution v1

`ReviewPublicationAttribution` is the signed transport contract between Vinci
Governance Cloud (VGC) and Vinci Acceptance for a guard-review publication. It
binds the central `Actor`, complete `SessionBindingRef`, exact GitHub repository
node/PR/head/base/tree snapshot, `GO | BLOCK` verdict, record-set digest,
idempotency key, audience, purpose, lifetime and issuer key ID into one Ed25519
signing payload.

This package grants no authority. In particular, successful parsing, schema
validation, digest calculation, or raw signature verification does not prove
that a caller may publish a review.

Runtime VGC must derive the organization, workspace, run, session, Actor and
verifier-independence claim from authenticated server-side state. It must not
copy those claims from client input. VGC must also resolve the stable GitHub
repository node ID and exact PR head/base/tree before signing.

Vinci Acceptance must independently:

- authenticate its service/API caller and tenant;
- resolve `issuerKeyId` to a currently usable VGC `platform-issuer` Ed25519 key;
- verify the attribution signature, audience, purpose, lifetime and complete
  binding against trusted server state;
- re-resolve the GitHub repository and PR snapshot;
- recompute the record-set digest from validated snapshots; and
- apply its own publication, replay, retention and idempotency rules.

The compact publication reference has exactly this grammar:

```text
grv_<id>@sha256:<64 lowercase hexadecimal publication digest>
```

It is a content-addressed reference returned by Acceptance. It is not the
attribution digest and is not a Governor decision or merge authorization.
Governor policy remains a distinct layer and must independently decide whether
the referenced evidence is sufficient for the current repository state.

The TypeScript and Python implementations share the files under `vectors/`.
Those vectors pin the canonical UTF-8 signing bytes, SHA-256 attribution digest,
Ed25519 signature/public key, and compact reference. The Python suite is invoked
from the TypeScript test so the normal repository gate runs both languages.

Both language boundaries accept canonical timestamps only in ISO-8601 years
`0001` through `9999`; year zero is rejected. They share an inclusive ten-minute
maximum lifetime and exclusive expiry comparison.

Strict signed JSON ingress is bounded identically in both implementations:

- 1,000,000 UTF-8 bytes per input;
- 32 nested levels;
- 200,000 JSON values;
- 10,000 members per object or array; and
- 262,144 UTF-8 bytes per decoded string.

Depth, width, node, string, cycle, and parser-recursion failures are contract
refusals rather than uncaught runtime exceptions. Python direct-object validation
also rejects foreign fields before walking their values and tracks active object
identities so cycles cannot escape as `RecursionError`.

The TypeScript signing, digest, and verification helpers normalize a direct
object exactly once before checking timestamps or constructing signed bytes.
Verification reads both the signature and its payload from that same inert
snapshot, so stateful accessors cannot make validation and verification observe
different claims.
