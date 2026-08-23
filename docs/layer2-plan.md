# Layer 2 — `@vinci/receipts` and `@vinci/run-events`

E0 is frozen at `b35a188`. This work happens on `layer2/receipts-run-events`;
`main` does not move, and no E0 package is modified. Layer 2 integrates only
after its own gate and its own independent review.

## Governing contract, inventoried

Both packages sit at layer 2 — a position the dependency checker already
declares — so they may depend on `@vinci/contracts` and on any layer-1 package,
and nothing may depend on them except `@vinci/worker-protocol`.

What E0 already provides, and must therefore not be redefined:

| Needed by layer 2 | Comes from |
| --- | --- |
| `TerminalState`, `RunState`, `VerdictStatus` | `@vinci/contracts` |
| `Actor`, `Timestamp`, branded ids, `WorkspaceRef` | `@vinci/contracts` |
| `SchemaMeta`, `ValidationResult`, `ok`/`fail`, `toPlainRecord` | `@vinci/contracts` |
| evidence provenance and staleness | `@vinci/evidence` |
| approval requests, decisions, grants | `@vinci/approvals` |
| model and provider provenance, residency | `@vinci/model-classes` |
| policy manifest and version | `@vinci/policy` |

FR-6.1 names roughly twenty-five receipt fields. Most are references into the
above; the genuinely new work is the receipt digest, the correction record, and
the event stream.

## Scope — deliberately narrow

**In:** schemas, types, validators, `SchemaMeta`, tests.

**Out:** anything that writes, stores, transmits or renders a receipt or an
event. No storage, no serialization format beyond JSON, no ordering service, no
replay engine. Those belong to whatever consumes these contracts, and E0's rule
that this repository holds schemas and types only is unchanged.

## The failure classes, designed against up front

Fifteen E0 cycles produced fifteen defects in three recurring shapes. Layer 2
carries more of this risk than layer 1, not less: a receipt is the artifact
asserting whether work was verified, and an event stream is the record of what
happened. Both are exported and replayed, so anything they *can* carry will be
read somewhere.

**A. A security property asserted by an enumeration rather than enforced by a
shape.** Five instances in E0 — a denylist of secret field names, a digest field
validated as "a non-empty string", a regex scrub over free text, provenance and
actor as two unrelated enums, a prohibition existing only as a type narrowing.
Every field that must not carry something gets a shape that cannot express it,
never a list of things to look for.

**B. A guard that a second path routes around.** Six instances. Reading the
guard tells you nothing; every route into the guarded state has to be
enumerated. For layer 2 that means: every way to construct a receipt, and every
way to reach `DONE`.

**C. Evidence that certifies nothing.** The last four E0 defects were in tests,
claims, and commit messages rather than implementation — three vacuous tests, a
false stated guarantee, an inaccurate commit message. Every new test here is
checked for its ability to FAIL before it is trusted.

## Specific traps, named before writing code

- **A digest covering a subset of its record.** Fields outside the hash can be
  edited while the receipt still verifies.

  This has to be settled before any code, because the test only means something
  if this package actually computes the digest. Validating that a digest LOOKS
  like a digest proves nothing about coverage.

  Decision: this package implements the digest, because it is a contract
  concern. Two systems that disagree about how a receipt hashes cannot check
  each other's receipts, which is the entire point of having one.

  The boundary, stated exactly:

  - **Covered:** every field of the receipt except `digest` and `signature`.
  - **Not covered:** `digest` itself, which cannot contain its own hash, and
    `signature`, which is computed over the digest.
  - **Canonicalization:** two separate steps, and an earlier draft of this plan
    conflated them.

    `toPlainRecord` does NOT sort keys. It serializes and reparses, which
    preserves JSON property order — verified: `{b:1,a:2}` and `{a:2,b:1}`
    normalize to different byte sequences, and no stable-stringify utility
    exists anywhere in `packages/contracts`. Claiming key ordering as a property
    it provides would have made the whole digest design false, since two
    receipts with identical content and different key order would digest
    differently.

    So: `toPlainRecord` is kept for what it does provide — an inert, frozen,
    fidelity-checked snapshot — and a SEPARATE deterministic canonicalizer is
    implemented and tested here. It sorts object keys recursively at every
    level, preserves array order (position is meaning in an array, not
    incidental), and specifies number and string encoding explicitly rather than
    inheriting whatever `JSON.stringify` happens to do.

    Tested with same-content/different-insertion-order pairs at several nesting
    depths, not just at the top level.

  - **Not banked until independently reproduced.** A digest is a wire format:
    once anything stores one, its exact bytes are a compatibility surface. No
    hash value goes into a test fixture or a stored record until a second,
    independent implementation agrees on the exact bytes for the same input.
    Until then the tests assert PROPERTIES — same content hashes the same,
    different content hashes differently, every covered field changes it — never
    a literal digest string.

  Only with that in place is the mutate-each-field test meaningful: it drives
  off the covered-field list, so a field added later is covered automatically
  rather than when someone remembers to extend a test. The two uncovered fields
  are asserted uncovered, so the exclusion is deliberate and visible rather than
  an oversight.
- **"Verified" reachable without a current verdict.** FR-6.4 permits the word
  only when an approved verifier evaluated the relevant current state, the
  evidence is bound to the correct artifact version, and nothing has invalidated
  it since. Three conditions. A boolean cannot hold three conditions, so the
  type will not be a boolean.
