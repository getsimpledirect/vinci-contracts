# E0 — Contract decisions

Status: **accepted for internal adoption, v0.1** (2026-08-24). Scope: Epic E0 only
(§17). This repo contains schemas and types. It contains no application logic and
no UI (§16).

"Proposed" was left on this document after PR #1 merged into `main`. That is a
small ambiguity which becomes an expensive one: a consumer cannot tell whether
the package is safe to depend on or still experimental, and those two readings
imply opposite behaviour.

Accepted for internal adoption means the vocabularies, authority rules, verdict
and receipt semantics, and run-state definitions are stable enough for the five
internal repositories to import. It does **not** mean frozen. It means a change
to authority, verdict, receipt, or run-state semantics now requires an explicit
compatibility decision recorded here, rather than an edit.

External stability is not claimed. Nothing outside this organization depends on
these packages, and v0.1 says so.

Package references use the organization-owned `@getsimpledirect` scope required by GitHub Packages; the deliberate `vinci-` prefix avoids claiming generic package names.

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
function becomes `terminalStateOfVerification()` here and is imported rather than
reimplemented, so Code and Acceptance cannot drift apart by hand-copied switch
statement. Its existing behaviour is preserved exactly, including the two cases
that return "no change": a `CANCELLED` verdict and a staled record both leave
the local state authoritative.

## D2 — Package graph is acyclic, with one base

§16 names nine packages. Their dependency direction is fixed here so that no
consumer can create a cycle:

```text
                         @getsimpledirect/vinci-contracts          (no dependencies)
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

                    remote-protocol
                           |       |
                    session-stream worker-capabilities
```

`@getsimpledirect/vinci-contracts` holds only what every other package needs: identifier types,
actor and timestamp shapes, the schema-envelope machinery from D3, and the
glossary nouns of §7.

`Verdict` lives in `contracts` rather than in `evidence`, even though a verdict
is an assessment *of* evidence. The deciding factor is
`terminalStateOfVerification()`: it is the single function preventing Code and
Acceptance from drifting apart on how a verdict collapses into a final state,
and it must sit beside the `TerminalState` it returns. Putting `Verdict` in
`evidence` would force `contracts` to depend on `evidence` and invert the graph.
`@getsimpledirect/vinci-evidence` still owns the evidence records and the staleness rules that
reference the verdict.

`scripts/check-dependency-graph.mjs` enforces this in CI. A package that imports
"upward" fails the build rather than being caught in review.

`session-stream` sits above `remote-protocol`: its frames carry the remote
protocol version and session identity, while also using the base run and
timestamp types. This keeps the ephemeral display transport from becoming an
upward dependency of the durable run-event package.

`worker-capabilities` also sits above `remote-protocol`: it projects the
authority vocabulary into the controls an adapter can actually enforce. It is
beside, and does not depend on, `session-stream`.

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

**What "preserved" means.** Unknown fields round-trip by VALUE, not by
reference. Validation normalizes its input into a deep, frozen snapshot, so a
validated record shares no object with the input it validated. That distinction
is not pedantic: retaining the caller's nested objects meant a validated record
could be changed after validation by mutating what was handed in, and a test
asserted that identity-sharing as though it were the guarantee.

The second exception was found by review, not by design. The credential section
originally excluded secrets with a denylist of twelve field names, which passed
`clientSecret`, `secretAccessKey`, `connectionString` and every name a future
provider invents. A denylist cannot express a security boundary — it is only as
good as the imagination of whoever wrote it. The rule is an allowlist:
under `/credentials`, a field not explicitly known is refused.

## D5 — Version lives on the wire, twice, for two different questions

`SessionBinding` carries `protocolVersion` and `schemaVersion` as required
fields, each checked against a single in-build source of truth
(`REMOTE_PROTOCOL_VERSION` and `SESSION_BINDING_SCHEMA_META.version`).

Two independently-deployed programs meet at this record: a host that may be a
months-old Vinci Code install, and a relay deployed this morning. Nothing in the
record said which protocol either side spoke. Version skew therefore presented
as a validation failure on whichever field happened to change between the two
builds — an accurate error about the wrong thing — or, in the worse case, as a
clean parse of a record that meant something else.

