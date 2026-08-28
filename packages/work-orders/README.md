# @getsimpledirect/vinci-work-orders

Work orders (bounded grants of authority), attention budgets, contract amendments, decision packets — and, since 0.2.x, the digest that identifies a work order and the execution spec compiled from it.

## Digests and ExecutionSpec

A **WorkOrder** is durable intent: request, scope, acceptance criteria, granted authority, attention budget, owner, risk, verifier, rollback and escalation terms. It deliberately does **not** say which repository, base commit, target branch, model, provider, or runtime bounds a run uses. Those move without the agreement moving, so they live in an **ExecutionSpec** compiled from the order for one run.

### What is hashed

`workOrderDigest(order)` and `executionSpecDigest(spec)` are SHA-256, lowercase hex, over the canonical encoding of the **validated** record — the same construction as `receiptDigest` and `eventDigest`.

- **Everything is covered.** For a work order that includes `contractVersion`, `supersedes`, `issuedAt` and `expiresAt`; for a spec it includes `workOrderDigest` and `issuedAt`. The digest identifies the exact contract or the exact run configuration, not "the same request at any version". Two orders differing only in when they were issued are two grants.
- **Nothing is excluded.** There is no `digest` or `signature` field on either record, so unlike a receipt there is nothing to leave out.
- **Invalid records are not hashed.** Both functions validate first and throw on an invalid record; a stable identity for something that is not a work order is worse than none.
- **Canonical encoding** is `canonicalize` from `@getsimpledirect/vinci-contracts`: keys sorted by UTF-16 code unit at every level, arrays in order, ES `Number::toString` for numbers, `JSON.stringify` string escaping, no whitespace. This is RFC 8785 (JCS) for the value domain in use, and `packages/contracts/src/canonical.jcs.test.ts` pins it to the RFC's own vectors.

### The handoff triple

A worker is handed exactly

```
{ work_order_id, contract_digest, execution_spec_digest }
```

`bindExecutionSpec(spec, order)` produces it, after proving that `spec.workOrderId === order.id` **and** `spec.workOrderDigest === workOrderDigest(order)`. An id match with a digest mismatch is the dangerous pairing — the same line of contract at a different version — and is reported as `work_order_digest_mismatch`. Because the spec digest covers `workOrderDigest`, the triple transitively pins every term the worker runs under; none can be swapped without one of the three values changing.

### Monotonicity: execution authority ⊆ contract authority

Identity is not containment. `checkExecutionSpecWithinOrder(spec, order)` is a **pure** predicate (no I/O; the Governor or whatever compiles specs calls it) that returns `{ within: true }` or one issue per violated dimension, and `bindExecutionSpec` calls it after the id/digest check, refusing with `execution_exceeds_contract` followed by the specific violations. Positive-list semantics: anything the spec asks for that the order does not grant is a violation; absence is not permission.

Because `grantedAuthority` is free text and `scope` is prose, grants are matched by an explicit token grammar rather than a substring search. A grant is machine-readable only with one of these prefixes; every other grant is prose for humans and covers nothing:

| grant | covers |
|---|---|
| `tool:<name>` | `spec.tools` entry `<name>`, exact and case-sensitive |
| `repo:<host>/<owner>/<name>` | `spec.repository`, exact |
| `branch:<name>` | `spec.targetBranch`, exact |
| `branch:<prefix>/*` | any `targetBranch` beginning with `<prefix>/` (one trailing `/*`; no other wildcard) |
| `promotion:pull_request` | a spec that opens a pull request |

Time: `resourceBounds.deadline` may not be later than `order.expiresAt`. `scope` itself is not machine-checked — the `repo:`/`branch:` grants are its machine-readable projection.

### ExecutionSpec v1 fields

`schemaVersion: 1`, `workOrderId`, `workOrderDigest`, `repository {host, owner, name}`, `baseRef`, `baseCommit` (exactly 40 **lowercase** hex characters — uppercase is rejected by policy so commits compare bytewise, the same rule `isDigest` applies to SHA-256), `targetBranch`, `modelClass`, optional `provider`, `resourceBounds {budgetUsd, maxRuntimeS, deadline}`, `tools[]`, `inputArtifacts [{id, digest}]`, `requiredCapabilities[]`, `evidencePolicy` (`pr` | `receipt` | `none`), `issuedAt`. Unknown fields are rejected; a spec is immutable once issued — a changed commit or bound is a new spec with a new digest.

`requiredCapabilities` holds names of `CapabilityMatrix` keys from `@getsimpledirect/vinci-worker-capabilities` as plain strings. That package is two layers above this one and the dependency graph forbids the import, so the consumer holding a matrix resolves the names; this validator checks only their shape.

### Golden vectors and the Python port

`vectors/` holds three WorkOrder and three ExecutionSpec fixtures, each with the exact canonical bytes (`canonical.txt`) and digest (`digest.txt`). `src/vectors.test.ts` regenerates and compares them in Node; `python/vinci_canonical.py` (standard library only) does the same in Python via `npm run test:vectors`, which the gate runs. **`python3` (3.8+) on PATH is therefore a gate prerequisite**, locally and in CI; there are no Python dependencies beyond the standard library. The two implementations must agree byte for byte; a change to canonicalization, coverage, or a fixture fails in both languages. Regenerate with `node vectors/generate.mjs` (after `npm run build`) only as a deliberate act, and commit the result.
