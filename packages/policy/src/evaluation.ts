import {
  isIdentifier,
  ownData,
  plainActor,
  type Actor,
  type PolicyId,
} from "@getsimpledirect/vinci-contracts";
import type {
  PolicyActionRequest,
  PolicyDecision,
  PolicyDecisionOption,
  PolicyReference,
  PolicyUndeterminedReasonCode,
} from "./decision.ts";
import {
  EXTERNAL_SIDE_EFFECT_CLASSES,
  type ApprovalGrant,
  type ApprovalRequirement,
  type ApprovalRule,
  type PolicyManifest,
} from "./manifest.ts";
import { validatePolicyManifest } from "./schema.ts";

const CONTACT_POLICY_OWNER = {
  kind: "contact_policy_owner",
  description: "Contact the policy owner for clarification or a policy update.",
} as const satisfies PolicyDecisionOption;

function policyReference(manifest: unknown): PolicyReference {
  const policyId = ownData(manifest, "policyId");
  const version = ownData(manifest, "version");
  return {
    policyId: (isIdentifier(policyId) ? policyId : "unknown-policy") as PolicyId,
    version: typeof version === "number" && Number.isInteger(version) && version > 0 ? version : 1,
  };
}

function actorSnapshot(value: unknown): Actor | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const actor = plainActor(value as Readonly<Record<string, unknown>>);
  if (actor === null) return null;
  switch (actor.kind) {
    case "user":
      if (!isIdentifier(actor.userId)) return null;
      if (actor.deviceId !== undefined && !isIdentifier(actor.deviceId)) return null;
      break;
    case "worker":
      if (!isIdentifier(actor.workerId)) return null;
      break;
    case "policy":
      if (!isIdentifier(actor.policyId)) return null;
      break;
  }
  return actor as Actor;
}

function requestSnapshot(request: unknown): PolicyActionRequest {
  const action = ownData(request, "action");
  const description = ownData(request, "description");
  const target = ownData(request, "target");
  const requestedBy = ownData(request, "requestedBy");
  const actor = actorSnapshot(requestedBy);
  return {
    action: typeof action === "string" && action.length > 0 ? action : "unknown-action",
    description:
      typeof description === "string" && description.length > 0
        ? description
        : "Policy action request could not be read.",
    ...(typeof target === "string" && target.length > 0 ? { target } : {}),
    requestedBy: actor ?? { kind: "system", component: "policy-evaluator" },
  };
}

function readableRequest(request: unknown): PolicyActionRequest | undefined {
  const action = ownData(request, "action");
  const description = ownData(request, "description");
  const target = ownData(request, "target");
  const requestedBy = actorSnapshot(ownData(request, "requestedBy"));
  if (
    typeof action !== "string" ||
    action.length === 0 ||
    typeof description !== "string" ||
    description.length === 0 ||
    (target !== undefined && (typeof target !== "string" || target.length === 0)) ||
    requestedBy === null
  ) {
    return undefined;
  }
  return {
    action,
    description,
    ...(typeof target === "string" ? { target } : {}),
    requestedBy,
  };
}

function undetermined(
  manifest: unknown,
  request: unknown,
  code: PolicyUndeterminedReasonCode,
  explanation: string,
  options: readonly [PolicyDecisionOption, ...PolicyDecisionOption[]] = [CONTACT_POLICY_OWNER],
): PolicyDecision {
  return {
    outcome: "undetermined",
    request: requestSnapshot(request),
    reason: { code, explanation },
    controllingPolicy: policyReference(manifest),
    availableOptions: options,
  };
}

function requirementSignature(requirement: ApprovalRequirement): string {
  switch (requirement.kind) {
    case "named_person":
      return `named_person:${requirement.userId}`;
    case "role":
      return `role:${requirement.role}`;
    case "two_people":
      return requirement.eligible.kind === "role"
        ? `two_people:role:${requirement.eligible.role}`
        : "two_people:any_user";
  }
}

function grantSignature(grant: ApprovalGrant): string {
  switch (grant.kind) {
    case "allow-once":
      return "allow-once";
    case "allow-remainder-of-run":
      return `allow-remainder-of-run:${grant.runId}`;
    case "allow-bounded":
      return `allow-bounded:${grant.resourceId}:${grant.durationMs}`;
  }
}

