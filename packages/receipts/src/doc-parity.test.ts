/**
 * SEMANTIC PARITY: the documented null-verdict rule must equal the one the code
 * actually enforces.
 *
 * 🔴 WHY THIS EXISTS. Restoring the old three-state prose to STATE-DIMENSIONS.md
 * left the entire suite green. The doc said `null` is permitted on BLOCKED,
 * FAILED or CANCELLED while the code permitted WAITING as well, and NOTHING
 * failed. A documentation fix with no test pinning it is a fix that silently
 * rots, so this compares the two SETS rather than any sentence.
 *
 * Two design points that make it a real guard and not a spelling check:
 *
 *  1. The runtime set is derived BEHAVIOURALLY, through the public
 *     validateReceipt, not by importing the private `permitsNullVerdict`. What
 *     is pinned is the rule callers actually meet.
 *  2. The documented set is parsed from STRUCTURE, not wording: the span
 *     between the rule's two conjuncts (`finalState` and `artifactsProduced`).
 *     Reordering the states, changing "or" to "and", or reflowing the lines
 *     does not break it. The parser deliberately stops at `artifactsProduced`
 *     because the SAME paragraph later names `DONE` and `DONE_UNVERIFIED` --
 *     states that are NOT permitted. A naive "every backticked state in the
 *     paragraph" parser would silently include them and pass while wrong.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TERMINAL_STATES } from "@getsimpledirect/vinci-contracts";
import { receiptDigest } from "./digest.ts";
import { validateReceipt } from "./index.ts";
import type { Receipt } from "./receipt.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = resolve(HERE, "../../contracts/docs/STATE-DIMENSIONS.md");

function baseReceipt(finalState: string): Record<string, unknown> {
  const candidate: Record<string, unknown> = {
    receiptVersion: 3,
    receiptId: "receipt-parity",
    runId: "run-parity",
    objective: "Derive the runtime null-verdict set",
    workspace: { kind: "personal", workspaceId: "workspace-1", ownerId: "user-1" },
    requester: { kind: "user", userId: "user-1", deviceId: "device-1" },
    worker: { kind: "worker", workerId: "worker-1" },
    modelId: "model-1",
    providerId: "provider-1",
    executionLocation: "ca-central-1",
    policyId: "policy-1",
    policyVersion: 3,
    startedAt: "2026-08-23T12:00:00.000Z",
    completedAt: "2026-08-23T13:00:00.000Z",
    activeDuration: 12_345,
    humanAttention: { seconds: 25, interruptions: 3, decisions: 2, escalations: 1 },
    finalState,
    actionSummary: "Parity probe",
    resourcesAccessed: [],
    changesMade: [],
    artifactsProduced: [],
    approvalIds: [],
    evidenceIds: [],
    verdict: null,
    spend: 17,
    unresolvedConditions: [],
    resumeInstructions: null,
    rollbackInfo: "none",
    digest: "0".repeat(64),
    signature: null,
  };
  candidate.digest = receiptDigest(candidate as unknown as Receipt);
  return candidate;
}

/** The set the CODE permits, observed through the public validator. */
function runtimeNullVerdictStates(): Set<string> {
  const permitted = new Set<string>();
  for (const finalState of TERMINAL_STATES) {
    const result = validateReceipt(baseReceipt(finalState));
    const verdictRejected = result.ok
      ? false
      : result.issues.some((issue) => issue.path === "/verdict");
    if (!verdictRejected) permitted.add(finalState);
  }
  return permitted;
}

/**
 * The set the DOC states. Structural, not wording-pinned: the rule is the span
 * from `finalState` to `artifactsProduced`, its two conjuncts.
 *
 * Returns null when the document does not state this rule at all, so a caller
 * can tell "the rule says a different set" from "there is no rule here". An
 * empty set would conflate them and could pass vacuously.
 */
export function documentedNullVerdictStates(doc: string): Set<string> | null {
  // Anchor on the rule's own two distinguishing terms -- the null verdict and
  // the empty-artifacts conjunct -- and read the states named between them.
  // (An earlier version anchored on `finalState` instead and refused to parse
  // the real document, because "null" is written BEFORE "finalState" in the
  // sentence. It failed loudly rather than returning an empty set, which is why
  // that mistake surfaced here instead of passing vacuously.)
  const artifactsAt = doc.indexOf("`artifactsProduced`");
  if (artifactsAt < 0) return null;
  const nullAt = doc.lastIndexOf("`null`", artifactsAt);
  if (nullAt < 0) return null;

  const span = doc.slice(nullAt, artifactsAt);
  // The rule is about which `finalState` values may carry that null. Without
  // that subject this span is some other sentence and is not the rule.
  if (!span.includes("`finalState`")) return null;

  const terminal = new Set<string>(TERMINAL_STATES as readonly string[]);
  const named = new Set<string>();
  for (const match of span.matchAll(/`([A-Z_]+)`/g)) {
    if (terminal.has(match[1])) named.add(match[1]);
  }
  return named.size > 0 ? named : null;
}