They are two fields rather than one because they answer different questions. A
protocol can add a message type without changing this record's shape, and this
record's shape can change within one protocol. `protocolVersion` asks whether
the two peers can talk at all; `schemaVersion` asks whether this particular
record means what its reader thinks it means.

Both are refused on mismatch rather than tolerated, which is FR-4.8 at the
network boundary: if we cannot determine what the other side meant, the session
does not proceed. Absent is refused too — a binding with no version is one
written before the field existed, which is the skew case, not a default.

The cost is real and accepted: bumping either number makes every record from
every older build refuse, loudly, at the boundary. That is the intended
behaviour. The alternative is a silent misread, and a receipt asserting
something untrue is more expensive than a session that will not start.

## D6 — The five policy-matching decisions, ratified

The matching algorithm in `evaluatePolicyDecision` was specified nowhere — not
in the types, not in the manifest comments, not in this document. It had to be
invented to write the function, and five choices were made in the writing. They
are recorded because the implementing agent reported "AMBIGUITIES: None — the
specification was unambiguous on all points", which was false: the questions
were undefined rather than settled. Choosing is fine. Reporting that there was
nothing to choose hides the choices from whoever lives with them.

All five are ratified as written (George, 2026-08-24):

1. **Capability matching is exact equality.** A rule for `deploy` governs
   `deploy` and nothing else. The cost — every capability must be enumerated —
   is the point. Prefix matching would let that rule govern `deployment-notes`.
2. **Most restrictive wins:** `deny` > `require_approval` > `allow_automatically`.
   The alternative, document order, makes authority depend on where a rule was
   pasted.
3. **No matching rule is `undetermined`, not `denied`.** Neither permits the
   action; collapsing them destroys the audit distinction between "policy has
   nothing to say" and "policy says no".
4. **`any_action` is a fallback, not a participant.** It applies only when no
   capability or side-effect rule matched, so a catch-all cannot override a
   specific rule written later.
5. **Undetermined reason codes map to concrete conditions,** assigned at each
   return site rather than loosely.

Each has a named test that fails if the behaviour is reverted, so ratified means
enforced rather than annotated. Each is also a change to how authority is
granted, and each relaxation would look like a small convenience change to
whoever made it — which is why changing one is now a compatibility decision
recorded here rather than an edit.

Namespacing (`deploy:*`) stays a feature to design deliberately if real policies
need it. It is not a default to slip into.

## D7 — Session frames are ephemeral display transport, not run history

`@getsimpledirect/vinci-session-stream` is the human-facing stream for a live
remote session. Its frames carry bounded current-action, tool, diff, question,
warning, artifact-preview, and redaction-notice content. They are explicitly
marked `retention: "ephemeral"` and must not be persisted or replayed as though
they were `RunEvent` records.

The two envelopes are intentionally mutually exclusive. Session frames use
`protocolVersion`, `sessionId`, `seq`, `at`, `kind`, and `body`; durable run
events use their versioned event envelope. A question frame correlates to the
content-minimized durable `run.question` event by `questionId`, while its prompt
exists only in the ephemeral stream. Model chain-of-thought is not a frame kind
and cannot be added as unrecognised content because both envelope and body
fields are closed.

Size enforcement is a receiver-side refusal, not automatic truncation. The host
may truncate a diff and truthfully set its `truncated` flag before sending it;
an oversized frame or hunk received on the wire is rejected. Sequence zero is
valid, and every later accepted frame must be exactly one greater than the
previous value so gaps and replays are distinguishable.

## D8 — Worker trust is derived, and controls require demonstrated capability

A worker declaration may state a control level, but that statement is not the
source of trust. The adapter's demonstrated capability matrix is the source,
and the control level is derived from it. A declaration above the derived level
is refused; a declaration below it is allowed because a worker may decline to
claim everything its adapter demonstrated.

The same matrix is the sole source for remote controls shown by Admin. A
control is rendered only when the adapter has demonstrated that it can enforce
the corresponding command. This is a product truthfulness boundary: showing a
pause, restriction, approval, steering, or abort control that the adapter
cannot carry out would offer authority the system does not have.
## D9 — Work contracts change by amendment, never by erasure

D7 is intentionally not used here because it is already allocated on another
branch. This decision takes D8 so the histories can merge without making two
different decisions share an identifier.

