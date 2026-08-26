# @getsimpledirect/vinci-contracts

Shared types and validators for the Vinci platform, used by five repositories (vinci-code, vinci-work, vinci-mobile, vinci-platform, vinci-chat) that currently maintain drifting local copies. This monorepo closes that divergence by defining one canonical set of record types, their shapes, and their validation rules—so teams can build against the same definitions instead of against guesses about what they meant to agree on.

Package names use the organization-owned `@getsimpledirect` scope on the public npm registry. The deliberate `vinci-` prefix keeps these contracts namespaced without claiming generic package names.

## The Layer Hierarchy

This repository enforces a strict downward dependency rule: a package may depend only on packages in lower layers, never on its own layer or above. The rule is checked by the gate across package manifests, TypeScript imports, tsconfig project references, and tsconfig path aliases including extends chains. A circular dependency anywhere fails the build, because each layer's validator cannot safely invoke one from a higher layer. The table below is the layering `scripts/check-dependency-graph.mjs` enforces; if they ever disagree, the script is right and this table is stale.

| Layer | Packages |
|-------|----------|
| **0** | `contracts` (scalars, actors, IDs, base types, validation result) |
| **1** | `policy`, `model-classes`, `evidence`, `approvals`, `device-auth` |
| **2** | `receipts`, `run-events`, `work-orders` |
| **3** | `remote-protocol` (session identity, roles, the authority channel) |
| **4** | `session-stream` (the ephemeral human-facing channel of a remote session), `worker-capabilities` (what an adapter can enforce, and the trust level derived from it) |

Each layer knows everything below it; nothing above. Packages export only the types and validators they define—never re-export upward.

Three channels, three packages, deliberately not one: `run-events` (layer 2) is the durable, content-minimal record — its payload values are ids, enums, counts, digests, timestamps and flags, never free text; `remote-protocol` (layer 3) carries signed authority commands; `session-stream` (layer 4) carries what a supervising human sees while a worker runs — current action, a bounded diff, a question, a warning — with `retention: "ephemeral"` so it is never mistaken for the record.

`worker-capabilities` (layer 4) answers a different question: what can THIS worker's adapter actually honour? A `WorkerDeclaration` carries a closed `CapabilityMatrix`; the trust level (`inventoried → observed → supervised → governed → assured`) is derived from the matrix, never trusted from the declaration, and a declaration that claims more than it demonstrates is rejected. A UI renders `renderableRemoteCommands(matrix, role)` — the adapter axis intersected with what remote-protocol lets the role issue — and nothing else, so a control is never shown that the system cannot enforce.

## Using the Record Types

Every major record type has a TypeScript type definition and a validation function. To use one, import both the type and its validator, construct a value, and call the validator before storing or transmitting it.

### EvidenceRecord

A single piece of evidence supporting or contradicting an acceptance criterion. Evidence records carry the actor vouching for them, the kind of evidence, and how it was produced (deterministic, execution-based, visual, model-judged, or human-approved).

```typescript
import { toEvidenceId, toWorkerId } from "@getsimpledirect/vinci-contracts";
import {
  validateEvidenceRecord,
  type EvidenceRecord,
} from "@getsimpledirect/vinci-evidence";

const evidence: EvidenceRecord = {
  schemaVersion: 1,
  id: toEvidenceId("evidence-001")!,
  attestation: {
    provenance: "worker_provided",
    actor: {
      kind: "worker",
      workerId: toWorkerId("worker-abc123")!,
    },
  },
  kind: "unit_test",
  mode: "deterministic",
  reliability: "strong",
  sourceKind: "runner",
  assessment: {
    outcome: "supports",
  },
  notTested: [],
  summary: "Unit tests passed 487/487",
  recordedAt: "2026-08-23T14:30:00.000Z",
};

const result = validateEvidenceRecord(evidence);
// Valid: true
```

### VerdictRecord

An independent assessment of whether completed work satisfied its request. Binds the conclusion to the exact artifact evaluated via `snapshotDigest`, states what it covered via `scope`, and lists what was not tested. A verdict with an unscoped or floating assessment cannot be checked later, and cannot be distinguished from a stale one.

