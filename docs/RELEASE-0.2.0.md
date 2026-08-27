# 0.2.0 — relay↔Platform contract

Lockstep bump of all twelve packages from 0.1.0 to 0.2.0. Additive only; every 0.1.0 wire shape validates unchanged.

New in `@getsimpledirect/vinci-device-auth` (#18):
- **Key directory** — `KeyDirectoryRequest` / `KeyDirectoryEntry` / `KeyDirectoryResponse`, `validateKeyDirectoryResponse(input, now)`, `isKeyUsableAt(entry, now, role)`. Entries carry a key **role** (`platform-issuer` | `device-signer` | `host-signer`); `validFrom` inclusive, `validUntil` exclusive (as credential expiry), `supersededBy`, `refreshAfter`.
- **Signed revocation snapshot** — `RevocationSnapshot` (monotonic integer `version`, `issuerKeyId`, Ed25519 signature), `validateRevocationSnapshot`, `revocationSnapshotSigningPayload` (covers every semantic field and `signature.alg`; excludes the signature value), `isSnapshotNewer` (strictly greater).
- **Relay access token request** — `RelayAccessTokenRequest`, `validateRelayAccessTokenRequest`; a requested lifetime above the 10-minute ceiling is rejected, not clamped.

Consumers: `vinci-relay` and `vinci-acceptance` pin `0.1.0` today and keep working; they move to `0.2.0` in their own PRs (`vinci-relay` needs it for the Platform client).

Release mechanics: tag `v0.2.0` on the merged head of this PR (release.yml publishes to GitHub Packages on the tag; the tag and the manifests must agree).
