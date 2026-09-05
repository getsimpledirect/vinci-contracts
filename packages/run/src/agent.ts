import {
  fail,
  isDigest,
  isIdentifier,
  isNonBlankText,
  ok,
  toPlainRecord,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import { ENDPOINT_CAPABILITIES, HARNESS_CAPABILITIES } from "@getsimpledirect/vinci-model-classes";
import { digestValidated } from "./digest.ts";
import {
  isEnumMember,
  isNonNegativeInt,
  isObjectRecord,
  isPositiveInt,
  issue,
  rejectUnknownFields,
} from "./lib/validate.ts";

/**
 * The durable declaration of what an agent is and what it may do.
 *
 * An agent is not a prompt. It is a bundle of identity (agentId), a versioned
 * intent (version), a model class, the policy and permission context it is
 * bound to, the skills it may load, the capabilities the harness must actually
 * have for the agent to run (requiredCapabilities), and a bounded autonomy
 * envelope (autonomy). Everything below is declared so the run contract can be
 * checked rather than assumed: a required capability that the harness cannot
 * attest is a run that must not start, not one that starts anyway.
 */
export type VinciAgent = {
  readonly schemaVersion: 1;
  readonly agentId: string;
  /** A version of at least 1; an agent's declared intent changes only by version. */
  readonly version: number;
  readonly modelClass: string;
  readonly systemPolicyRef: string;
  readonly skills: readonly AgentSkill[];
  readonly requiredCapabilities: readonly AgentRequiredCapability[];
  readonly allowedToolCategories: readonly ToolCategory[];
  readonly permissionPolicyRef: string;
  readonly autonomy: readonly AgentAutonomy[];
};

export type AgentSkill = {
  readonly id: string;
  readonly digest: string;
};

export type AgentRequiredCapability = {
  readonly id: string;
  readonly version: number;
};

/** The closed set of tool categories this agent may be offered. */
export const TOOL_CATEGORIES = ["repository", "github_read", "research", "artifact", "shell", "approval"] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

/** An agent's autonomy is a per-capability, bounded level from 0 to 8. */
export type AgentAutonomy = {
  readonly capabilityId: string;
  readonly level: number;
};

const CAPABILITY_IDS = [...HARNESS_CAPABILITIES, ...ENDPOINT_CAPABILITIES] as const;

function validateSkill(raw: unknown, path: string, issues: ValidationIssue[], seen: Set<string>): void {
  if (!isObjectRecord(raw)) {
    issues.push(issue(path, "invalid_type", "a skill is an object"));
    return;
  }
  rejectUnknownFields(raw, ["id", "digest"], path, "a skill", issues);
  if (!isIdentifier(raw.id)) {
    issues.push(issue(`${path}/id`, "invalid_id", "a skill id is an identifier"));
  } else if (seen.has(raw.id)) {
    issues.push(issue(`${path}/id`, "duplicate_skill", "a skill is listed twice"));
  } else {
    seen.add(raw.id);
  }
  if (!isDigest(raw.digest)) {
    issues.push(issue(`${path}/digest`, "invalid_digest", "a skill digest is 64 lowercase hex characters"));
  }
}

function validateRequiredCapability(
  raw: unknown,
  path: string,
  issues: ValidationIssue[],
  seen: Set<string>,
): void {
  if (!isObjectRecord(raw)) {
    issues.push(issue(path, "invalid_type", "a required capability is an object"));
    return;
  }
  rejectUnknownFields(raw, ["id", "version"], path, "a required capability", issues);
  if (typeof raw.id !== "string" || !(CAPABILITY_IDS as readonly string[]).includes(raw.id)) {
    issues.push(
      issue(
        `${path}/id`,
        "unknown_capability",
        "a required capability must come from HARNESS_CAPABILITIES or ENDPOINT_CAPABILITIES",
      ),
    );
  } else if (seen.has(raw.id)) {
    issues.push(issue(`${path}/id`, "duplicate_capability", "a required capability is listed twice"));
  } else {
    seen.add(raw.id);
  }
  if (!isPositiveInt(raw.version)) {
    issues.push(issue(`${path}/version`, "invalid_version", "a capability version is a positive integer"));
  }
}

function validateAutonomy(
  raw: unknown,
  path: string,
  issues: ValidationIssue[],
  seen: Set<string>,
): void {
  if (!isObjectRecord(raw)) {
    issues.push(issue(path, "invalid_type", "an autonomy entry is an object"));
    return;
  }
  rejectUnknownFields(raw, ["capabilityId", "level"], path, "an autonomy entry", issues);
  if (!isIdentifier(raw.capabilityId)) {
    issues.push(issue(`${path}/capabilityId`, "invalid_id", "a capabilityId is an identifier"));
  } else if (seen.has(raw.capabilityId)) {
    issues.push(
      issue(
        `${path}/capabilityId`,
        "duplicate_autonomy_capability",
        "an autonomy capabilityId is listed twice; its authority ceiling must be single-valued",
      ),
    );
  } else {
    seen.add(raw.capabilityId);
  }
  if (!isNonNegativeInt(raw.level) || (raw.level as number) > 8) {
    issues.push(issue(`${path}/level`, "invalid_autonomy_level", "an autonomy level is an integer from 0 to 8"));
  }
}

/** Validate an agent declaration from untrusted input. */
export function validateAgent(input: unknown): ValidationResult<VinciAgent> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];

  rejectUnknownFields(
    record,
    [
      "schemaVersion", "agentId", "version", "modelClass", "systemPolicyRef", "skills",
      "requiredCapabilities", "allowedToolCategories", "permissionPolicyRef", "autonomy",
    ],
    "",
    "an agent",
    issues,
  );

  if (record.schemaVersion !== 1) {
    issues.push(issue("/schemaVersion", "invalid_schema_version", "this schema is version 1"));
  }
  if (!isIdentifier(record.agentId)) {
    issues.push(issue("/agentId", "invalid_id", "agentId is an identifier"));
  }
  if (!isPositiveInt(record.version)) {
    issues.push(issue("/version", "invalid_version", "an agent version is a positive integer"));
  }
  if (!isNonBlankText(record.modelClass)) {
    issues.push(issue("/modelClass", "required_field", "modelClass must be non-blank text"));
  }
  for (const field of ["systemPolicyRef", "permissionPolicyRef"] as const) {
    if (!isNonBlankText(record[field])) {
      issues.push(issue(`/${field}`, "required_field", `${field} must be non-blank text`));
    }
  }

  if (!Array.isArray(record.skills)) {
    issues.push(issue("/skills", "invalid_type", "skills is an array"));
  } else {
    const seen = new Set<string>();
    record.skills.forEach((raw, i) => validateSkill(raw, `/skills/${i}`, issues, seen));
  }

  if (!Array.isArray(record.requiredCapabilities)) {
    issues.push(issue("/requiredCapabilities", "invalid_type", "requiredCapabilities is an array"));
  } else {
    const seen = new Set<string>();
    record.requiredCapabilities.forEach((raw, i) =>
      validateRequiredCapability(raw, `/requiredCapabilities/${i}`, issues, seen),
    );
  }

  if (!Array.isArray(record.allowedToolCategories)) {
    issues.push(issue("/allowedToolCategories", "invalid_type", "allowedToolCategories is an array"));
  } else {
    const seen = new Set<string>();
    record.allowedToolCategories.forEach((value, i) => {
      if (!isEnumMember(value, TOOL_CATEGORIES)) {
        issues.push(
          issue(`/allowedToolCategories/${i}`, "unknown_tool_category", "a tool category must come from TOOL_CATEGORIES"),
        );
      } else if (seen.has(value)) {
        issues.push(issue(`/allowedToolCategories/${i}`, "duplicate_tool_category", "a tool category is listed twice"));
      } else {
        seen.add(value);
      }
    });
  }

  if (!Array.isArray(record.autonomy)) {
    issues.push(issue("/autonomy", "invalid_type", "autonomy is an array"));
  } else {
    const seen = new Set<string>();
    record.autonomy.forEach((raw, i) => validateAutonomy(raw, `/autonomy/${i}`, issues, seen));
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as VinciAgent, {});
}

/** The identity of an agent: SHA-256 over the canonical, validated declaration. */
export function agentDigest(agent: VinciAgent): string {
  return digestValidated("agent", validateAgent(agent));
}

export const AGENT_SCHEMA_META: SchemaMeta = {
  id: "vinci.agent",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};
