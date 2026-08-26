# `vinci-relay` design

Status: Wave 1 design. `vinci-relay` is a small private transport service between an outbound host and authorized supervising devices. It consumes the contracts in this repository; it does not redefine them.

## 1. Non-goals

These limits come first because crossing any one of them would turn a transport into an authority or content system.

- The relay makes no authority decision. It filters commands with `mayIssue`, but only the host can accept a command.
- The relay does not evaluate policy. Autonomy rungs, host/policy-classified reversibility, and `evaluatePolicyDecision` remain host concerns ([`autonomy.ts`](../packages/policy/src/autonomy.ts), [`decision.ts`](../packages/policy/src/decision.ts), [`evaluation.ts`](../packages/policy/src/evaluation.ts), [E0 D6 and D11](E0-decisions.md#d6--the-five-policy-matching-decisions-ratified)).
- The relay does not verify work, evidence, receipts, or verdicts.
- The relay is not a transcript warehouse. It never promotes session frames into run history; the contracts deliberately separate ephemeral display transport from durable, content-minimal events ([`session-stream/src/index.ts`](../packages/session-stream/src/index.ts), [E0 D7](E0-decisions.md#d7--session-frames-are-ephemeral-display-transport-not-run-history)).
- Chain-of-thought never transits or persists. It is absent from the closed session-frame vocabulary ([`frame-types.ts`](../packages/session-stream/src/frame-types.ts)).
- The relay is not a product surface. Mobile, Web, and Vinci Code own presentation, timers, local warnings, and recovery affordances.

## 2. Topology and lifecycle

### Connections

The host opens one outbound TLS WebSocket to the relay. The host listens on no inbound port. Mobile and Web open their own outbound TLS connections. The relay joins those connections only after authenticating them and resolving all of them to the same `SessionBinding`.

The binding is the routing authority for a connection. It carries `protocolVersion`, `schemaVersion`, `sessionId`, `runId`, `workspaceId`, required-but-nullable `organizationId`, `hostDeviceId`, policy identity/version, and retention class. Both protocol and schema version mismatches fail closed; the current remote protocol is version 1 ([`session.ts`](../packages/remote-protocol/src/session.ts), [`schema.ts`](../packages/remote-protocol/src/schema.ts), [E0 D5](E0-decisions.md#d5--version-lives-on-the-wire-twice-for-two-different-questions)).

For every accepted message the relay resolves the authenticated connection's binding and checks the message's contract identity against it:

- a `SessionFrame` must have the bound `protocolVersion`, `sessionId`, and `runId`;
- a `RunEvent` must have the bound `runId`;
- an authority command must be signed for the bound organization, workspace, run, and session before it can be filtered or forwarded.

The first two checks use fields that exist in the current envelopes ([`session-stream/src/frame.ts`](../packages/session-stream/src/frame.ts), [`run-events/src/event.ts`](../packages/run-events/src/event.ts)). The last check, and literal organization/workspace fields on every message, require contract work described in section 11; the relay must not invent an unversioned wrapper to simulate them.

### Authentication

Platform owns pairing, device identity, role assignment, grants, and revocation. Device-auth credentials carry a device id, client type, scopes, creation time, and immutable nullable `revokedAt`; unknown credential fields are rejected because they may contain secret material. Raw credential secrets are never stored in the identity record, and device credentials cannot hold the `acceptance` scope ([`credential.ts`](../packages/device-auth/src/credential.ts), [`scopes.ts`](../packages/device-auth/src/scopes.ts)). Both self-revoke and dashboard-revoke set the same `revokedAt` field; revoking one credential returns a new frozen record and does not mutate another credential ([`credential.ts`](../packages/device-auth/src/credential.ts)).

Platform must map organization membership to a session role explicitly in the signed grant. It must not equate device-auth's organization `Role` vocabulary with remote-protocol's `SessionRole`: they are different sets, and device-auth marks `operator`, `approver`, `auditor`, and `viewer` as not yet enforced ([`device-auth/src/roles.ts`](../packages/device-auth/src/roles.ts), [`remote-protocol/src/session.ts`](../packages/remote-protocol/src/session.ts)). The relay validates the granted session role but never infers one from a membership label.

The intended connection exchange is:

1. Platform validates the device credential and the requested session membership.
2. Platform issues a relay-audience access token with a 10-minute lifetime, the credential/device id, binding identity, session role, and a unique token id.
3. The relay validates the Platform signature, audience, expiry, exact binding, closed `SESSION_ROLES` membership, and its current revocation cache. It never issues or widens the grant.
4. The relay reauthorizes a still-open connection when its token expires; failure disconnects it.

The 10-minute access token is a deployment choice, not a `DeviceCredential` field: the current device-auth credential contract has no expiry. Its schema must be standardized before production (section 11).

### Session creation

1. Platform creates a fresh `sessionId` for an already-existing `runId`, binds it to the workspace, required organization value (including explicit `null`), host device, active policy, and retention class, and signs a host grant.
2. The host opens the outbound connection and submits the exact binding. The relay runs `validateSessionBinding`, verifies the grant and host device, and refuses skew or mismatched context.
3. The relay creates an in-memory session record and an empty stream ring. It marks the host reachable only after the authenticated connection is live.
4. A supervising device obtains its own Platform grant for that binding and role. The relay never copies the host's credential or treats possession of a session id as membership.
5. Host and device establish the session encryption described in section 7. Only then is the device live.

A session is transport identity; a run is work identity. A run survives worker restart, host reboot, movement to another machine, and a dropped connection, while a session does not ([`session.ts`](../packages/remote-protocol/src/session.ts)). After a host restart, Platform creates a new `sessionId` bound to the same `runId` and current workspace/organization/policy. The relay closes the old session, rejects old-session authority with `session_changed`, discards its ring and keys, and starts sequence zero for the new session stream. Durable run-event sequencing continues for the run rather than restarting.

### Teardown

The relay tears down a session when Platform revokes the session, the host closes it deliberately, a terminal run event is observed, or the disconnected host exceeds a 15-minute reconnect grace period. Teardown rejects queued commands, disconnects devices, zeroizes in-memory session keys and ciphertext buffers, removes the routing record, and reports the session closed to Platform. It does not delete the run or its Platform-owned event log.

## 3. Three channels

The channels are separate queues with separate validators and storage rules. A message valid on one channel is invalid on the others.

| Channel | Contract and envelope | Relay behavior | Sequence and idempotency |
| --- | --- | --- | --- |
| Run events | Exact `RunEvent`: `schemaVersion`, `eventId`, `runId`, positive `sequence`, `type`, `actor`, `occurredAt`, `idempotencyKey`, `traceId`, allowlisted `payload` ([`event.ts`](../packages/run-events/src/event.ts), [`payload.ts`](../packages/run-events/src/payload.ts), [`schema.ts`](../packages/run-events/src/schema.ts)) | Fan out accepted Platform events to devices. Platform, not the relay, validates append semantics and persists the durable log. The relay holds only connection backpressure state. | Total order is per run, starts at 1, and is contiguous. A repeated idempotency key is a duplicate only if the derived event digest is identical; conflicting reuse is rejected ([`ordering.ts`](../packages/run-events/src/ordering.ts), [`digest.ts`](../packages/run-events/src/digest.ts)). |
| Session stream | Exact `SessionFrame`: `protocolVersion`, `sessionId`, `runId`, zero-based `seq`, `at`, closed `kind`, and allowlisted `body` ([`frame.ts`](../packages/session-stream/src/frame.ts), [`schema.ts`](../packages/session-stream/src/schema.ts)) | Validate at the host before encryption and at the device after decryption. Retain ciphertext only in an in-memory ring for at most 15 minutes, 10,000 frames, or 16 MiB per session, whichever is reached first. The contract's 64 KiB frame cap, 16 KiB diff-hunk cap, and 2 KiB tool-summary cap still apply before encryption ([`schema.ts`](../packages/session-stream/src/schema.ts)). | Total order is per session. Zero is valid and each accepted sequence is exactly the previous plus one; `nextSeqIsValid` rejects gaps and replays ([`schema.ts`](../packages/session-stream/src/schema.ts)). A frame has no idempotency key: the tuple `(sessionId, seq)` is its replay identity and an already-seen sequence is not delivered twice. |
| Authority | `RemoteCommandKind`, `mayIssue`, and host-confirmed `RemoteDecisionState` from remote-protocol ([`authority.ts`](../packages/remote-protocol/src/authority.ts)) | Authenticate and filter a signed request, deliver it as `provisional`, then carry the host's `confirmed` or `rejected_by_host` result. Never convert relay receipt into host acceptance. | The current contract defines neither a signed command envelope nor command sequence/idempotency fields. Production forwarding remains disabled until the versioned envelope and ACK/REJECT event are added (section 11). |

### Session-stream replay

A device reconnects with its last accepted session `seq`. If every later frame remains in the ring, the relay replays them in ascending order. If the requested next sequence is older than the ring's oldest frame, the connection enters an explicit `replay_gap` state showing the requested sequence, oldest available sequence, and newest available sequence. It renders “Some live activity is no longer available,” resumes at the oldest available frame only after acknowledging the gap, and never fills the gap from durable run events. This state is relay control-plane state, not a fabricated `SessionFrame`; its wire schema is an open contract question.

### Ordering guarantees

The relay preserves total order within each ordered scope: per-run order for run events, per-session order for session frames, and eventually per-session authority order once that envelope exists. It will close a channel rather than deliver a known gap as contiguous data.

There is no cross-channel order. A durable event may commit through Platform while an ephemeral frame is delayed, and an authority result may race a display update. Giving these independent durability paths one apparent clock would be false. Consumers correlate by run/session and domain ids (`questionId`, `approvalId`, command id when contracted), then treat the durable run event or host authority result as canonical—not arrival order on another channel.

## 4. Authority handling

`SESSION_ROLES` is the closed set `host`, `owner`, `approver`, `collaborator`, and `viewer`. `mayIssue(role, command)` fails closed for unknown roles and commands ([`session.ts`](../packages/remote-protocol/src/session.ts), [`authority.ts`](../packages/remote-protocol/src/authority.ts)).

The command path is:

1. The device signs a command for one exact session, run, request, role, expiry, and idempotency key.
2. The relay authenticates the signer and current grant, checks binding and expiry, and calls `mayIssue` as a filter. A false result is refused and never reaches the host.
3. If it passes, the relay marks the device-side decision `provisional` and forwards it once.
4. The host independently validates the signature, exact binding, device revocation state, role with `mayIssue`, demonstrated adapter capability, current policy, request existence, offered option, expiry, and whether another surface already settled it. The host is the authority root.
5. The host emits a consequential-command ACK or REJECT event. The relay forwards that result without editing it. Only a host ACK produces `confirmed`; a rejection uses the closed reasons `option_not_offered`, `expired`, `already_settled`, `not_permitted`, or `session_changed` ([`authority.ts`](../packages/remote-protocol/src/authority.ts)).

The reversible braking commands are `pause`, `restrict_to_read_only`, and `deny_pending_approval`; `abort` is terminal and owner-only; steering is `send_message` and `answer_question`; and `approve_pending_approval` is owner/approver-only. Acting supervising roles can always reduce authority without an approval round trip, while a `viewer` can only watch and a `host` receives rather than issues remote commands. `BROADENING_COMMANDS` is empty, so the relay has no broadening branch, fallback, or extension hook ([`authority.ts`](../packages/remote-protocol/src/authority.ts)).

The UI renders exactly `renderableRemoteCommands(matrix, role)`, which intersects demonstrated adapter capability with role authority. It does not render `permittedRemoteCommands` directly or hand-maintain a role table ([`worker-capabilities/src/index.ts`](../packages/worker-capabilities/src/index.ts), [E0 D8](E0-decisions.md#d8--worker-trust-is-derived-and-controls-require-demonstrated-capability)).

## 5. Revocation

Platform is the revocation source of truth. `revokedAt` changes immutably from `null` to a canonical timestamp for both self- and dashboard-revoke ([`credential.ts`](../packages/device-auth/src/credential.ts)).

The first slice uses two propagation paths:

- Platform pushes a signed revocation notice to every relay instance immediately, with a 2-second delivery objective.
- Every relay pulls a monotonically versioned revocation snapshot every 15 seconds. Fifteen seconds is the maximum claimed detection interval while Platform is reachable; the pull repairs a missed push.

On learning a revocation, the relay atomically marks the credential revoked, closes its connections, removes its queued commands, and returns the service-level rejection `credential_revoked` for any new or not-yet-forwarded command. This is not smuggled into `RemoteDecisionRejection`, whose vocabulary does not currently contain it. A command already delivered remains provisional until the host decides it.

The host receives the same signed revocation feed over its outbound connection and maintains its own cache. If the relay raced or was compromised, the host refuses a known-revoked signer as `not_permitted`. This is belt and braces: relay filtering reduces load and exposure, but does not replace host authority.

Device revocation must be durable. The current run-event vocabulary has no device-revoked event or payload, so Platform must record the revocation in its security audit log now and must not forge a `RunEvent`. Adding a content-minimal durable run event, if product semantics require revocation to appear in each affected run, is a blocking contract decision in section 11 ([`event-types.ts`](../packages/run-events/src/event-types.ts), [`payload.ts`](../packages/run-events/src/payload.ts)).

## 6. Degraded modes: Wave 1 gate

Each row is an executable acceptance scenario. “Event” means a contract-valid durable `RunEvent`; the relay never creates a substitute event merely to make a row green.

| Scenario | Device surface | Host behavior | Durable record and test oracle |
| --- | --- | --- | --- |
| Relay unavailable | Show “Remote supervision unavailable since T,” last successfully received sequence, and stale-status age. A locally staged authority command has an absolute expiry and is discarded after 60 seconds; it is never replayed as a fresh command. | Continue under the already-active policy and local controls. Approval-required actions still wait. Continue the local append-only event log and write the local receipt even if remote delivery is unavailable. Reconnect outbound with bounded backoff and a fresh session grant when necessary. | Existing run events continue normally. There is no allowlisted relay-unavailable event/reason, so the outage itself has no valid `RunEvent` today; the gate must expect the contract addition in section 11 rather than misuse `worker.warning` ([`event-types.ts`](../packages/run-events/src/event-types.ts), [`payload.ts`](../packages/run-events/src/payload.ts)). |
| Platform unavailable | Show “Platform unavailable,” token expiry, and “Revocation checked T ago.” Disable pairing, new session membership, new grants, and role changes. | Keep an established session only while its cached 10-minute token is valid. Make no new grants. When it expires, disconnect remote supervision; local policy remains authoritative. If work truly blocks on Platform, stop rather than weaken policy. | A genuine work block may be `run.blocked` with `external_dependency_unavailable`; a mere control-plane outage has no dedicated event ([`payload.ts`](../packages/run-events/src/payload.ts)). |
| Mobile unavailable | Web/host show the pending approval and Mobile's last-seen time; Mobile shows the still-current request on return. | Enter or remain `WAITING_FOR_APPROVAL`. Never turn lack of a device into automatic approval. Apply the policy decision unchanged; no matching or malformed policy cannot authorize work ([`evaluation.ts`](../packages/policy/src/evaluation.ts), [E0 D6](E0-decisions.md#d6--the-five-policy-matching-decisions-ratified)). | `approval.requested` records the pending decision; `run.blocked` with `awaiting_approval` may record a blocked terminal/reporting condition. Later resolution is `approval.granted` or `approval.denied` ([`event-types.ts`](../packages/run-events/src/event-types.ts), [`payload.ts`](../packages/run-events/src/payload.ts)). |
| Host unavailable | Show “Host unreachable since T,” stop the live activity indicator, and keep last data visibly stale. Commands may wait in relay memory for at most 60 seconds with their original expiry; then show expired. Nothing is synthesized. | If merely disconnected, do nothing until the host reconnects to the same live session within grace. After restart, establish a new session; old-session commands reject as `session_changed`. | Platform may append `worker.warning`/`heartbeat_late` after its heartbeat threshold. If the run actually fails, `run.failed`/`worker_unreachable` is valid. There is no durable transient host-unreachable event ([`payload.ts`](../packages/run-events/src/payload.ts)). |

Additional assertions apply to all four tests: no command outlives its original expiry; no queue is durable; reconnect never renumbers an existing run event; a new session never inherits the old session's frames or keys; and the device distinguishes “unknown/stale” from “safe/approved.”

## 7. Privacy and content minimalism

### Channel allowlists

- Durable run events may contain only the exact per-event fields in `PAYLOAD_FIELDS`, and each value is a tagged id, enum, count, digest, timestamp, or flag—never free text. Unknown envelope and payload fields are rejected ([`payload.ts`](../packages/run-events/src/payload.ts), [`schema.ts`](../packages/run-events/src/schema.ts)).
- Session stream may contain only `current_action`, `tool_activity`, `diff_preview`, `question`, `warning`, `artifact_preview`, or `redaction_notice`, with the exact body fields and size caps defined by its validator. A diff is host-truncated truthfully before construction; a receiver refuses oversized input ([`frame-types.ts`](../packages/session-stream/src/frame-types.ts), [`schema.ts`](../packages/session-stream/src/schema.ts), [E0 D7](E0-decisions.md#d7--session-frames-are-ephemeral-display-transport-not-run-history)).
- Authority may contain only the closed remote command and decision vocabularies. Command parameters must use the future contracted signed envelope; arbitrary JSON is not forwarded ([`authority.ts`](../packages/remote-protocol/src/authority.ts)).

Validation occurs before encryption at the producing endpoint and after decryption at the consuming endpoint. Because the relay cannot read end-to-end encrypted bodies, it can enforce authenticated routing metadata, ciphertext size, rate, sequence continuity, and role/command-kind filtering, but it cannot honestly claim to validate plaintext content. A producer that cannot validate does not send.

Push notifications use only `notificationSafeProjection`: repository-authored `actionSummary`, `actionClass`, `riskLevel`, `policyId`, `policyVersion`, `timestamp`, and bounded approval-duration description. The contract explicitly forbids request `reason` and has no project or rule-text field, so the requested “action/project/reason/rule” payload is not implementable without weakening the current privacy boundary. Notifications never carry code, paths, prompts, document text, raw requests, credentials, customer data, or personal information ([`approvals/src/notification.ts`](../packages/approvals/src/notification.ts), [`approvals/src/request.ts`](../packages/approvals/src/request.ts)).

### End-to-end encryption

All session content retained in the relay ring is ciphertext. At session creation the host generates a random session content key. Each authorized device performs an authenticated ephemeral key agreement with the host through the relay; the host wraps the content key separately to that device. Adding or removing a device changes its key access without exposing the content key to Platform or relay. A new host session creates a new key and does not reuse the old session's key. Revocation stops future key delivery and rotates the session key when another device remains.

The relay-visible authenticated header contains only routing/order material needed to operate: protocol and schema versions, binding identity, channel, sequence or command id, command kind and asserted role for the `mayIssue` filter, timestamps/expiry, ciphertext length, and sender/key identifiers. The exact signed authority header and device public-key binding are not yet contracts and therefore block production authority/E2E rollout (section 11).

The cost is deliberate: every endpoint must manage keys; a host must wrap a key per authorized device; device addition and revocation may rotate keys; server-side content search, rendering, moderation, and plaintext validation are unavailable; and losing all authorized endpoint keys loses buffered session content. Encryption does not protect a compromised host or device, the safe notification projection, routing metadata, message sizes/timing, or content a user deliberately copies elsewhere.

Platform-persisted run events remain Platform's durable responsibility, outside the relay store. They must be encrypted in transit and at rest under Platform's data-storage design. True host-to-device E2E storage of the exact `RunEvent` while still allowing Platform to validate append order is not defined by the present contracts and is an open security/Platform decision; the relay does not claim that guarantee.

## 8. Attention capture

The surface that renders a decision measures `humanSeconds` from first render of the complete prompt/options to the accepted decision, using monotonic elapsed time and rounding once to a non-negative whole second. It is wall-clock decision cost, not a keystroke or activity detector. If several devices render the same request, only the surface whose decision the host confirms contributes its timer; timers for `already_settled`, expired, or otherwise rejected attempts are discarded.

The accepted value travels unchanged to the host and into `run.question_answered`, `approval.granted`, or `approval.denied`. The host aggregates accepted decision seconds, decisions, interruptions, and escalations into `run.completed`; those exact fields are required and content-minimal ([`payload.ts`](../packages/run-events/src/payload.ts), [E0 D10](E0-decisions.md#d10--human-attention-is-a-measured-institutional-cost)). The relay may validate an outer count where visible but never starts, stops, substitutes, rounds, or edits the timer.

## 9. Observability without surveillance

Relay telemetry contains no body, prompt, diff, path, document text, command parameters, notification text, user-entered string, or decrypted value.

Allowed metrics are per-session/channel counts and distributions: active connections, authentication outcomes by closed reason, bytes, accepted/refused frames, queue depth, delivery and host-ACK latency, reconnects, replay requests, replay gaps, oldest/newest buffered sequence, buffer evictions, token/revocation freshness, and expired commands. Session ids are short-retention operational labels, not analytics identities; user/device ids are not metric labels. Logs contain trace ids, closed error codes, coarse timestamps, and hashed/rotating session correlation only.

There is no keystroke logging, cursor tracking, per-human dwell analytics, “active user” inference, or background-presence tracking. The sole dwell-like measurement is the decision timer in section 8, emitted as an event count and not retained as relay analytics.

## 10. First-slice deployment and demo

### Deployment shape

Deploy one small service with TLS termination, WebSocket connection handling, Platform token/revocation clients, in-memory routing, bounded ciphertext rings, and metrics. It has no database, object store, queue service, transcript index, policy engine, verifier, or receipt store. Horizontal replicas use Platform session routing or consistent connection routing; reconnect may land elsewhere and legitimately produce a replay gap because rings are instance-local.

No Canada-region or data-residency claim is made. The current E0 D6 ratifies policy matching, not deployment jurisdiction, and none of D1–D12 selects a relay region ([E0 D6](E0-decisions.md#d6--the-five-policy-matching-decisions-ratified)). Region and residency require an explicit deployment-owner decision.

Platform wiring has three narrow operations: exchange a validated device/worker identity plus membership for a 10-minute relay-audience token; push signed session/revocation changes; and serve the 15-second repair snapshot. The relay validates these artifacts and never writes Platform identity or grants. Platform remains the only durable writer for run events.

### Eighteen-step end-to-end demo

The Wave 1 demo passes only when this exact run works end to end:

1. Platform creates a run and appends `run.created` sequence 1.
2. Platform binds a fresh session to the run, workspace, explicit organization value, host, policy, and retention class.
3. Vinci Code exchanges its worker identity for a 10-minute host grant.
4. Vinci Code opens the outbound-only relay connection; version and binding validation pass.
5. Mobile pairs, receives an owner grant, and opens its outbound connection.
6. Host and Mobile negotiate a session key without exposing it to the relay.
7. Host appends `run.started`; Platform persists it and the relay fans it out.
8. Host emits session frame sequence 0; Mobile decrypts and renders it.
9. Host emits a bounded diff frame; the relay retains only ciphertext in its ring.
10. Mobile disconnects while the host emits two more contiguous frames.
11. Mobile reconnects with its cursor and receives the two frames in order.
12. The host emits `approval.requested`; Mobile receives a content-minimal event and a safe push projection.
13. Mobile renders only commands returned by `renderableRemoteCommands(matrix, "owner")` and starts its decision timer.
14. Mobile signs `approve_pending_approval`; relay and host independently pass `mayIssue`, and the relay shows provisional.
15. Host validates the live request and ACKs; Mobile shows confirmed and Platform persists `approval.granted` with unchanged `humanSeconds`.
16. A collaborator sends `pause`; it is confirmed, while that collaborator's attempted `abort` is filtered as `not_permitted` and never reaches the host.
17. Platform revokes Mobile; relay learns by push, disconnects it, and refuses a queued command as `credential_revoked`; the host independently refuses the revoked signer.
18. The host completes locally, Platform persists `run.completed` with attention aggregates and receipt digest, the relay fans it out, then tears down the session and erases its ring and keys.

Steps 6, 14–15, and the durable part of step 17 cannot be declared production-complete until the contract gaps below are resolved. The rest can be implemented and tested against the present packages.

## 11. Open questions

1. **Signed authority envelope and ACK/REJECT event — owner: remote-protocol maintainer with Security.** What versioned, validated structure carries binding, signer/key id, command kind and parameters, sequence, idempotency key, issue/expiry times, signature, and the host's consequential ACK/REJECT? `RemoteCommandKind` and `RemoteDecisionState` define semantics but no wire envelope; the relay must not create a private one ([`authority.ts`](../packages/remote-protocol/src/authority.ts)).
2. **Literal binding on every frame and replay-gap schema — owner: remote-protocol and session-stream maintainers.** Should organization/workspace be added to each channel envelope, or should a versioned common binding reference make connection-context binding normative? The same decision must standardize the relay's `replay_gap` control result. Current `SessionFrame` carries only protocol/session/run identity, and `RunEvent` only run identity ([`session-stream/src/frame.ts`](../packages/session-stream/src/frame.ts), [`run-events/src/event.ts`](../packages/run-events/src/event.ts)).
3. **Durable relay/security events — owner: run-events maintainer with Platform.** Which content-minimal event types and closed reason codes represent device revocation, relay unavailability, transient host unreachability, and authority ACK/REJECT? The current frozen allowlist cannot record all required Wave 1 scenarios, and unrelated warning codes must not be reused ([`event-types.ts`](../packages/run-events/src/event-types.ts), [`payload.ts`](../packages/run-events/src/payload.ts), [`schema.ts`](../packages/run-events/src/schema.ts)).
4. **Expiring relay credential format — owner: Platform Identity/Security.** Is the 10-minute relay-audience token a new versioned device-auth contract or an existing Platform token profile? `DeviceCredential` has `createdAt` and `revokedAt` but no `expiresAt`; issuer, audience, key rotation, clock skew, and token-id replay rules need one owner ([`credential.ts`](../packages/device-auth/src/credential.ts)).
5. **Authenticated E2E key identity and durable-event encryption — owner: Security with Platform Data.** What Platform-certified public key binds to a device credential, which key-agreement/signature suite is mandatory, how are multi-device rotation and recovery handled, and which fields—if any—may remain visible so Platform can validate and index the durable run log? Device credentials currently bind no public key ([`credential.ts`](../packages/device-auth/src/credential.ts)).
6. **Relay region and residency — owner: Infrastructure/Compliance.** Which initial region and disaster-recovery boundary are approved? This design intentionally makes no Canada residency claim; E0 D6 is a policy-matching decision, not a residency decision ([E0 D6](E0-decisions.md#d6--the-five-policy-matching-decisions-ratified)).
