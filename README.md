# vinci-contracts

Shared schemas and types for the Vinci ownership platform. Every surface — Web,
Desktop, Mobile, Code, Admin, Governor, Acceptance — imports its run states,
policy manifest, receipt shape, and event vocabulary from here.

This repository contains schemas and types only. No application logic, no UI
(§16). If something here needs to know how a particular surface behaves, it is
in the wrong repository.

## Why it exists

Epic E0's exit gate:

> all repositories can import the same contract definitions;
> no repository independently defines conflicting run states.

Before this repository, `vinci-code` and `vinci-acceptance` each defined their
own outcome vocabulary and the other four surfaces defined none. The states
happened to agree. Nothing kept them agreeing.

## Layout

| Package | Owns |
| --- | --- |
| `@vinci/contracts` | Glossary nouns, identifiers, actors, run/terminal/verdict states, schema envelope |
| `@vinci/policy` | Policy manifest and its thirteen sections (FR-4.1) |
| `@vinci/model-classes` | Model and provider provenance (FR-8.4) |
| `@vinci/evidence` | Evidence records, sources, staleness (FR-6.3, FR-7.4) |
| `@vinci/approvals` | Approval requests, scopes, decisions (FR-4.7) |
| `@vinci/device-auth` | Per-device and per-worker credentials (FR-9.3, SR-4) |
| `@vinci/receipts` | Receipt fields and final states (FR-6.1, FR-6.2) |
| `@vinci/run-events` | The run event stream (FR-2.3) |
| `@vinci/worker-protocol` | Adapter interface and capability disclosure (FR-3.2) |

Dependencies point strictly downward through four layers and are enforced by
`npm run check:graph`, not by review.

## Reading order

1. `docs/E0-decisions.md` — the four decisions everything else follows from.
2. `docs/glossary.md` — the nouns, and the distinctions that are load-bearing.
3. `packages/contracts/src/states.ts` — the reason this repository exists.

## Conventions

- Malformed data fails closed. Unknown fields are preserved. These are opposite
  behaviours and are frequently conflated; see D4.
- Every schema exports a `SchemaMeta` answering the six questions §16 requires.
  A conformance test enforces it.
- Every record carries its schema version inline. No consumer infers a version
  from shape.