```typescript
import { toEvidenceId } from "@getsimpledirect/vinci-contracts";
import {
  validateVerdictRecord,
  type VerdictRecord,
} from "@getsimpledirect/vinci-evidence";

const verdict: VerdictRecord = {
  schemaVersion: 1,
  status: "VERIFIED_PASS",
  snapshotDigest: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  summary: "All acceptance criteria supported by decisive evidence",
  scope: "Login endpoint with OAuth2 flow",
  criterionResults: [
    {
      criterionId: "crit-001",
      status: "supported",
      summary: "OAuth2 token exchange succeeds",
      evidenceIds: [toEvidenceId("evidence-001")!],
    },
  ],
  decisiveEvidenceIds: [toEvidenceId("evidence-001")!],
  unresolvedConditions: [],
  residualRisks: [],
  notTested: [],
  policyVersion: "1.0.0",
  evaluatorVersion: "2.1.0",
  issuedAt: "2026-08-23T14:30:00.000Z",
  expiresAt: null,
  staleWhen: [],
};

const result = validateVerdictRecord(verdict);
// Valid: true
```

### WorkOrder

A bounded grant of authority to do a specific piece of work. Specifies what "done" means (acceptanceCriteria, fixed before work starts), what authority is granted (grantedAuthority, stated positively), and how much of a human's attention it may cost (attentionBudget). Work without pre-stated criteria is unjudgeable; work without defined authority is undefined.

```typescript
import {
  validateWorkOrder,
  type WorkOrder,
} from "@getsimpledirect/vinci-work-orders";

const workOrder: WorkOrder = {
  schemaVersion: 2,
  contractVersion: 1,
  id: "order-001",
  request: "Review and approve the authentication module refactor",
  scope: "packages/auth only",
  acceptanceCriteria: [
    {
      id: "ac-001",
      statement: "OAuth2 flows handle token refresh correctly",
      verifiedBy: "unit tests and integration test with live provider",
    },
  ],
  grantedAuthority: ["read_code", "run_tests", "comment"],
  attentionBudget: {
    interruptions: 3,
    decisions: 1,
    onExhaustion: "block",
  },
  requestedBy: {
    kind: "user",
    userId: "user-alice",
  },
  issuedAt: "2026-08-23T14:00:00.000Z",
  expiresAt: "2026-08-24T14:00:00.000Z",
};

const result = validateWorkOrder(workOrder);
// Valid: true
```

Criteria are fixed before execution and change only by amendment, never by edit. `amendWorkOrder(previous, patch, { amendmentId, changedBy, changedAt, reason })` returns the next contract version (`contractVersion + 1`, `supersedes` pointing at the previous one) and a `ContractAmendment` recording who changed what and why. A criterion is never rewritten in place: change its statement and you must remove the old id and add a new one, because verdicts pin to criterion ids. `classifyMateriality` fails closed — only `request`, `attentionBudget` and `expiresAt` are editorial; anything else is material, and `verificationIsStaleAfter(amendment)` tells a consumer to stale its current verdict (the stale verdict stays as history). A reorder of identical criteria is not a change.

### DecisionPacket

Everything a human needs to make one decision, carried rather than referenced. Carries the question, the options, what each option causes, and the evidence the choice rests on. A decision with a link and "see dashboard" charges the person twice: once to be interrupted, then again to assemble context. By then they are deciding while annoyed.

```typescript
import { toEvidenceId } from "@getsimpledirect/vinci-contracts";
import {
  validateDecisionPacket,
  type DecisionPacket,
} from "@getsimpledirect/vinci-work-orders";

const decision: DecisionPacket = {
  schemaVersion: 1,
  id: "decision-001",
  workOrderId: "order-001",
  question: "Should we deploy this change to production?",
  defaultIfUnanswered: "Block the deployment and escalate to the platform team",
  options: [
    {
      id: "opt-approve",
      label: "Approve",
      consequence: "The change is promoted to production immediately",
      irreversible: false,
    },
    {
      id: "opt-reject",
      label: "Request changes",
      consequence: "The worker is asked to revise and resubmit",
      irreversible: false,
    },
  ],
  evidenceIds: [toEvidenceId("evidence-001")!, toEvidenceId("evidence-002")!],
  raisedAt: "2026-08-23T14:30:00.000Z",
  expiresAt: "2026-08-23T15:30:00.000Z",
};

const result = validateDecisionPacket(decision);
// Valid: true
```

### RemoteDecisionState

A remote decision is provisional until the host confirms it. The relay carries authority requests; it does not manufacture authority. Treating the relay's acknowledgement as the decision would let a compromised or buggy relay approve things nobody approved.

```typescript
import {
  validateRemoteDecisionState,
  type RemoteDecisionState,
} from "@getsimpledirect/vinci-remote-protocol";

// Provisional: awaiting host confirmation
const provisional: RemoteDecisionState = {
  kind: "provisional",
  submittedAt: "2026-08-23T14:35:00.000Z",
};
let result = validateRemoteDecisionState(provisional);
// Valid: true

// Confirmed: host has validated it
const confirmed: RemoteDecisionState = {
  kind: "confirmed",
  confirmedAt: "2026-08-23T14:35:15.000Z",
};
result = validateRemoteDecisionState(confirmed);
// Valid: true

// Rejected: host refused it
const rejected: RemoteDecisionState = {
  kind: "rejected_by_host",
  reason: "expired",
};
result = validateRemoteDecisionState(rejected);
// Valid: true
```

