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
| `path:<root>/` | **write scope**: `spec.paths` entries at or under the directory `<root>/` |
| `path:<root>` | **write scope**: the single file `<root>`, and only that file |

A bare `branch:*` (or `branch:/*`) grant is an **error on the order side** (`grant_wildcard_unbounded`), not a grant that silently covers nothing: a wildcard needs a non-empty prefix.

#### `path:` — write scope, fail closed

`repo:` and `branch:` say where a run may land commits; `path:` says which files those commits may touch. **No `path:` grant means no write scope**: an order without one authorises a worker to write nothing, a spec compiled from it carries no `paths`, and the Governor refuses any write claim that no grant covers. Root scope is deliberately **not expressible** — `path:.`, `path:/` and `path:` are all refused — so a write scope is always an enumerated list of roots, never "the repository". (Before this token existed, every pinned order had root scope by omission: vinci-gpu-control #197, review BLOCK-1.)

`<root>` is a relative, normalised path inside the repository. A trailing `/` grants that directory and everything under it; without one the token grants exactly one file (`path:src/x.ts` does not admit `src/x.ts/` or anything under it). Everything else is refused with a typed reason — `path_grant_<reason>` on `/grantedAuthority/<i>` of the order or `/paths/<i>` of the spec — and an order or spec carrying a refused token is **invalid and cannot be digested**:

| refused | reason |
|---|---|
| `path:` | `empty` |
| `path:/etc`, `path:/` | `absolute` — no leading `/` |
| `path:.` | `root_scope` — the whole repository is not a grant |
| `path:./src/`, `path:src/./x.ts` | `dot_segment` |
| `path:a/../b`, `path:..`, `path:../a` | `dotdot_segment` |
| `path:src//x.ts` | `empty_segment` |
| `path:a\b` | `backslash` — `/` only |
| a root containing NUL | `nul` |
| a root over 1024 Unicode code points | `too_long` |

The length cap is a semantic bound on the path spelling shared by the
TypeScript declarer and Python enforcer, not a byte or in-memory-size limit.
Unicode code points are counted explicitly so astral
characters consume one position in both languages; separate transport and
filesystem limits remain responsible for resource bounds.

The grammar **never normalises**: `path:a/../b` is refused, not read as `path:b`, because a grant that has to be cleaned before it can be read is a grant two implementations can clean differently. Exported: `parsePathGrant(token)` / `parsePathRoot(root)` (typed `PathRootRefusal`), `pathRootCovers(parent, child)`, `PATH_GRANT_PREFIX`, `PATH_ROOT_REFUSALS`.

**Monotonicity.** `spec.paths` is optional (absent or `[]` = may write nothing) and, when present, must be ⊆ the order's `path:` grants: every entry must equal or sit under some directory grant, or equal a file grant exactly. `checkExecutionSpecWithinOrder` reports each uncovered entry as `/paths/<i>: path_not_granted`; `bindExecutionSpec` refuses the widening under `execution_exceeds_contract`. A spec may narrow (`src/x.ts` under `path:src/`) but never widen (`src/` under `path:src/x.ts`; `docs/` under `path:src/`). Prose in `grantedAuthority` that mentions a path (`"edit files under src/"`) is not a grant of it.

**Digest.** `path:` tokens are ordinary strings in `grantedAuthority` and `paths` is an ordinary array on the spec: both are covered by the digest in array order, with duplicates refused (`duplicate_grant` / `duplicate_entry`), exactly as the other tokens are. `vectors/work-order-4-path-grants` and `vectors/execution-spec-4-path-grants` pin the bytes and digests; `vectors/path-grant-cases.json` pins the accepted, refused and monotonicity cases, and **vinci-gpu-control's vendored Python grammar mirrors these exact rules** and reads the same cases.

Time: `resourceBounds.deadline` may not be later than `order.expiresAt`. `scope` itself is not machine-checked — the `repo:`/`branch:` grants are its machine-readable projection.

### ExecutionSpec v1 fields

`schemaVersion: 1`, `workOrderId`, `workOrderDigest`, `repository {host, owner, name}`, `baseRef` and `targetBranch` (plain branch names — `main`, never `refs/heads/main` — validated by the exported `isPlainBranchName`, which is **a deliberately narrower subset of `git check-ref-format --branch`**, kept in parity with the worker's branch-header rule from vinci-code-cli PR #8. Everything git rejects is rejected; additionally rejected, although git would accept them: `refs/` anywhere in the name and a `refs.` prefix (git forbids only a leading `refs/`), `@` anywhere (git forbids only `@{` and a bare `@`), any character outside `[A-Za-z0-9._/-]` (so no unicode, no `{}`), a first character that is not alphanumeric, a trailing `.`, and a total length above 255 (git allows 1023 total, 255 per component)), `baseCommit` (exactly 40 **lowercase** hex characters — uppercase is rejected by policy so commits compare bytewise, the same rule `isDigest` applies to SHA-256), `targetBranch`, `modelClass`, optional `provider`, `resourceBounds {budgetMicrousd, maxRuntimeS, deadline}`, `tools[]`, optional `paths[]` (write scope; see `path:` above — absent means none), `inputArtifacts [{id, digest}]`, `requiredCapabilities[]`, `output` (`branch` | `patch` | `artifact` | `none`), `evidence {required}`, `promotion` (`pull_request` | `none`), `issuedAt`. Unknown fields are rejected; a spec is immutable once issued — a changed commit or bound is a new spec with a new digest.

**A pull request is a promotion mechanism, not evidence.** `output` says what the run produces; `evidence.required` says whether an evidence bundle must be produced (when required, one is always attempted); `promotion` says how the output is put forward for review — `pull_request` requires `output: "branch"`. How evidence is *verified* is not restated in the spec: it is inherited from the work order's `verifier` and `acceptanceCriteria`, so the policy has one home.

`budgetMicrousd` is money as a **non-negative safe integer** of micro-USD (1 USD = 1,000,000), never a float. Two reasons: binary floating point is the wrong type for money in general, and here the digest is computed from canonical bytes that Node and Python must produce identically — a float's shortest round-trip formatting is precisely where runtimes disagree, an integer prints one way everywhere. Floats, negatives, unsafe integers and strings are rejected.

`requiredCapabilities` holds names of `CapabilityMatrix` keys from `@getsimpledirect/vinci-worker-capabilities` as plain strings. That package is two layers above this one and the dependency graph forbids the import, so the consumer holding a matrix resolves the names; this validator checks only their shape.

### Golden vectors and the Python port

`vectors/` holds four WorkOrder and four ExecutionSpec fixtures, each with the exact canonical bytes (`canonical.txt`) and digest (`digest.txt`). `src/vectors.test.ts` regenerates and compares them in Node; `python/vinci_canonical.py` (standard library only) does the same in Python via `npm run test:vectors`, which the gate runs. **`python3` (3.8+) on PATH is therefore a gate prerequisite**, locally and in CI; there are no Python dependencies beyond the standard library. The two implementations must agree byte for byte; a change to canonicalization, coverage, or a fixture fails in both languages. Regenerate with `node vectors/generate.mjs` (after `npm run build`) only as a deliberate act, and commit the result.
