# State dimensions — how the run-event bus and the authority ledger map onto them

Ruling (Worker plan, 2026-08-28): there is no single global "completed". An
attempt's outcome is a point in three independent dimensions, each with its own
closed vocabulary in `packages/contracts/src/states.ts`, plus the server's
annotation of the evidence behind it:

| Dimension | Vocabulary | Owner |
| --- | --- | --- |
| `execution` | `PENDING` `LEASED` `RUNNING` `ARTIFACT_PRODUCED` `BLOCKED` `FAILED` `LOST` | worker; lease machinery for `PENDING`/`LEASED`/`LOST` |
| `assurance` | `NOT_EVALUATED` `SELF_CHECKED` `VERIFIED_PASS` `CONDITIONAL` `BLOCKED` | verifiers (`SELF_CHECKED` is the worker's own claim) |
| `promotion` | `NOT_ELIGIBLE` `ELIGIBLE` `APPROVED` `APPLIED` `REVOKED` | authority ledger |
| `evidence` (annotation) | `NOT_ATTEMPTED` `DECLARED` `VERIFIED` `MISMATCH` `UNAVAILABLE` | server, on the worker's declared evidence |

`OutcomeTriple` carries all four. `canTransition(dimension, from, to)` is the
legality table per dimension; `deriveLegacyTerminal(triple)` is the only path
to the Worker's single-word vocabulary (`COMPLETED` `UNVERIFIED` `BLOCKED`
`FAILED` `LOST`), and it reaches `COMPLETED` only through:

```
execution = ARTIFACT_PRODUCED
and assurance = VERIFIED_PASS
and promotion in {ELIGIBLE, APPROVED, APPLIED}
and evidence = VERIFIED
```

Everything else a produced artifact can be is `UNVERIFIED`, except a `BLOCKED`
verdict, which is `BLOCKED`. Evidence the server never verified — `NOT_ATTEMPTED`,
`DECLARED`, `UNAVAILABLE` — does not yield the strongest word any more than a
`MISMATCH` does: "nobody checked" is not a weaker form of "checked". Three of
the 875 triples earn `COMPLETED`. `states.test.ts` enumerates every triple to
hold two properties: no triple maps to `COMPLETED` without `VERIFIED_PASS`, and
none without evidence `VERIFIED`.

## The legality tables, as shipped

`canTransition` refuses `from === to` and anything outside its dimension. The
arcs that exist:

| Dimension | From | To |
| --- | --- | --- |
| execution | `PENDING` | `LEASED`, `LOST` |
| execution | `LEASED` | `RUNNING`, `PENDING`, `FAILED`, `LOST` |
| execution | `RUNNING` | `ARTIFACT_PRODUCED`, `BLOCKED`, `FAILED`, `LOST` |
| execution | `ARTIFACT_PRODUCED`, `BLOCKED`, `FAILED`, `LOST` | — (terminal for the attempt) |
| assurance | `NOT_EVALUATED` | `SELF_CHECKED`, `VERIFIED_PASS`, `CONDITIONAL`, `BLOCKED` |
| assurance | `SELF_CHECKED` | `VERIFIED_PASS`, `CONDITIONAL`, `BLOCKED` |
| assurance | any verdict | `NOT_EVALUATED` (stale), either other verdict (re-verification) |
| promotion | `NOT_ELIGIBLE` | `ELIGIBLE` |
| promotion | `ELIGIBLE` | `APPROVED`, `NOT_ELIGIBLE` |
| promotion | `APPROVED` | `APPLIED`, `REVOKED` |
| promotion | `APPLIED` | `REVOKED` |
| promotion | `REVOKED` | — (terminal) |
| evidence | `NOT_ATTEMPTED` | `DECLARED`, `UNAVAILABLE` |
| evidence | `DECLARED` | `VERIFIED`, `MISMATCH`, `UNAVAILABLE` |
| evidence | `VERIFIED` | `MISMATCH`, `UNAVAILABLE` (a later re-check) |
| evidence | `UNAVAILABLE` | `DECLARED` only |
| evidence | `MISMATCH` | — (terminal) |

Two invariants the tables pin, each with its own test:

- **A verdict can be displaced by a self-check only through an explicit
  stale.** No verdict state has an arc to `SELF_CHECKED`; the only path is
  `VERIFIED_PASS → NOT_EVALUATED → SELF_CHECKED`, and the first step is
  evidenced solely by `verdict.recorded` with `staled: true` — a verifier-side
  fact, never a worker claim. The assurance axis has no `REVOKED` member: a
  verdict stales, it is not revoked. If a revocation distinct from staling is
  ever needed it is a new member and a new ruling, not a reuse of
  `NOT_EVALUATED`.
- **Unavailable evidence re-enters only at `DECLARED`.** A failed fetch says
  nothing about content, so the sound next step is a re-fetch of the same
  declaration, which lands `VERIFIED` or `MISMATCH` on its own merits. There is
  no direct `UNAVAILABLE → VERIFIED` edge, no `REVOKED` on the evidence axis
  (revocation is a promotion word), and `MISMATCH` is terminal — once the
  declared content has been shown not to match, no later fetch un-shows it.

## Run events are not bumped. Here is why, and what maps where.

`vinci.run-event` stays at version 3. The team ruling: **lease and attempt
history is authority history, not run history.** A run's log records what the
run did; who held the right to run it, and whether its result was allowed to
take effect, is a different record with a different owner. Adding `lease.*` or
`promotion.*` kinds to the run bus would put authority facts in a log the
worker writes, which is the same actor-boundary confusion the approvals
notification already demonstrated.