### SessionBinding

Routes metadata for a remote session. `organizationId` is nullable (personal workspaces are first-class) but the field is REQUIRED and explicitly null, never absent. An absent organization is indistinguishable from stale context, and a stale organization context authorizing current access is a failure the structure must make impossible.

```typescript
import {
  validateSessionBinding,
  REMOTE_PROTOCOL_VERSION,
  SESSION_BINDING_SCHEMA_META,
  type SessionBinding,
} from "@getsimpledirect/vinci-remote-protocol";

const binding: SessionBinding = {
  // Both versions are required and both are refused on mismatch. A binding with
  // no version is one written before the field existed, which is the skew case
  // rather than a default — see D5.
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  schemaVersion: SESSION_BINDING_SCHEMA_META.version,
  sessionId: "session-abc123" as any,
  runId: "run-xyz789" as any,
  workspaceId: "workspace-001" as any,
  organizationId: "org-acme" as any,
  hostDeviceId: "device-host-001" as any,
  policyId: "policy-v1",
  policyVersion: 2,
  retentionClass: "days_7",
};

const result = validateSessionBinding(binding);
// Valid: true
```

## Handling Validation Failures

Every validator returns a `ValidationResult<T>`, which is either `{ ok: true, value: T }` or `{ ok: false, issues: ValidationIssue[] }`. Never check the result after using it—always check first.

A `ValidationIssue` has three fields:
- **path**: JSONPath-like string (`/scope`, `/acceptanceCriteria/0/id`) pointing to the field that failed
- **code**: Machine-readable code safe to switch on (`required_field`, `invalid_timestamp`, `unknown_field`)
- **message**: Human-readable explanation of what went wrong

Here is actual output from a malformed WorkOrder:

```
Valid: false

Issues (path, code, message):
  path: "/scope"
  code: "required_field"
  message: "scope must say what this covers; an unscoped order grants everything"

  path: "/acceptanceCriteria"
  code: "invalid_type"
  message: "acceptanceCriteria is an array"

  path: "/grantedAuthority"
  code: "invalid_type"
  message: "grantedAuthority is an array"

  path: "/attentionBudget"
  code: "not_object"
  message: "expected an object"

  path: "/requestedBy"
  code: "invalid_actor"
  message: "requestedBy must be an actor of kind user, worker, policy, system or verifier, carrying exactly that kind's fields (see ACTOR_FIELDS)"

  path: "/expiresAt"
  code: "invalid_timestamp"
  message: "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z"
```

## Rules That Will Surprise You

### Timestamps: ISO-8601 UTC, Millisecond Precision

Always `YYYY-MM-DDTHH:MM:SS.sssZ` — six digits after the decimal point, exactly. Ordering timestamps as strings is only sound in this exact canonical form. An unvalidated timestamp makes `"2026-1-1"` sort before `"2026-01-02"`, and a non-UTC offset sorts by its text rather than by the instant it represents. The round-trip validation also rejects dates that do not exist—Date.parse normalizes February 29 in a non-leap year to March 1 instead of refusing it, so the pattern alone would admit an impossible date.

### Digests: 64 Lowercase Hex, No Prefix

Always `[0-9a-f]{64}`, never uppercase or with a `sha256:` prefix. Uppercase is rejected so digests compare bytewise without case-folding overhead. A stored digest that drifts to uppercase has drifted, and a receiver must detect the difference, not normalize it away.

### Actors Carry Exactly Their Kind's Fields, No More

Every actor arm has its own field set, enforced by the validator. Five kinds exist:

- **user**: `userId` (required), `deviceId` (optional)
- **worker**: `workerId` (required)
- **policy**: `policyId` (required), `policyVersion` (required, positive integer)
- **system**: `component` (required)
- **verifier**: `verifierId` (required), `independent` (required, boolean)

An actor with foreign fields—a worker carrying `independent: true`, a user with a `workerId`—is rejected. The `kind` field itself is never listed but is always present. Hand-listing which fields are FOREIGN to an arm was tried and failed twice: the list omitted `independent` and `policyVersion`, so a worker could assert its own independence. An allowlist of what BELONGS cannot have that hole.

### Unknown Fields Are Rejected

Most records refuse unknown fields. Silence about coverage reads as coverage: a verdict listing five passing criteria and omitting two it could not evaluate is understood as "all seven are fine", which is precisely the unearned pass this system exists to prevent. Accepting unknown fields would invite the same problem at the record level.

