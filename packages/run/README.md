# @getsimpledirect/vinci-run

The six durable objects of a governed run, with the same discipline as every
other schema here: `validateX(input: unknown)` snapshots through `toPlainRecord`,
rejects unknown fields (`unknown_field`), fails closed, and `xDigest()` is
SHA-256 over the canonical encoding of the VALIDATED object — an invalid object
throws rather than digests. Every schema is version 1, frozen, `unknownFields:
"reject"`, `migration: "none"`.

| Object | Id | What it is |
| --- | --- | --- |
| `VinciAgent` | `vinci.agent` | What an agent is and may do: model class, policy refs, skills (by digest), the harness/endpoint capabilities it requires, allowed tool categories, and a bounded per-capability autonomy level (0–8). |
| `VinciEnvironment` | `vinci.environment` | Where a run happens: placement, image digest, runtime build, network and filesystem policy as closed sets, resource limits, secret source and delivery. |
| `VinciRun` | `vinci.run` | The governed unit: binds a work order (by digest) and attempt to an agent version and an environment digest, fixes the budget and the required terminal tier up front, and carries the projected state. |
| `ContextManifest` | `vinci.context-manifest` | The closed inventory of what was loaded into the run, each entry with a digest and a REQUIRED `trust`, plus what was deliberately excluded and why. |
| `HarnessAttestation` | `vinci.harness-attestation` | What the harness has proved about itself: per-capability self-test result, digest, and which entrypoint was observed. |
| `HumanCorrection` | `vinci.human-correction` | A human's correction of a run, pinned to run, event sequence, model, runtime build and context digest so it is reproducible rather than anecdotal. |

## Pure helpers

- `projectRunState(events)` — replays a run's event log into
  `CREATED | RUNNING | PAUSED | BLOCKED | STALLED | TERMINAL`. TERMINAL is absorbing;
  any event after it is reported as `event_after_terminal`, never folded back.
- `terminalEvidenceMissing(events)` — artifact ids announced by
  `artifact.created` with no matching `artifact.persisted`.
- `attestedHarnessCapabilities(attestation, now)` — the ONLY list that should
  feed `matchEndpointToRole`'s `attestedHarnessCapabilities`. Counts a capability
  only when its self-test is `PASS`, it was observed on the `installed_worker`
  (a source checkout proves nothing about the installed artifact), the
  attestation is unexpired at `now`, and the id is in `HARNESS_CAPABILITIES`.

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
