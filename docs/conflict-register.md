# Conflict register

What the repositories actually define today, where those definitions disagree,
and which disagreements this repository settles.

Package references use the organization-owned `@getsimpledirect` scope required by GitHub Packages; the deliberate `vinci-` prefix avoids claiming generic package names.

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

**Status: open. Belongs to `@getsimpledirect/vinci-run-events`.**

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

**Status: open. Belongs to `@getsimpledirect/vinci-device-auth` / platform.**

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

`WorkspaceRef` in `@getsimpledirect/vinci-contracts` uses `personal`, matching the
requirements' language (§7) and the user-facing concept. A repository storing
`'user'` maps to `kind: "personal"`; a null organization id maps to the same
arm. The mapping is explicit because three encodings of one concept is how the
"stale organization context authorizes current access" failure in FR-9.4
happens.

---

## C8 — Names this repository must not claim naively

**Status: open. Constrains adoption, not the schemas themselves.**

Reported by exploration of `vinci-work`, `vinci-chat` and `vinci-mobile`. Each
of these identifiers already exists, with a different meaning, in a repository
that would import the shared package of the same name:

| Identifier | Already means |
| --- | --- |
| `TokenScope` | `"owner"\|"collaborator"\|"viewer"` in `vinci-work/apps/server`, **and** `["client","host","activity"]` in `vinci-work/ee`. Two incompatible definitions in one repository. |
| `ApprovalMode` | `"standard"\|"cautious"\|"trusted"` in the desktop settings panel, **and** `"manual"\|"auto"` in the desktop server. Also two, also one repository. |
| `ApprovalRequest` | The remote-collaborator queue record in `vinci-work/apps/server/src/types.ts`. |
| `Actor` | `{ type: "remote"\|"host" }` in `vinci-work/apps/server` — narrower than, and incompatible with, the `Actor` in `@getsimpledirect/vinci-contracts`. |
| `CodeArtifact`, `ArtifactItem`, `FoglioArtifact`, `SharedArtifact` | Four existing artifact models across `vinci-chat`, `vinci-work` and `vinci-mobile`. |
| `Step`, `AgentRole`, `ReloadEvent` | Existing harness and event types in `vinci-chat` / `vinci-work`. |

Two of these are worth noting for what they say about the current state: both
`TokenScope` and `ApprovalMode` are *already* defined twice, incompatibly,
inside a single repository. The drift this repository exists to stop is not only
between repositories.

Adoption should import shared types under an explicit alias rather than
expecting a bare name to be free.

---

## C9 — "class" and "tier" are already load-bearing, and mean two things

**Status: open. Belongs to `@getsimpledirect/vinci-model-classes`.**

Reported by exploration of `vinci-chat` and `vinci-work`.

`class` is `vinci-chat`'s canonical word for a model tier: `ClassConfig`,
`config/classes.yaml`, `classId`, `resolveClassId()`, a `/app/classes` page, and
reserved class ids (`forte`, `fortissimo`, `vision`, `mezzo`). A package named
`@getsimpledirect/vinci-model-classes` lands directly on top of a live registry.

`tier` is worse, because it already means two incompatible things:

- `vinci-work` `INFERENCE_TIERS = ["tier1","tier2"]` — an **entitlement** level.
- `vinci-chat` `ClassConfig.tier?: number` — a **capability** rank.

A shared `tier` field would silently mean billing to one repository and
capability to the other. The shared package should avoid the bare word.

---

## C10 — The same application is called `work` and `desktop`

**Status: open. Constrains `@getsimpledirect/vinci-device-auth`.**

Reported by exploration of `vinci-chat`: `CLIENT_ALLOWLIST` and the
`client_type` DB CHECK constraints use `work`, while `MODEL_SURFACES` uses
`desktop`, for the same application. The customer-facing name is Vinci Desktop.

The database constraint is the binding one: `client_type` is checked against
`('work','code')`, so a shared type emitting `desktop` would be rejected at
write time. A source comment in that schema notes that renaming `work` to
`desktop` is intended as a deliberate expand/contract migration.

So the shared type must keep `work` as the stored value and treat "Desktop" as
display text, until that migration happens. Renaming it in a contract package
first would break writes.

---

## C11 — Four approve/deny alphabets, in one repository

