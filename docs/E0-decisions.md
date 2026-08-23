# E0 — Contract decisions

Status: proposed. Scope: Epic E0 only (§17). This repo contains schemas and types.
It contains no application logic and no UI (§16).

The exit gate this repo exists to satisfy (§17, E0):

> all repositories can import the same contract definitions;
> no repository independently defines conflicting run states.

## D1 — Three state vocabularies, not one, and not three types

The requirements define overlapping sets of state names in two places, and
`vinci-code` already ships a third at runtime:

| Source | Members |
| --- | --- |
| FR-2.2 run states (12) | `CREATED` `PLANNING` `RUNNING` `WAITING_FOR_APPROVAL` `WAITING_FOR_USER` `PAUSED` `VERIFYING` `DONE` `DONE_UNVERIFIED` `BLOCKED` `FAILED` `CANCELLED` |
| FR-6.2 receipt final states (6) | `DONE` `DONE_UNVERIFIED` `WAITING` `BLOCKED` `FAILED` `CANCELLED` |
| FR-7.2 verdicts (5) | `VERIFIED_PASS` `CONDITIONAL` `BLOCKED` `FAILED` `CANCELLED` |
| `vinci-code` `VinciTaskState` (4, shipping) | `DONE` `DONE_UNVERIFIED` `WAITING` `BLOCKED` |

These are not three spellings of one concept, and collapsing them would violate
FR-6.2 ("must not collapse these into a generic 'completed' state"). They are
three distinct types with two total mappings between them:

- **`RunState`** — the live state machine (FR-2.2). What a run *is* right now.
- **`TerminalState`** — the final state recorded on a receipt (FR-6.2). What a
  run *ended as*.
- **`Verdict`** — an assessment issued by Acceptance about evidence (FR-7.2).
  Not a run state at all: a run can be `DONE_UNVERIFIED` with no verdict, or
  `DONE` with a stale one.

Two frictions are resolved deliberately rather than papered over:

1. `RunState` distinguishes `WAITING_FOR_APPROVAL` from `WAITING_FOR_USER`;
   `TerminalState` has only `WAITING`. This is correct — the distinction drives
   the Mobile pending-decision queue (FR-5.1) while a run is live, and stops
   mattering once the receipt is written. `terminalStateOf()` maps both to
   `WAITING`.
2. `RunState` has no `WAITING` member and `TerminalState` has no `PAUSED`,
   `RUNNING`, `PLANNING`, `CREATED` or `VERIFYING`. `terminalStateOf()` is
   therefore **partial by design** and returns `null` for a non-terminal run.
   A `null` return is not an error; it is the answer "this run has not ended".

`vinci-code`'s shipping `VinciTaskState` is a **strict subset** of
`TerminalState`. Adopting `TerminalState` there is additive — it gains `FAILED`
and `CANCELLED`, and no existing persisted value changes meaning. No migration
of existing records is required.

`vinci-code` already implements verdict→state collapse in
`remoteVerdictTaskState()` (`vinci/extensions/lib/task-outcome.ts`). That
function becomes `terminalStateOfVerdict()` here and is imported rather than
reimplemented, so Code and Acceptance cannot drift apart by hand-copied switch
statement. Its existing behaviour is preserved exactly, including the two cases
that return "no change": a `CANCELLED` verdict and a staled record both leave
the local state authoritative.

## D2 — Package graph is acyclic, with one base

§16 names nine packages. Their dependency direction is fixed here so that no
consumer can create a cycle:

```text
                         @vinci/contracts          (no dependencies)
                                 |
     +----------+----------+-----+-----+-----------+------------+
     |          |          |           |           |            |
  policy   model-classes evidence  approvals  device-auth       |
     |          |          |           |                        |
     +----------+----+-----+-----+-----+                        |
                     |           |                              |
                 receipts    run-events ----------------------- +
                     |           |
                     +-----+-----+
                           |
                    worker-protocol
```

`@vinci/contracts` holds only what every other package needs: identifier types,
actor and timestamp shapes, the schema-envelope machinery from D3, and the
glossary nouns of §7.

`Verdict` lives in `contracts` rather than in `evidence`, even though a verdict
is an assessment *of* evidence. The deciding factor is
`terminalStateOfVerdict()`: it is the single function preventing Code and
Acceptance from drifting apart on how a verdict collapses into a final state,
and it must sit beside the `TerminalState` it returns. Putting `Verdict` in
`evidence` would force `contracts` to depend on `evidence` and invert the graph.
`@vinci/evidence` still owns the evidence records and the staleness rules that
reference the verdict.

`scripts/check-dependency-graph.mjs` enforces this in CI. A package that imports
"upward" fails the build rather than being caught in review.

## D3 — Every schema carries its own compatibility contract

§16 requires six things of every schema: version, validation, backward-
compatibility policy, migration approach, malformed-data behavior, and
unknown-field behavior. Stating those in prose per schema guarantees they rot.

Each package therefore exports a machine-readable `SchemaMeta` alongside its
types, and a conformance test asserts that every exported schema has one. The
six requirements become fields, not documentation.

## D4 — Fail closed on malformed, preserve on unknown

These are opposite behaviours and are frequently conflated. They are separated:

- **Malformed data fails closed.** A record that does not validate is rejected.
  It is never coerced, defaulted, or partially accepted. This follows FR-4.8
  ("if Governor cannot determine whether an action is permitted, the action must
  not proceed") and SR-6 ("must not silently substitute a weaker guarantee").
- **Unknown fields are preserved, not dropped.** Events are append-only and
  replayed (FR-2.3), and receipts are exported and re-imported (FR-6.5). A newer
  producer's fields must survive a round-trip through an older consumer, or the
  append-only log silently loses data. Unknown fields are retained verbatim and
  excluded from validation.

There are two exceptions, and they share a shape: **preserve an unknown field
wherever losing it costs a round trip; reject it wherever keeping it lets the
system assert something untrue.**

*Unrecognised state and verdict members.* These are rejected rather than
preserved. Preserving one lets it reach a display layer, and FR-6.4 forbids
showing "Verified" without a current, correctly-associated evaluation. A value
nothing recognises must not be rendered as anything.

*Unrecognised fields under `/credentials`.* Also rejected. An unknown field
there may be secret material, and preserving it puts a secret inside a record
that FR-6.5 exports and SR-3 says must never carry secrets. Here preserving is
strictly worse than dropping, and dropping is worse than refusing the policy.

The second exception was found by review, not by design. The credential section
originally excluded secrets with a denylist of twelve field names, which passed
`clientSecret`, `secretAccessKey`, `connectionString` and every name a future
provider invents. A denylist cannot express a security boundary — it is only as
good as the imagination of whoever wrote it. The rule is an allowlist:
under `/credentials`, a field not explicitly known is refused.
