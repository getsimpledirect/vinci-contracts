# Conflict register

What the repositories actually define today, where those definitions disagree,
and which disagreements this repository settles.

The E0 exit gate is "no repository independently defines conflicting run
states" (§17). Reaching it required finding the conflicts first. Several were
not visible from the requirements document, because the requirements describe
an intended vocabulary and the repositories ship a different one.

Each entry says how it was established. "Verified here" means the file was read
directly during this work; nothing in this register is inferred from the
requirements alone.

---

## C1 — A verifier can issue three verdicts, and two consumers switch on five

**Status: resolved in this repository.**

| Source | Members |
| --- | --- |
| `vinci-acceptance` `VerdictStatus` (producer) | `VERIFIED_PASS` `BLOCKED` `CONDITIONAL` |
| `vinci-code` `RemoteAcceptanceVerdict["status"]` (consumer) | `VERIFIED_PASS` `BLOCKED` `CONDITIONAL` `FAILED` `CANCELLED` |
| FR-7.2 (requirements) | `VERIFIED_PASS` `CONDITIONAL` `BLOCKED` `FAILED` `CANCELLED` |

Verified here: `vinci-acceptance/packages/protocol/src/types.ts:26` declares
the three-member union, and `AcceptanceJob.verdict` is optional on the same
line's interface.

`FAILED` and `CANCELLED` are not assessments. They are states of the
verification *job*, and a job that fails or is cancelled produces no assessment
at all. Two arms of `vinci-code`'s `remoteVerdictTaskState()` switch are
therefore unreachable from any real Acceptance verdict.

Resolution: `VerdictStatus` has the three members the producer can emit.
The two job outcomes are preserved as the `not-issued` arm of
`VerificationOutcome`, so every FR-7.2 name survives and a consumer must handle
"there is no verdict" before it can read a status. See
`packages/contracts/src/states.ts`.

---

## C2 — A verification job is not a run, and they have separate state machines

**Status: resolved in this repository (both vocabularies kept, mapped).**

`vinci-acceptance` ships an eleven-state machine with a real transition table
(`packages/protocol/src/types.ts:3`, `packages/protocol/src/state-machine.test.ts`):

```text
CREATED CONTRACTING PLANNING QUEUED PROVISIONING RUNNING
APPROVAL_REQUIRED FINALIZING COMPLETED FAILED CANCELLED
```

FR-2.2 specifies a different twelve-state machine for runs. They share only
`CREATED`, `PLANNING`, `RUNNING`, `FAILED`, `CANCELLED`, and the shared names do
not mean the same thing: a job's `RUNNING` means checks are executing, a run's
`RUNNING` means the worker is working.

These are two entities, not one vocabulary that drifted. An Acceptance job is a
verification *about* a run's artifact, with its own lifecycle. A run enters
`VERIFYING`; a job then runs its own course and may or may not emit a verdict.

Resolution: `RunState` and the job's state machine stay separate types.
`COMPLETED` is legitimate for a job — it means "an assessment now exists" — and
remains forbidden for a run, where FR-6.2 requires that `DONE` and
`DONE_UNVERIFIED` never collapse into one completed state.

---

## C3 — A run waiting for a human renders as "Result unavailable"

**Status: a live defect in `vinci-platform`. Not fixed here — out of E0 scope.**

Verified here, in `vinci-platform/components/acceptance/ActivityFeed.tsx`:

- Line 282 calls `verdictPill(job.verdict?.status, job.state)`.
- Line 125 branches on `status === 'APPROVAL_REQUIRED'` to render "Waiting for you".
- `APPROVAL_REQUIRED` is a **job state**, never a verdict status (C1). The
  branch is unreachable.
- When a job really is in `APPROVAL_REQUIRED`, no verdict exists, so `status` is
  `undefined`. Control falls through to the state checks. `APPROVAL_REQUIRED` is
  not `FAILED`, not `CANCELLED`, and is absent from `IN_PROGRESS_MILESTONES`
  (lines 9–17), so `isInProgress` is false.
- The result is the fallback at line 154: **"Result unavailable"**.

The exact moment a user is being asked to approve something is the moment the
UI tells them nothing is available. This is what UX-2 (honest status) and FR-5
(the approval centre) exist to prevent.

The unit test at `components/acceptance/__tests__/ActivityFeed.test.tsx:139-145`
covers the dead branch with a payload the producer cannot emit — `state:
'COMPLETED'` carrying `verdict.status: 'APPROVAL_REQUIRED'`. The branch is
certified by a shape that does not occur, so the test passes and the real case
stays broken.

Both halves of this trace back to one cause: the boundary is untyped. See C4.

---

## C4 — The Acceptance boundary is typed as `string`

**Status: this repository provides the types. Adoption is the fix.**

`vinci-platform/lib/acceptance/client.ts:15,17`:

```ts
state: string;
verdict?: { status: string; human_copy: string };
```

Both fields have closed unions on the producer side. Typing them as `string`
across the boundary is what allows C3 to compile: a branch on a value the union
cannot hold raises no error, and a new upstream state silently becomes
"Result unavailable" rather than a build failure.

---

## C5 — Two event vocabularies, neither a subset of the other

**Status: open. Belongs to `@vinci/run-events`.**

`vinci-acceptance` ships 23 event types
(`ACCEPTANCE_EVENT_TYPES`, `packages/protocol/src/types.ts:24`), FR-2.3
specifies 20 run events. The overlap is partial and the names differ for the
same concepts:

| Concept | Acceptance | FR-2.3 |
| --- | --- | --- |
| creation | `job.created` | `run.created` |
| approval settled | `approval.granted` / `approval.denied` | `approval.resolved` |
| verdict stored | `verdict.issued` | `verdict.recorded` |

Acceptance's split of `granted`/`denied` carries information that
`approval.resolved` only carries in a payload field. That is the better shape
and should win.

---

## C6 — Three roles exist; seven are required

**Status: open. Belongs to `@vinci/device-auth` / platform.**

Reported by exploration of `vinci-platform` and consistent with what was read
here: the only role strings in that repository are `owner`, `admin`, `member`
(`components/organization/OrganizationManager.tsx:24`). FR-9.2 requires seven,
adding `operator`, `approver`, `auditor` and `read-only viewer`.

`approver` is the one that blocks a functional requirement rather than a
reporting nicety: FR-4.7 requires approval rules that name a role, and FR-5
requires an approval centre. Neither can express "any approver" today.

The union is also declared inside a React component and re-derived as ad-hoc
string comparisons in at least four server-side gates, so there is no single
place to widen.

---

## C7 — "Personal" and "user" name the same side of one distinction

**Status: resolved in this repository by naming the mapping.**

Reported by exploration of `vinci-platform`: `ActiveContext` uses
`type: 'personal'`, while `SpendOwner` and the `owner_type` CHECK constraints
use `'user'`, and `api_keys` / `usage_counters` encode the same idea a third
way as `org_id IS NULL`.

`WorkspaceRef` in `@vinci/contracts` uses `personal`, matching the
requirements' language (§7) and the user-facing concept. A repository storing
`'user'` maps to `kind: "personal"`; a null organization id maps to the same
arm. The mapping is explicit because three encodings of one concept is how the
"stale organization context authorizes current access" failure in FR-9.4
happens.
