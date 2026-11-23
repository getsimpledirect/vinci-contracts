import { toRunId } from "@getsimpledirect/vinci-contracts";

import type { FallbackRecord, MaterialFallbackDisclosure } from "./fallback.ts";

function _checkFallbackTypes(): void {
  const runId = toRunId("run-1");
  if (runId === null) throw new Error("The fallback fixture needs a valid run id.");

  const applied = {
    schemaVersion: 1,
    runId,
    recordedAt: "2026-08-23T12:34:56.789Z",
    recordedBy: { kind: "system", component: "model-gateway" },
    source: {
      provider: { kind: "known", value: "openai" },
      jurisdiction: { kind: "known", value: { jurisdiction: "CA" } },
    },
    destination: { provider: "anthropic", jurisdiction: { jurisdiction: "US" } },
    outcome: "applied",
    policyDecision: {
      policyId: "policy-1",
      policyVersion: 3,
      reasonCode: "approved_cross_provider_fallback",
      permitted: true,
    },
  } satisfies FallbackRecord;

  const blocked = {
    ...applied,
    outcome: "blocked",
    policyDecision: {
      ...applied.policyDecision,
      reasonCode: "denied_cross_provider_fallback",
      permitted: false,
    },
  } satisfies FallbackRecord;

  // @ts-expect-error An applied fallback requires permitted: true.
  const _deniedApplied: FallbackRecord = { ...applied, policyDecision: blocked.policyDecision };
  // @ts-expect-error A blocked fallback requires permitted: false.
  const _permittedBlocked: FallbackRecord = { ...blocked, policyDecision: applied.policyDecision };

  const _usedApplied: MaterialFallbackDisclosure = { kind: "used", record: applied };
  const _usedBlocked: MaterialFallbackDisclosure = { kind: "used", record: blocked };
  // @ts-expect-error A used disclosure must include a fallback record.
  const _usedWithoutRecord: MaterialFallbackDisclosure = { kind: "used" };
  // @ts-expect-error A used disclosure cannot have an undefined record.
  const _usedWithUndefinedRecord: MaterialFallbackDisclosure = { kind: "used", record: undefined };

  const { policyDecision: _policyDecision, ...incompleteFallback } = applied;
  // @ts-expect-error A used disclosure must include the complete record, including its policy decision.
  const _usedWithIncompleteRecord: MaterialFallbackDisclosure = { kind: "used", record: incompleteFallback };

  const { policyVersion: _policyVersion, ...unversionedPolicyDecision } = applied.policyDecision;
  const fallbackWithoutPolicyVersion = { ...applied, policyDecision: unversionedPolicyDecision };
  // @ts-expect-error A used disclosure must include the policy decision's version.
  const _usedWithoutPolicyVersion: MaterialFallbackDisclosure = { kind: "used", record: fallbackWithoutPolicyVersion };
}