- **Correction that rewrites.** FR-6.7 requires a false-completion report to
  APPEND.

  What this package can deliver, bounded honestly: a correction is a distinct
  record carrying `supersedes` and an actor, a receipt's lineage is checkable,
  and a chain that rewrites rather than appends can be DETECTED. It follows the
  shape `vinci-acceptance` already uses.

  What it cannot deliver: durable append-only enforcement. Whether a stored
  receipt is ever overwritten is a property of the store, and a package of
  schemas and types has no store. `vinci-acceptance` gets that from database
  triggers, and this layer has no equivalent. Saying "mutating a prior receipt
  is unrepresentable" — as an earlier draft of this plan did — would be exactly
  the kind of guarantee this repository has already shipped twice and had to
  retract. The consumer enforces immutability; this layer makes a violation
  visible.
- **Event payloads carrying free text.** DR-3 forbids prompts, responses, files,
  memories, evidence content and secrets in operational telemetry; FR-2.3 says
  content-minimized. This is the same defect the approvals notification had, and
  takes the same fix: the payload cannot hold free text, rather than being
  scrubbed of it.
- **Ordering and idempotency asserted in a comment.** FR-2.3 requires events be
  idempotent, ordered within a run, append-only after acceptance, and safe to
  replay. Each is a property something must enforce or the schema must make
  checkable.

## Ground truth to codify, not re-derive

**Receipts.** `vinci-code` emits `VinciTaskOutcome` with thirteen fields and
**no receipt hash anywhere** — confirmed by direct read during E0. FR-6.6 wants
content hashing, artifact digests, evidence digests, a parent reference and an
optional signature. All greenfield. Final states come from `TerminalState`; there
is no generic "completed", and FR-6.2 forbids adding one.

`vinci-acceptance` already does append-only correction well: verdicts are
immutable at the database level and a correction inserts a new version carrying
`supersedesVerdictId` and an actor. Receipts should follow that shape.

**Run events.** Two vocabularies, neither a subset of the other (register C5).
FR-2.3 names twenty run events; `vinci-acceptance` ships twenty-three for
verification jobs. Names differ for the same concepts — `job.created` versus
`run.created`, `approval.granted`/`approval.denied` versus `approval.resolved`,
`verdict.issued` versus `verdict.recorded`. Acceptance's granted/denied split
carries information that a single resolved event only holds in a payload field;
that shape should win.

A run is not a verification job (register C2): `RunState` and the job state
machine stay separate, and the event vocabularies do not merge.

Acceptance's event record is the model — `schemaVersion`, `id`, `jobId`,
`sequence`, `type`, `actor`, `payload`, `occurredAt`, `idempotencyKey`,
`traceId` — with ordering enforced by a unique `(job_id, sequence)` and a
positive-sequence check. One discrepancy not to repeat: its JSON Schema permits
`sequence = 0` while its database requires `> 0`.

## The two packages do not depend on each other

An earlier draft said both that receipts reference events and that the packages
are independent. Those cannot both be true, and the second is the one that
holds.

Both sit at layer 2, and the dependency checker forbids same-layer dependencies
outright — `depLayer >= own` is an error, not just upward edges. So
`@vinci/receipts` cannot import from `@vinci/run-events`, and will not.

A receipt therefore references events the way it references anything outside its
own package: by identifier. It carries event ids and a run id as plain branded
strings, resolvable by whatever holds the log, and imports no event type. That
is a weaker coupling than a type import, and it is the correct one — a receipt
should be readable by something that never loads the event package.

## Sequence

Order is a review convenience, not a dependency:

1. `@vinci/run-events`
2. `@vinci/receipts`
3. Full gate, then an independent execution review on an engine that did not
   write the code.

## Deliberate deviation from D4, recorded

`@vinci/run-events` sets `unknownFields: "reject"` and `compatibility: "frozen"`.
D4 names events *specifically* as preserving unknown fields, so this is a
departure from an E0 decision and is recorded rather than left to be discovered.

Two E0 principles genuinely conflict for this schema:

- **D4** wants preservation, because losing a newer producer's field costs
  replay fidelity through an older consumer.
- **DR-3** forbids operational telemetry carrying prompts, responses, files,
  memories, evidence content or secrets, and **FR-2.3** requires
  content-minimization.

An unknown field is exactly a place content can sit unexamined. The payload
allowlist exists so content has nowhere to go; preserving unknown fields at the
envelope would reopen at one level precisely what the allowlist closes at the
other. The approvals notification already showed what "we will filter it later"
is worth.

Content-safety wins, because DR-3 is a prohibition while replay fidelity is a
compatibility convenience. Both halves of the cost are stated plainly:

- this log does **not** round-trip through older consumers;
- every new event type or payload field is a **version bump**, not a free
  addition — which is why the compatibility policy is `frozen` and not
  `additive-only`.

Declaring `additive-only` beside a validator that rejects unknown fields would
have claimed a compatibility this schema does not provide — the same defect as a
`SchemaMeta` advertising behaviour its validator lacks, which this repository
has shipped twice.

If replay fidelity later proves to matter more than this, the way to get it is a
content-safe preservation envelope — a place for unrecognised fields that is
structurally incapable of being read as event content — not by relaxing the
validator and restating the claim.