### VERIFIED_PASS Requires All of These

A verdict cannot claim `VERIFIED_PASS` if:
- It has zero criterion results (at least one criterion must be tested)
- Any criterion result is not `"supported"` (all must support the pass)
- There are unresolved conditions (things that must be done before passing)
- There is untested coverage (things that could not be evaluated must be listed, not omitted)
- `decisiveEvidenceIds` is empty (there must be evidence cited for the pass)

These rules exist to prevent the false confidence that an unscoped verdict, an incomplete evaluation, or a missing caveat would produce. A VERIFIED_PASS means "we checked what matters, we found no problems, and here is the evidence."

### An Attention Budget Cannot Say "Proceed Without a Human"

The `ExhaustionPolicy` has exactly two values: `"block"` (stop and wait for more attention) and `"escalate"` (hand the decision up to a different human). There is deliberately no `"proceed"` option.

Remote control of an agent is teleoperation, not autonomy. If a work order could be configured to continue once it stops being able to ask, then the budget would not be a budget—it would be a quota on how much supervision the work receives before proceeding unsupervised, which is the opposite of what it is for. The dangerous configuration is not one somebody would choose maliciously; it is the one somebody would choose at 2am to stop being paged, and which then silently becomes the default everywhere. Both block and escalate keep a human in the loop. Neither can be turned off.

## Running the Gate

The gate is a nine-part check suite. It runs in GitHub Actions on every pull
request and every push to `main`.

Running is not enforcing, and the difference is the whole point of this file
existing: a workflow that runs on a push reports on a commit that has already
landed. The enforcement lives in branch protection on `main`, where `gate` and
`consumer-install` are configured as required status checks with "up to date
with base" on. That configuration is repository settings, not code in this
repository, so it can be changed without a commit — which is worth knowing
before trusting the word "required" here.

One gap is deliberate and open: `enforce_admins` is off, so a repository admin
can still push directly to `main`. Turning it on makes the requirement true for
everyone at the cost of needing a settings toggle for an emergency fix.

Run the gate locally with:

```bash
npm run gate
```

The nine checks, in order:

1. **build** — TypeScript compiles without errors or unused variables
2. **lint** — ESLint rules pass (style, naming, common mistakes)
3. **tests** — All unit tests pass
4. **dependency graph** — Layering is respected across four edge mechanisms: manifest dependencies, source imports, tsconfig project references, and tsconfig path aliases including `extends` chains. Also checks transitive reachability and cycles
5. **SchemaMeta conformance** — Every record type exports schema metadata, with closed vocabularies and positive integer versions actually enforced rather than merely present
6. **hostile-key conformance** — Every exported validator and authority guard is probed with inherited property names, accessors, proxies, sparse arrays and prototype tricks. Each guard carries a real allow **and** deny control, because a positive control that cannot fail is not a control
7. **duplicate vocabularies** — No closed string vocabulary is declared twice, comparing const arrays, bare string unions, and inline object-property arrays of three or more members. Thirteen duplications have been found in this codebase; every one agreed when written and would have drifted later
8. **lockstep versions** — All packages share one version and internal dependencies pin to it exactly, so a consumer cannot resolve a combination that was never tested together. Checks every dependency section including `optionalDependencies`, and refuses a manifest carrying a section it does not recognise — a typo like `dependancies` would otherwise be skipped by every check here while looking like a clean scan
9. **no stray scripts** — Repository root holds exactly its allowed files

Several checks report how much they examined and fail if that count is
implausibly low. A scanner that finds nothing looks exactly like a codebase with
nothing to find, and that confusion has hidden real defects here.

A floor turned out not to be enough on its own. Deleting a package made the
lockstep check report "9 packages all at 0.1.0" and exit 0, which reads exactly
like success — a scan that reports on whatever it happens to find cannot tell
you it found less than it should have. The inventory in
`scripts/expected-packages.json` is compared exactly, so adding or removing a
package has to be done deliberately, in the same commit.

A tenth check runs in CI but not in `npm run gate`, because it installs from the
network and takes minutes:

```bash
npm run check:pack
```

It packs all ten packages, installs the tarballs into an empty directory outside
this repository, and both type-checks and runs a program that imports every one
of them. Everything else here resolves package names to source through tsconfig
path aliases and project references; a consumer gets `files`, `main` and `types`
instead, and a package can pass the entire gate while being unusable the moment
it is installed. Removing `dist` from one package's `files` list, or pointing
`types` at a file that was never emitted, both pass the gate and both fail this.

If any check fails, the gate exits with code 1 and names the failure.