const sorted = (values: Iterable<string>) => [...values].sort().join(", ");

describe("the documented null-verdict rule matches the enforced one", () => {
  it("PARITY: the documented state set equals the runtime state set", () => {
    const doc = readFileSync(DOC_PATH, "utf8");
    const documented = documentedNullVerdictStates(doc);
    const runtime = runtimeNullVerdictStates();

    expect(
      documented,
      `STATE-DIMENSIONS.md no longer states the null-verdict rule in a form this ` +
        `test can read (expected a span from \`finalState\` to \`artifactsProduced\` ` +
        `mentioning null). Refusing to pass on an unreadable document.`,
    ).not.toBeNull();

    expect(
      sorted(documented as Set<string>),
      `NULL_VERDICT_DOC_PARITY: STATE-DIMENSIONS.md documents the null-verdict ` +
        `set as {${sorted(documented as Set<string>)}} but validateReceipt ` +
        `enforces {${sorted(runtime)}}. The doc and the code disagree about which ` +
        `final states may carry a null verdict.`,
    ).toBe(sorted(runtime));
  });

  it("POSITIVE REACHABILITY: WAITING really is permitted at runtime", () => {
    // Guards against a parity test that passes because BOTH sides are empty or
    // both wrong in the same direction.
    const runtime = runtimeNullVerdictStates();
    expect(runtime.has("WAITING"), "a WAITING receipt with a null verdict must validate").toBe(true);
    expect(runtime.has("DONE"), "DONE must still require a verdict").toBe(false);
    expect(runtime.size).toBeGreaterThan(1);
  });

  it("does not read a wrong-vocabulary comment as this rule", () => {
    // states.ts talks about FAILED/CANCELLED as verification-JOB states. That is a
    // different vocabulary and must never be parsed as the null-verdict rule.
    const decoy = [
      "Some prose about `finalState` in passing, with no null-verdict rule.",
      "FAILED and CANCELLED are states of the verification *job*, not judgements",
      "about the run, and `artifactsProduced` is mentioned here too.",
    ].join("\n");
    expect(
      documentedNullVerdictStates(decoy),
      "a span with no `null` verdict rule must not be read as one",
    ).toBeNull();
  });

  it("excludes a wrong-vocabulary token that sits INSIDE the rule span", () => {
    // 🔴 THE FILTER THIS COVERS. The parser passes every backticked ALL-CAPS
    // token it finds through the canonical TERMINAL_STATES set. Removing that
    // filter left all 75 controls green, because the REAL document happens to
    // name only terminal states inside the span -- the guard was real, load
    // bearing, and reached by nothing.
    //
    // The realistic drift is an editor mentioning an execution state while
    // explaining the rule. `RUNNING` is a genuine RUN_STATES member and is NOT
    // a TerminalState, so it is the wrong vocabulary appearing in exactly the
    // place the anchors admit: between `null` and `artifactsProduced`.
    const doc = [
      "The receipt's `verdict` may",
      "be `null` exactly when `finalState` is `WAITING`, `BLOCKED`, `FAILED` or",
      "`CANCELLED` (never while the run is still `RUNNING`, which is an execution",
      "state and not a terminal one) AND",
      "`artifactsProduced` is empty: execution ended with nothing to assess.",
    ].join("\n");

    const parsed = documentedNullVerdictStates(doc);
    expect(parsed).not.toBeNull();
    const named = parsed as Set<string>;

    expect(
      named.has("RUNNING"),
      `NULL_VERDICT_DOC_VOCABULARY: the parser admitted "RUNNING" into the ` +
        `documented null-verdict set. It is a RUN_STATES member, not a ` +
        `TerminalState, so every backticked token in the span is being read as ` +
        `a final state and the canonical TERMINAL_STATES filter is not applied.`,
    ).toBe(false);

    // Positive half: filtering out the intruder must not cost the real states.
    expect(
      [...named].sort(),
      "the four intended states must survive the filter",
    ).toEqual(["BLOCKED", "CANCELLED", "FAILED", "WAITING"]);
  });

  it("is not fooled by the DONE mention later in the same paragraph", () => {
    // The real document names `DONE` and `DONE_UNVERIFIED` a sentence after the
    // rule, as states that may NOT carry a null verdict. Parsing the whole
    // paragraph would wrongly include them.
    const doc = readFileSync(DOC_PATH, "utf8");
    const documented = documentedNullVerdictStates(doc);
    expect(documented).not.toBeNull();
    expect((documented as Set<string>).has("DONE")).toBe(false);
    expect((documented as Set<string>).has("DONE_UNVERIFIED")).toBe(false);
  });
});
