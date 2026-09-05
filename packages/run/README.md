# @getsimpledirect/vinci-run

The six durable objects of a governed run, with the same discipline as every
other schema here: `validateX(input: unknown)` snapshots through `toPlainRecord`,
rejects unknown fields (`unknown_field`), fails closed, and `xDigest()` is
SHA-256 over the canonical encoding of the VALIDATED object — an invalid object
throws rather than digests. Every schema is frozen, `unknownFields: "reject"`.
Five are at version 1 with `migration: "none"`; `HarnessAttestation` is at
version 2 (see below), and a v2 validator REFUSES a v1 attestation on
`schemaVersion` rather than up-converting it.

| Object | Id | What it is |
| --- | --- | --- |
| `VinciAgent` | `vinci.agent` | What an agent is and may do: model class, policy refs, skills (by digest), the harness/endpoint capabilities it requires, allowed tool categories, and a bounded per-capability autonomy level (0–8). |
| `VinciEnvironment` | `vinci.environment` | Where a run happens: placement, image digest, runtime build, network and filesystem policy as closed sets, resource limits, secret source and delivery. |
| `VinciRun` | `vinci.run` | The governed unit: binds a work order (by digest) and attempt to an agent version and an environment digest, fixes the budget and the required terminal tier up front, and carries the projected state. |
| `ContextManifest` | `vinci.context-manifest` | The closed inventory of what was loaded into the run, each entry with a digest and a REQUIRED `trust`, plus what was deliberately excluded and why. |
| `HarnessAttestation` | `vinci.harness-attestation` | What the harness has proved about itself: per-capability self-test result, digest, and what artifact was observed running it — `installed_package`, `pinned_checkout` (with the commit and tree it is pinned to), or `working_tree`. |
| `HumanCorrection` | `vinci.human-correction` | A human's correction of a run, pinned to run, event sequence, model, runtime build and context digest so it is reproducible rather than anecdotal. |

## Pure helpers

- `projectRunState(events)` — replays a run's event log into
  `CREATED | RUNNING | PAUSED | BLOCKED | STALLED | TERMINAL`. TERMINAL is absorbing;
  any event after it is reported as `event_after_terminal`, never folded back.
- `terminalEvidenceMissing(events)` — artifact ids announced by
  `artifact.created` with no matching `artifact.persisted`.
- `attestedHarnessCapabilities(attestation, now)` — the ONLY list that should
  feed `matchEndpointToRole`'s `attestedHarnessCapabilities`. Counts a capability
  only when its self-test is `PASS`, it was observed on an artifact whose
  identity is bound (`installed_package` or `pinned_checkout`, never
  `working_tree`), the attestation is unexpired at `now`, and the id is in
  `HARNESS_CAPABILITIES`.

## Attestable is about bound identity, not about delivery

`observedEntrypoint` v1 asked HOW the harness was delivered
(`installed_worker | source_checkout`) and counted only the first. Production
workers run from `/opt/vinci-code-cli`, a root-owned git checkout deployed by
`git fetch` + `git checkout --detach <sha>` + a systemd restart, and the release
repository has no worker packaging path at all — so no production worker could
ever be attested and every role requiring a harness capability stayed
`unevaluable [harness_capabilities_unverified]` for good. The label also stopped
nobody: nothing checks how the bytes arrived.

v2 asks what actually decides whether a self-test result carries forward: is the
artifact's IDENTITY BOUND?

- `installed_package` — an installed package artifact (what the control-plane
  server gets via install.sh). Attestable.
- `pinned_checkout` — a checkout the attester declares bound to an exact commit
  and observed tree. Attestable, and it must carry
  `checkoutPin: { commitId, treeId }`: the 40-hex commit and the 40-hex
  `git write-tree` the attester says it observed. This is an out-of-band
  deployment assertion that the contract records and shape-checks; the
  contract cannot verify the checkout or prove it was clean. An auditor can
  recompute the declared commit's tree and reconcile the pair with deployment
  records, but a dishonest dirty attester can simply report the clean commit's
  tree. The pair provides concrete identities for later reconciliation, not
  independent proof. A `pinned_checkout` without that evidence is INVALID
  (`missing_checkout_pin`), not merely uncapable; a pin on any other entrypoint
  is `checkout_pin_not_applicable`.
- `working_tree` — dirty, or at no recorded commit. NEVER attestable.

## Where the truth lives

These packages define the SHAPE of a run. The authoritative store of runs,
events, attestations and corrections is **vinci-gpu-control**; nothing here
persists anything, and a record that only exists in a worker's memory is not a
run.

## Control plane and data plane

A context manifest's `stable_prefix` section is the mission's control plane. It
may carry only `authoritative`, `ratified`, `machine_observed` or `superseded`
context. An entry there with trust `externally_sourced`, `model_inferred` or
`unverified` is rejected with `data_plane_in_control_prefix`: what the model
inferred or fetched from outside must never be able to restate the mission.

## Not-doing is a productive terminal

`run.completed` carries `outcome` (`RUN_OUTCOMES` in run-events). Refusing,
withdrawing, deferring, or reporting "nothing to do" are successful completions
of a run that reached the right answer — they are terminals, not failures, and
`run.failed` is reserved for the harness not finishing at all.