Acceptance criteria are fixed before consequential execution begins. Editing a
criterion after execution turns the test into a description of what happened:
the worker could always be made to pass by moving the target over its result.
The durable work contract therefore has its own monotonic `contractVersion`.
Version 1 has no predecessor; every later version identifies the immediately
preceding version and the amendment that created the transition. The work order
id remains stable because it identifies the work, while the contract version
identifies which terms governed it.

An amendment records who changed the contract, when, why, and which closed-set
fields changed. Changes to acceptance criteria, scope, or granted authority are
material and make a current verification stale. Request wording, attention
budget, and an expiry extension are editorial and preserve current verification.
A stale verdict remains immutable history, but is no longer current for the new
contract version.

Criterion ids are semantic identities, not array keys. Verdicts are pinned to
them, so reusing an id for a different statement or verification method would
make old evidence appear to verify new terms. A changed criterion is represented
as removal of the old id and addition under a new id; it is never rewritten in
place.

Adding required `contractVersion` and conditional `supersedes` fields is not
purely additive, and `WorkOrder` was already declared frozen. D3 requires every
schema to carry its own compatibility contract, and a newly required field is a
compatibility break by that contract's own terms, so `WorkOrder.schemaVersion`
and `WORK_ORDER_SCHEMA_META.version` move from 1 to 2.
Migration is explicit: a legacy schema-v1 work order becomes schema v2 with
`contractVersion: 1` and no `supersedes`. Validation does not silently supply
that value, because doing so would hide which records were actually migrated.
`ContractAmendment` begins independently at schema version 1.
## D10 — Human attention is a measured institutional cost

The number is assigned at merge. Three open changes currently contest the
post-D6 numbering, so the heading deliberately does not guess it.

The attention budget on a work order is a bound. It says how much interruption
and decision-making a run may demand, not how much it actually demanded. The
run-event stream now records the measured seconds for each answered question
and approval decision, and `run.completed` records aggregate seconds,
interruptions, decisions, and escalations. The surface that presented the
question or decision (Mobile, Web, or TUI) measures its wall-clock seconds.

The receipt carries the same aggregate as required `humanAttention` data, and
its digest covers that block. This is a measurement of institutional cost, not
of a person: it records how many seconds a decision took, never what the person
did during them. No per-human identity is added. The aggregate helper divides
all recorded human-attention seconds by only `VERIFIED_PASS` receipts. A
`CONDITIONAL` or `BLOCKED` receipt still consumed attention and therefore stays
in the numerator, but is not a verified outcome. Zero verified outcomes yields
`null`, never infinity and never zero presented as "free".

Both wire schemas bump from 1 to 2. The run-event schema is frozen and explicitly
requires a version bump for a new event type or payload field. The receipt adds
a newly required field; under D3's per-schema compatibility contract that is a
compatibility break, so `receiptVersion` and the receipt schema metadata also
bump to 2. Package versions remain in repository lockstep at 0.1.0.
Version-1 records are rejected rather than backfilled: the missing measurement
cannot be inferred after the fact without inventing institutional-cost data.
## D11 — Per-action autonomy and adapter trust are independent axes

**

An autonomy rung belongs to one requested action. It says how far that action
may proceed on its own: observe, recommend, sandbox, reversible,
bounded-production, or human-reserved. Adapter trust is a separate axis. It
describes what an adapter can enforce, using its own inventoried → observed →
supervised → governed → assured ladder. A highly trusted adapter does not make
an irreversible action autonomous, and a low-risk action does not prove that an
adapter can enforce its boundary. Policy and UI surfaces must not substitute
one axis for the other.

The worker may report a claimed reversibility class, but that claim is advisory
because the worker is the party asking for authority. Treating its assertion as
the authority check would let a request widen its own permission by relabelling
an irreversible side effect. Evaluation therefore reads only the host- or
policy-classified reversibility record; the worker claim remains available for
audit and disagreement detection.

Defaults fail closed at both boundaries. A consequential action class missing
from `autonomyCeilings` is treated as `human_reserved`, so it cannot be
automatically allowed. The irreversible-without-approval allowlist defaults to
empty, and a conditionally reversible action without an available checkpoint is
treated as irreversible. These defaults require an explicit policy edit before
authority expands; schema or producer omission never grants it.