**Status: open. Belongs to `@getsimpledirect/vinci-approvals`.**

Reported by exploration of `vinci-work`. All four are live:

- the permission modal replies `"once" | "always" | "reject"`;
- the server's approval service replies `"allow" | "deny"`;
- the approval-mode policy uses `"ask" | "allow" | "deny"`;
- diagnostics use `"allowed" | "approval-required" | "denied" | "unspecified"`.

Any shared vocabulary contradicts at least three of them. The FR-5.3 set
(approve once / approve narrower / deny) is closest to the modal's, which is
also the one a user actually sees.

---

## C12 — Desktop does not launch Vinci Code

**Status: open. Not a conflict — a missing foundation.**

Verified here by repository-wide search: the string `vinci-code` does not appear
anywhere in `vinci-work` — not in source, config, or documentation. The agent
process it launches is `opencode` (`RuntimeServiceName = "openwork-server" |
"opencode"`, `apps/orchestrator/src/cli.ts:208`).

§15 requires `vinci-work` to "launch and manage Vinci Code worker" and E1's exit
gate depends on it. That integration is greenfield, not an adaptation. Worth
knowing before E1 is scheduled as though it were incremental.

`vinci-work` does have a real worker lifecycle in its enterprise tree
(`WorkerStatus = ["provisioning","healthy","failed","stopped"]`), which is the
natural thing for `@getsimpledirect/vinci-worker-protocol` to reconcile with.

---

## C13 — `@getsimpledirect/vinci-policy` lands on an existing policy subsystem

**Status: open. Constrains adoption in `vinci-work`.**

Reported by exploration of `vinci-work`: there is already a desktop-policy
subsystem — `DesktopPolicyKey`, `DesktopPolicyDocument`,
`desktopPolicyValueSchema`, a `/v1/desktop-policies` API, an editor screen and a
database table — plus a `PermissionPolicy = "ask"|"allow"|"deny"`. `vinci-chat`
separately has `RolePolicy` and `RoleTierPolicy`.

These are MDM-style device policies, not run-authority policies. Both are
legitimate and they are not the same thing. The shared package should say so
explicitly, because "policy" reading as either one is how a device setting ends
up believed to constrain a run.

---

## C14 — Three run-state alphabets, and `waiting` already means something

**Status: resolved for new code; existing states need mapping at adoption.**

Reported by exploration of the three client repositories:

| Repository | Run status vocabulary |
| --- | --- |
| `vinci-work` | `"idle"\|"thinking"\|"responding"\|"error"\|"compacting"\|"waiting"` (UI), `"idle"\|"busy"\|"retry"` (engine wire) |
| `vinci-chat` | `'submitted'\|'streaming'\|'ready'\|'error'`, and `'running'\|'done'` for code runs |
| `vinci-mobile` | untyped `string`; observed `'thinking'\|'searching'\|'researching'` |

`vinci-work`'s `"waiting"` already means "blocked on a permission or question" —
precisely the role `WAITING_FOR_APPROVAL` plays in `RunState`, spelled
differently and in a different case.

None of these describe a governed run; they describe a chat turn or an engine
connection. They are not prior art for `RunState` and should not be widened into
it. They do need an explicit mapping wherever a surface starts reporting runs.

One useful accident: `DONE_UNVERIFIED`, `WAITING_FOR_APPROVAL` and
`VERIFIED_PASS` appear nowhere in these three repositories, and every existing
status union is lowercase. The SCREAMING_SNAKE convention inherited from
Acceptance is therefore collision-free, if stylistically foreign.

---

## C15 — There is no policy contract to reconcile with

**Status: open. `@getsimpledirect/vinci-policy` is greenfield.**

Verified here: `vinci-acceptance/packages/policy-engine/src/index.ts` contains
exactly one line, `export const PACKAGE_NAME = "policy-engine";`. No policy
record, no sections, no decision result, no reason codes.

`Verdict.policyVersion` is a free-form string, currently stamped
`"wave0e-stub-v1"` by the deterministic evaluator.

So the policy manifest has no incumbent vocabulary constraining it — unusually
for this work, it can be designed from the requirements rather than negotiated
against something shipping. The constraint is C13: it must not be confused with
`vinci-work`'s device policies.