function approvalSignature(rule: ApprovalRule): string | undefined {
  if (rule.decision.kind !== "require_approval") return undefined;
  return `${requirementSignature(rule.decision.approver)}|${grantSignature(rule.decision.grant)}`;
}

function grantDescription(grant: ApprovalGrant): string {
  switch (grant.kind) {
    case "allow-once":
      return "allow-once";
    case "allow-remainder-of-run":
      return `allow-remainder-of-run for run ${grant.runId}`;
    case "allow-bounded":
      return `allow-bounded for ${grant.resourceId} for ${grant.durationMs} ms`;
  }
}

function decide(
  manifest: PolicyManifest,
  request: PolicyActionRequest,
  matchingRules: readonly ApprovalRule[],
): PolicyDecision {
  const controllingPolicy = { policyId: manifest.policyId, version: manifest.version };
  const denied = matchingRules.find((rule) => rule.decision.kind === "deny");
  if (denied !== undefined) {
    return {
      outcome: "denied",
      request,
      reason: {
        code: "explicit_deny",
        explanation: `Policy rule "${denied.id}" explicitly denies this action.`,
      },
      controllingPolicy,
      availableOptions: [
        {
          kind: "request_policy_change",
          description: "Ask the policy owner to change the rule before retrying.",
        },
        CONTACT_POLICY_OWNER,
      ],
    };
  }

  const approvals = matchingRules.filter((rule) => rule.decision.kind === "require_approval");
  if (approvals.length > 0) {
    const first = approvals[0];
    if (first === undefined || first.decision.kind !== "require_approval") {
      throw new Error("approval rule selection failed");
    }
    const signature = approvalSignature(first);
    if (approvals.some((rule) => approvalSignature(rule) !== signature)) {
      return undetermined(
        manifest,
        request,
        "conflicting_rules",
        "Matching approval rules require incompatible approvers or grants.",
      );
    }
    return {
      outcome: "denied",
      request,
      reason: {
        code: "approval_required",
        explanation: `Policy rule "${first.id}" requires approval before this action may proceed.`,
      },
      controllingPolicy,
      grant: first.decision.grant,
      availableOptions: [
        {
          kind: "request_approval",
          description: `Request approval for the ${grantDescription(first.decision.grant)} grant from rule "${first.id}".`,
        },
        CONTACT_POLICY_OWNER,
      ],
    };
  }

  const allowed = matchingRules.find((rule) => rule.decision.kind === "allow_automatically");
  if (allowed === undefined) {
    return undetermined(
      manifest,
      request,
      "conflicting_rules",
      "Matching rules did not produce a supported policy decision.",
    );
  }
  return {
    outcome: "allowed",
    request,
    reason: {
      code: "automatic_allow",
      explanation: `Policy rule "${allowed.id}" automatically allows this action.`,
    },
    controllingPolicy,
  };
}

/** Evaluate one action request against a validated version-1 policy manifest. */
/**
 * FIVE DECISIONS, ALL RATIFIED by George, 2026-08-24, as D6 in docs/E0-decisions.md.
 *
 * The matching algorithm was not specified anywhere. Not in the types, not in
 * the manifest comments, not in E0-decisions. It had to be invented to write
 * this function, and each choice below decides how authority is granted. They
 * are recorded here because an implementing agent reported "AMBIGUITIES: None —
 * the specification was unambiguous on all points", which was not true: the
 * questions were UNDEFINED, not settled, and five answers were chosen. Choosing
 * is fine. Reporting that there was nothing to choose hides the choices from
 * whoever has to live with them.
 *
 * Each is the fail-closed reading, and all five are now confirmed as written.
 * Ratified does not mean obvious: it means someone with authority over the
 * policy model looked at each choice and accepted the cost named beside it.
 *
 * 1. CAPABILITY MATCHING IS EXACT EQUALITY.
 *    A rule for "deploy" governs "deploy" and nothing else. Prefix matching
 *    would let that rule silently govern "deployment-notes", which is a
 *    privilege escalation with no visible cause. The cost of exactness is that
 *    a policy must enumerate its capabilities; that cost is the point.
 *
 * 2. MOST RESTRICTIVE WINS: deny > require_approval > allow_automatically.
 *    When several rules match, the strictest applies. The alternative —
 *    document order — makes authority depend on where someone happened to paste
 *    a rule.
 *
 * 3. NO MATCHING RULE IS "undetermined", NOT "denied".
 *    An unknown action is not the same as a forbidden one, and collapsing them
 *    destroys the audit distinction between "policy has nothing to say" and
 *    "policy says no". Neither permits the action.
 *
 * 4. any_action IS A FALLBACK, NOT A PARTICIPANT.
 *    It applies only when no capability or side-effect rule matched, so a broad
 *    catch-all cannot override a specific rule written later.
 *
 * 5. UNDETERMINED REASON CODES map to concrete conditions, listed at each
 *    return site rather than assigned loosely.
 *
 * WHAT RATIFICATION BUYS. Each decision has a named test beside this file that
 * fails if the behaviour is reverted, so the five are enforced rather than
 * merely described. Changing any of them is now a compatibility decision
 * recorded in E0, not an edit — because every one of them is a change to how
 * authority is granted, and each would look like a small convenience change to
 * whoever made it:
 *
 *   - relaxing (1) to a prefix match lets a rule for "deploy" silently govern
 *     "deployment-notes", an escalation with no visible cause;
 *   - replacing (2) with document order makes authority depend on where someone
 *     pasted a rule;
 *   - collapsing (3) into "denied" destroys the audit distinction between
 *     "policy has nothing to say" and "policy says no";
 *   - letting (4) participate rather than fall back lets a broad catch-all
 *     override a specific rule written later.
 *
 * Namespacing ("deploy:*") remains a feature to design deliberately if real
 * policies need it, never a default to slip into.
 */
