# Shared glossary

The nouns of §7, with the type that represents each one. A term means the same
thing in every repository, or it is not in this file.

Package references use the organization-owned `@getsimpledirect` scope on the public npm registry; the deliberate `vinci-` prefix avoids claiming generic package names.

Where a repository already had its own word for one of these, the existing word
is listed so migrations can be mechanical.

| Term | Type | Package | Notes |
| --- | --- | --- | --- |
| Organization | `OrganizationId` | `@getsimpledirect/vinci-contracts` | Owns policies, workspaces, devices, records. |
| Workspace | `WorkspaceRef` | `@getsimpledirect/vinci-contracts` | A discriminated union, not a nullable org id — personal and organizational workspaces must stay distinguishable (FR-9.4). |
| Agent | `AgentId` | `@getsimpledirect/vinci-contracts` | The *logical* AI system. Claude Code is an agent. |
| Worker | `WorkerId` | `@getsimpledirect/vinci-contracts` | A *running execution environment*. Claude Code wrapped by an adapter is a worker. Distinct from Agent on purpose. |
| Model | `ModelProvenance` | `@getsimpledirect/vinci-model-classes` | Separate from the worker and replaceable (§8.1, principle 5). |
| Capability | `Capability` | `@getsimpledirect/vinci-policy` | A resource or action a worker may use. |
| Run | `RunId`, `RunState` | `@getsimpledirect/vinci-contracts` | A bounded attempt at an objective. |
| Approval | `ApprovalId` | `@getsimpledirect/vinci-approvals` | A decision required before a consequential action. |
| Artifact | `ArtifactId` | `@getsimpledirect/vinci-receipts` | A durable output. |
| Evidence | `EvidenceId` | `@getsimpledirect/vinci-evidence` | A record supporting *or contradicting* a completion claim. |
| Receipt | `ReceiptId`, `TerminalState` | `@getsimpledirect/vinci-receipts` | The durable record of what a run did. |
| Verdict | `Verdict` | `@getsimpledirect/vinci-contracts` | An assessment by an independent verifier. Not a run state. |

## Distinctions that are load-bearing

These pairs look like synonyms and are not. Collapsing any of them re-creates
the drift E0 exists to remove.

**Agent vs Worker.** An agent is the logical system; a worker is a running
environment implementing the worker protocol. One agent may run as many
workers. Device credentials, heartbeats, and revocation attach to the *worker*;
inventory and ownership attach to the *agent*.

**Model vs Worker.** A run's model can change without the worker changing, and
product state must not be keyed to a provider's model identifier (§8.1,
principle 5). This is why `ModelProvenance` is a record on the run rather than
a field of the worker.

**`RunState` vs `TerminalState` vs `Verdict`.** Three types. See
docs/E0-decisions.md, D1.

**Worker claim vs verdict.** A worker saying it is done is a claim, not proof
(G5). An adapter must report the two separately (FR-3.3), and no UI may render
a claim as verification (FR-6.4).

**Evidence vs verification.** Evidence is a record; verification is an
assessment of evidence by someone other than the worker. Collecting evidence
does not make a run verified.

**Verified vs not-yet-stale.** A verdict describes the state it evaluated. If
that state changed, the verdict is stale and must stop being represented as
current, while remaining visible as history (FR-7.4).

**Unknown vs absent vs false.** "No owner recorded" is not "no owner". The UI
must say Unknown rather than infer (UX-3), so the schemas model unknown
explicitly instead of leaning on `null` or a default.
