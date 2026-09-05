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
import { digestValidated } from "./digest.ts";
import {
  isEnumMember,
  isNonNegativeInt,
  isObjectRecord,
  issue,
  rejectUnknownFields,
} from "./lib/validate.ts";

/**
 * The durable declaration of where an agent runs.
 *
 * An environment is the bounded place a run happens in: where it is placed,
 * the image it boots from, the network and filesystem policy it operates under,
 * the resources it may consume, and how secrets are delivered. The policy
 * fields are closed sets so a consumer can reason about them without guessing:
 * an allowed network category that is not declared is not allowed.
 */
export type VinciEnvironment = {
  readonly schemaVersion: 1;
  readonly environmentId: string;
  readonly placement: "vinci_cloud" | "local" | "hybrid";
  readonly imageDigest: string;
  readonly runtimeBuild: string;
  readonly networkPolicy: NetworkPolicy;
  readonly filesystem: FilesystemPolicy;
  readonly resourceLimits: ResourceLimits;
  readonly secretPolicy: SecretPolicy;
};

export type NetworkPolicy = {
  readonly default: "deny" | "allow";
  readonly allowedCategories: readonly NetworkCategory[];
};

export const NETWORK_CATEGORIES = ["model_provider", "github", "approved_tool_broker"] as const;
export type NetworkCategory = (typeof NETWORK_CATEGORIES)[number];

export type FilesystemPolicy = {
  readonly base: "ephemeral" | "persistent";
  readonly mounts: readonly MountKind[];
};

export const MOUNT_KINDS = ["repository_cache_readonly", "workspace", "artifact_store"] as const;
export type MountKind = (typeof MOUNT_KINDS)[number];

export type ResourceLimits = {
  readonly cpu: number;
  readonly memoryMb: number;
  readonly diskMb: number;
  readonly wallSeconds: number;
};

export const SECRET_SOURCES = ["platform_vault", "none"] as const;
export type SecretSource = (typeof SECRET_SOURCES)[number];

export type SecretPolicy = {
  readonly source: SecretSource;
  readonly delivery: "run_scoped";
};

/** Validate an environment declaration from untrusted input. */
export function validateEnvironment(input: unknown): ValidationResult<VinciEnvironment> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];

  rejectUnknownFields(
    record,
    [
      "schemaVersion", "environmentId", "placement", "imageDigest", "runtimeBuild",
      "networkPolicy", "filesystem", "resourceLimits", "secretPolicy",
    ],
    "",
    "an environment",
    issues,
  );

  if (record.schemaVersion !== 1) {
    issues.push(issue("/schemaVersion", "invalid_schema_version", "this schema is version 1"));
  }
  if (!isIdentifier(record.environmentId)) {
    issues.push(issue("/environmentId", "invalid_id", "environmentId is an identifier"));
  }
  if (!isEnumMember(record.placement, ["vinci_cloud", "local", "hybrid"])) {
    issues.push(issue("/placement", "unknown_placement", "placement must be vinci_cloud, local, or hybrid"));
  }
  if (!isDigest(record.imageDigest)) {
    issues.push(issue("/imageDigest", "invalid_digest", "imageDigest is 64 lowercase hex characters"));
  }
  if (!isNonBlankText(record.runtimeBuild)) {
    issues.push(issue("/runtimeBuild", "required_field", "runtimeBuild must be non-blank text"));
  }

  if (!isObjectRecord(record.networkPolicy)) {
    issues.push(issue("/networkPolicy", "invalid_type", "networkPolicy is an object"));
  } else {
    const np = record.networkPolicy;
    rejectUnknownFields(np, ["default", "allowedCategories"], "/networkPolicy", "networkPolicy", issues);
    if (!isEnumMember(np.default, ["deny", "allow"])) {
      issues.push(issue("/networkPolicy/default", "unknown_network_default", "default must be deny or allow"));
    }
    if (!Array.isArray(np.allowedCategories)) {
      issues.push(issue("/networkPolicy/allowedCategories", "invalid_type", "allowedCategories is an array"));
    } else {
      const seen = new Set<string>();
      np.allowedCategories.forEach((value, i) => {
        if (!isEnumMember(value, NETWORK_CATEGORIES)) {
          issues.push(
            issue(`/networkPolicy/allowedCategories/${i}`, "unknown_network_category", "a network category must come from NETWORK_CATEGORIES"),
          );
        } else if (seen.has(value)) {
          issues.push(issue(`/networkPolicy/allowedCategories/${i}`, "duplicate_network_category", "a network category is listed twice"));
        } else {
          seen.add(value);
        }
      });
    }
  }

  if (!isObjectRecord(record.filesystem)) {
    issues.push(issue("/filesystem", "invalid_type", "filesystem is an object"));
  } else {
    const fs = record.filesystem;
    rejectUnknownFields(fs, ["base", "mounts"], "/filesystem", "filesystem", issues);
    if (!isEnumMember(fs.base, ["ephemeral", "persistent"])) {
      issues.push(issue("/filesystem/base", "unknown_filesystem_base", "base must be ephemeral or persistent"));
    }
    if (!Array.isArray(fs.mounts)) {
      issues.push(issue("/filesystem/mounts", "invalid_type", "mounts is an array"));
    } else {
      const seen = new Set<string>();
      fs.mounts.forEach((value, i) => {
        if (!isEnumMember(value, MOUNT_KINDS)) {
          issues.push(
            issue(`/filesystem/mounts/${i}`, "unknown_mount_kind", "a mount must come from MOUNT_KINDS"),
          );
        } else if (seen.has(value)) {
          issues.push(issue(`/filesystem/mounts/${i}`, "duplicate_mount_kind", "a mount kind is listed twice"));
        } else {
          seen.add(value);
        }
      });
    }
  }

  if (!isObjectRecord(record.resourceLimits)) {
    issues.push(issue("/resourceLimits", "invalid_type", "resourceLimits is an object"));
  } else {
    const rl = record.resourceLimits;
    rejectUnknownFields(rl, ["cpu", "memoryMb", "diskMb", "wallSeconds"], "/resourceLimits", "resourceLimits", issues);
    for (const field of ["cpu", "memoryMb", "diskMb", "wallSeconds"] as const) {
      if (!isNonNegativeInt(rl[field])) {
        issues.push(issue(`/resourceLimits/${field}`, "invalid_resource_limit", `${field} is a non-negative integer`));
      }
    }
  }

  if (!isObjectRecord(record.secretPolicy)) {
    issues.push(issue("/secretPolicy", "invalid_type", "secretPolicy is an object"));
  } else {
    const sp = record.secretPolicy;
    rejectUnknownFields(sp, ["source", "delivery"], "/secretPolicy", "secretPolicy", issues);
    if (!isEnumMember(sp.source, SECRET_SOURCES)) {
      issues.push(issue("/secretPolicy/source", "unknown_secret_source", "source must be platform_vault or none"));
    }
    if (!isEnumMember(sp.delivery, ["run_scoped"])) {
      issues.push(issue("/secretPolicy/delivery", "unknown_secret_delivery", "delivery must be run_scoped"));
    }
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as VinciEnvironment, {});
}

/** The identity of an environment: SHA-256 over the canonical, validated declaration. */
export function environmentDigest(environment: VinciEnvironment): string {
  return digestValidated("environment", validateEnvironment(environment));
}

export const ENVIRONMENT_SCHEMA_META: SchemaMeta = {
  id: "vinci.environment",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};