export function evaluatePolicyDecision(
  manifest: unknown,
  request: unknown,
): PolicyDecision {
  try {
    const validation = validatePolicyManifest(manifest);
    if (!validation.ok) {
      const issue = validation.issues[0];
      const explanation = issue === undefined
        ? "The policy manifest failed validation."
        : `The policy manifest is malformed at ${issue.path}: ${issue.message} (${issue.code}).`;
      return undetermined(manifest, request, "malformed_policy", explanation);
    }

    const policy = validation.value;
    if (policy.version > 1) {
      return undetermined(
        policy,
        request,
        "unsupported_policy_version",
        `Policy version ${policy.version} is newer than the evaluator's supported version 1.`,
      );
    }

    const readable = readableRequest(request);
    if (readable === undefined) {
      return undetermined(
        policy,
        request,
        "missing_context",
        "The request is missing safe action context required for policy evaluation.",
        [
          {
            kind: "retry_with_context",
            description: "Retry with a complete action, description, and requesting actor.",
          },
          CONTACT_POLICY_OWNER,
        ],
      );
    }

    const { action } = readable;

    const externalAction = (EXTERNAL_SIDE_EFFECT_CLASSES as readonly string[]).includes(action)
      ? action
      : undefined;
    const specificRules = policy.approvals.rules.filter((rule) => {
      if (rule.appliesTo.kind === "capability") {
        return rule.appliesTo.capability === action;
      }
      if (rule.appliesTo.kind === "external_side_effect") {
        return externalAction !== undefined && rule.appliesTo.actionClass === externalAction;
      }
      return false;
    });
    const matchingRules = specificRules.length > 0
      ? specificRules
      : policy.approvals.rules.filter((rule) => rule.appliesTo.kind === "any_action");

    if (matchingRules.length === 0) {
      const hasExternalSideEffectRule = policy.approvals.rules.some(
        (rule) => rule.appliesTo.kind === "external_side_effect",
      );
      if (externalAction === undefined && hasExternalSideEffectRule) {
        return undetermined(
          policy,
          readable,
          "missing_context",
          `Action "${action}" cannot be mapped to a known external side-effect class.`,
          [
            {
              kind: "retry_with_context",
              description: "Retry with a canonical external side-effect action class.",
            },
            CONTACT_POLICY_OWNER,
          ],
        );
      }
      return undetermined(
        policy,
        readable,
        "unknown_action",
        `No policy rule matches action "${action}".`,
        [
          {
            kind: "request_policy_change",
            description: "Ask the policy owner to add an explicit rule for this action.",
          },
          CONTACT_POLICY_OWNER,
        ],
      );
    }

    return decide(policy, readable, matchingRules);
  } catch {
    return undetermined(
      manifest,
      request,
      "evaluator_error",
      "The policy evaluator encountered an internal error and refused to authorize the action.",
      [
        {
          kind: "no_action_available",
          description: "Do not proceed until the evaluator error has been investigated.",
        },
        CONTACT_POLICY_OWNER,
      ],
    );
  }
}