So the dimensions are **derived** from existing events where the run bus
already carries the fact, and read from the authority ledger where it does not.

### Run-event bus → dimension transitions

| Event (existing, v3) | Dimension | Transition it evidences |
| --- | --- | --- |
| `run.created` | execution | `PENDING` (the attempt exists) |
| `run.started` | execution | `LEASED → RUNNING` (`workerId` is the lessee; the lease itself is in the ledger) |
| `run.blocked` | execution | `RUNNING → BLOCKED` (`reasonCode` from `RUN_BLOCKED_CODES`) |
| `run.failed` | execution | `RUNNING → FAILED` (`reasonCode` from `RUN_FAILURE_CODES`) |
| `run.cancelled` | execution | `RUNNING → FAILED` in the attempt's vocabulary — an attempt cancelled by authority did not produce; the receipt's `finalState` keeps `CANCELLED` |
| `host.unreachable` + lease expiry (ledger) | execution | `→ LOST` — the bus alone cannot say LOST, because lost is a lease judgement |
| `artifact.created` | execution | `RUNNING → ARTIFACT_PRODUCED` (`artifactDigest` is what assurance and evidence then bind to) |
| `evidence.recorded` | evidence | `NOT_ATTEMPTED → DECLARED` (the worker's claim; `provenance` says how it was gathered) |
| `verification.started` | assurance | no transition; a verifier is looking |
| `verdict.recorded` | assurance | `→ status` (`VERIFIED_PASS` / `CONDITIONAL` / `BLOCKED`); `staled: true` evidences `→ NOT_EVALUATED` instead (FR-7.4) |
| `run.completed` | — | a host summary, not a dimension transition. Its `terminalState` (`DONE` / `DONE_UNVERIFIED`) is the FR-2.2/6.2 vocabulary, not the Worker's; see "two vocabularies" below |
| `worker.heartbeat`, `run.progress`, `run.paused`, `run.resumed` | — | liveness and phase within `RUNNING`; no dimension moves |

What the bus does **not** carry, and never evidences on its own:

- `SELF_CHECKED` — a worker's claim that its own checks passed is a field on
  the attempt's result, not an event kind (see the rule below).
- `VERIFIED` / `MISMATCH` / `UNAVAILABLE` on the evidence axis — the server's
  fetch-and-compare of what `evidence.recorded` declared. That is the server's
  finding about the worker's claim and is recorded server-side, not replayed
  back into the run's log as though the worker had said it.

### Authority ledger → dimension transitions

| Ledger entry | Dimension | Transition |
| --- | --- | --- |
| `lease.granted` | execution | `PENDING → LEASED` |
| `lease.expired` (never started) | execution | `LEASED → PENDING` |
| `lease.expired` (started, no result) / `lease.lost` | execution | `→ LOST` |
| `lease.refused` | execution | `LEASED → FAILED` |
| `promotion.eligible` | promotion | `NOT_ELIGIBLE → ELIGIBLE` (follows a `VERIFIED_PASS` on the assurance axis) |
| `promotion.withdrawn` | promotion | `ELIGIBLE → NOT_ELIGIBLE` (the verdict staled) |
| `promotion.approved` | promotion | `ELIGIBLE → APPROVED` |
| `promotion.applied` | promotion | `APPROVED → APPLIED` |
| `promotion.revoked` | promotion | `APPROVED`/`APPLIED` `→ REVOKED` |

The ledger's entry names above are the shape the Worker plan gives them; the
ledger schema is not in this repository yet. What IS fixed here is that these
facts live there and not on the run bus.

## The "fields, not kinds" rule for the bus

`RUN_EVENT_TYPES` is frozen (`unknownFields: "reject"`, and every new kind is a
version bump, by the reasoning in `run-events/src/schema.ts`). The three
dimensions do not get event kinds. A consumer that wants the triple computes it
from the events above plus the ledger; it does not wait for a
`state.changed` event to tell it.

Concretely:

- A dimension value is a **field** on the record that owns it — the attempt
  result carries `execution` and the worker's `SELF_CHECKED` claim; the verdict
  record carries the assurance status; the ledger entry carries the promotion
  state; the server's evidence check carries the evidence state.
- The bus carries **what happened** (`artifact.created`, `verdict.recorded`),
  never **what state something is now in**. "Now in state X" is a derived
  reading, and putting derived readings on an append-only log invites two
  producers to disagree about the same run in the same log.
- If a future need genuinely requires a new fact on the bus, it is a new
  payload field on an existing kind before it is a new kind, and either is a
  v4 bump — there is no additive path on a frozen schema, and pretending there
  is was the defect that made this schema frozen in the first place.

## Two terminal vocabularies, deliberately

The receipt's `finalState` stays `TerminalState` (`DONE` `DONE_UNVERIFIED`
`WAITING` `BLOCKED` `FAILED` `CANCELLED`), which is the FR-6.2 vocabulary. The
Worker's `WorkerTerminalState` is the attempt's. They are not renamed into each
other because they answer different questions — the receipt describes a run
under a policy, the attempt describes a work-order execution under a lease —
and because the receipt vocabulary is what `vinci-code` persists today.

The one place they touch is the receipt's `verdict`, which from schema v3 may
be `null` exactly when `finalState` is `BLOCKED`, `FAILED` or `CANCELLED` AND
`artifactsProduced` is empty: execution ended with nothing for the assurance
axis to assess. A null verdict beside a non-empty artifact list is refused
(`artifacts_without_verdict`) — the record would be contradicting itself. A
`DONE` or `DONE_UNVERIFIED` receipt still cannot be written without a verdict,
because an artifact exists and FR-6.4 requires a verifier to have spoken before
"done" is shown.
