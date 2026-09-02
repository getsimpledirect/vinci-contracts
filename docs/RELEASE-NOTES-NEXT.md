# Unreleased — IR-00 runtime contracts

`docs/RELEASE-0.2.0.md` is history. This file accumulates what the NEXT lockstep bump ships; it carries no version number, because the version is chosen when the release is cut and writing one here early is how a document starts describing a state nobody decided on.

**Breaking: run events are v4.** `@getsimpledirect/vinci-run-events` adds 24 event types (`run.stalled`, `run.attempt_started`, the four `agent.turn_*`/`agent.compaction_*`/`agent.retry_*` pairs, five `tool.*`, three `governor.lease_*`, `artifact.persisted`, `artifact.verified`, `approval.expired`, `context.loaded`, `context.invalidated`, `capability.attested`, `capability.refused`, `steer.received`) and two OPTIONAL `run.completed` fields (`outcome` from `RUN_OUTCOMES`, `tierReached` from `TERMINAL_TIERS`).

The break is the version, not the shapes: no v3 type, field or payload rule changed. `RUN_EVENT_SCHEMA_META.compatibility` is `frozen` and `unknownFields` is `reject`, so **a v4 validator REFUSES a v3 event on `schemaVersion` and does not up-convert it**, and a v3 validator refuses every v4 event. Producers and consumers of one run's log must therefore move together.

**New package `@getsimpledirect/vinci-run`** (layer 3). Six schemas, each with `validate*`, a digest over the canonical encoding of the VALIDATED value, and a `SchemaMeta`: `VinciAgent`, `VinciEnvironment`, `VinciRun`, `ContextManifest`, `HarnessAttestation`, `HumanCorrection`. Plus `projectRunState(events)` (a pure projection from the event log; TERMINAL is absorbing and a later event is reported, not folded away), `terminalEvidenceMissing(events)`, and `attestedHarnessCapabilities(attestation, now)`.

**Extended `HARNESS_CAPABILITIES`** in `@getsimpledirect/vinci-model-classes`, from three members to the vocabulary a governed run can actually attest (`workspace_read`, `shell_execution`, `github_publish_pr`, … ). `matchEndpointToRole` still withholds eligibility for a role requiring a harness capability until a caller passes `attestedHarnessCapabilities`; that list counts an entry only when its self-test PASSED **on the installed worker**, the attestation has not expired, and the id is a member of the vocabulary. Empty is the fail-closed answer, never a grant.

**Cross-language vectors.** `packages/run/vectors/` pins canonical bytes and digests for seven fixtures, checked from TypeScript (`src/vectors.test.ts`) and from Python (`python/test_run_vectors.py`, reusing the one shared canonicalizer). `run-events-v4-additions.json` pins one accepted and one refused payload for each of the 24 new types. `npm run test:vectors` and `npm run gate` run both suites.

**Consumers that must move:**
- `vinci-gpu-control` — the run registry writes run events; it must move to `schemaVersion: 4` in the same change that adopts the new types, and can then persist `VinciRun` and project state from the log rather than from its own table.
- `vinci-code-cli` (worker) — emits the `agent.*`, `tool.*` and `context.*` events, and is the entrypoint a `HarnessAttestation` must name as `installed_worker`. A capability proven on a source checkout establishes nothing.

Release mechanics unchanged: lockstep versions across every package, tag on the merged head, `release.yml` publishes on the tag.
