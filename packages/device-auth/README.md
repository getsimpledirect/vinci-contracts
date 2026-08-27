# @getsimpledirect/vinci-device-auth

Device credential, pairing, relay-token, key-discovery, and revocation wire contracts. Validators check closed wire shapes and fail closed; signature verification remains the consumer's responsibility.

## Key directory

`KeyDirectoryRequest` and `KeyDirectoryResponse` define relay or host key lookup against Platform. The relay calls Platform to resolve issuer, device-signer, and host-signer key ids, validates responses with `validateKeyDirectoryResponse`, and grants verification authority only when `isKeyUsableAt` accepts the role, status, and validity window. `refreshAfter` is a cache re-fetch hint, not an extension of key validity.

## Revocation snapshots

The relay pulls Platform's signed `RevocationSnapshot` every 15 seconds, and the host may consume the same feed. Platform also pushes the same signed snapshot to relay instances for immediate propagation; push and pull do not use separate wire shapes. Consumers validate the closed snapshot, verify `revocationSnapshotSigningPayload` with a usable `platform-issuer` key, and apply it only when `isSnapshotNewer` is true.

## Relay access-token requests

A device sends `RelayAccessTokenRequest` to Platform to request a short-lived, relay-audience `RelayAccessToken`. Platform validates the request and signs the resulting token. The relay never calls the token-minting endpoint and never mints or extends a token; requests above `RELAY_ACCESS_TOKEN_MAX_LIFETIME_MS` are rejected rather than clamped.
