import { isIdentifier } from "@getsimpledirect/vinci-contracts";
import type {
  EndpointServingKind,
  EndpointSourceClass,
  ModelEndpointSpec,
} from "./endpoint.ts";

/**
 * Report whether a reviewer shares an endpoint identity with the producer.
 *
 * Endpoint ids identify the same configured lane. Open-weight and
 * Vinci-pretrained endpoints are also identical when their weights digests
 * match, even across those two source classes. Frontier API identity uses the
 * observable provider/model pair. That pair is only a lower bound on sameness:
 * different labels or providers can still conceal shared underlying weights.
 *
 * Independence requires checking BOTH axes:
 * - Two endpoints with the same weightsDigest are NOT independent, regardless of serving.
 * - Two endpoints on the same provider+model are NOT independent, regardless of provenance.
 */

/**
 * Every field identity depends on, read EXACTLY ONCE, into a plain record no
 * accessor can reach again.
 *
 * This is not defensive style. An earlier form of this function validated the
 * endpoint and then re-read the same fields to compare them, so a getter could
 * return a legible enum member to the check and a different one to the
 * comparison -- passing legibility, making the two source classes differ, and
 * being granted independence while the stable identity was a shared
 * weightsDigest that must block. Check-then-use is exactly what an accessor
 * defeats; the snapshot is what closes it.
 */
type EndpointIdentity = {
  readonly endpointId: unknown;
  readonly sourceClass: EndpointSourceClass;
  readonly servingKind: EndpointServingKind;
  readonly servingProvider: unknown;
  readonly servingModel: unknown;
  readonly weightsDigest: unknown;
  readonly servedArtifact: ServedArtifactIdentity;
};

type ServedArtifactIdentity =
  | { readonly kind: "unknown" }
  | { readonly kind: "known"; readonly artifactKind: "proprietary" }
  | { readonly kind: "known"; readonly artifactKind: "digest"; readonly value: unknown }
  | { readonly kind: "malformed" };

type IdentityScheme = "frontier" | "digest";

function isEndpointSourceClass(value: unknown): value is EndpointSourceClass {
  return value === "frontier_api" || value === "open_weight" || value === "vinci_pretrained";
}

function isEndpointServingKind(value: unknown): value is EndpointServingKind {
  return value === "vinci_hosted" || value === "third_party_api";
}

function unreachableSourceClass(value: never): never {
  throw new Error(`unclassified endpoint source: ${String(value)}`);
}

function unreachableServingKind(value: never): never {
  throw new Error(`unclassified endpoint serving kind: ${String(value)}`);
}

/** Adding a source class must make an explicit, compile-checked identity decision. */
function identityScheme(sourceClass: EndpointSourceClass): IdentityScheme {
  switch (sourceClass) {
    case "frontier_api":
      return "frontier";
    case "open_weight":
    case "vinci_pretrained":
      return "digest";
    default:
      return unreachableSourceClass(sourceClass);
  }
}

/** Copy every artifact discriminator and payload; retain no caller-owned object. */
function snapshotServedArtifact(value: unknown): ServedArtifactIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "malformed" };
  }
  const explicit = value as Record<string, unknown>;
  const explicitKind = explicit["kind"];
  const explicitHasValue = Object.hasOwn(explicit, "value");
  if (explicitKind === "unknown") {
    return explicitHasValue ? { kind: "malformed" } : { kind: "unknown" };
  }
  if (explicitKind !== "known" || !explicitHasValue) return { kind: "malformed" };

  const artifactValue = explicit["value"];
  if (
    typeof artifactValue !== "object" ||
    artifactValue === null ||
    Array.isArray(artifactValue)
  ) {
    return { kind: "malformed" };
  }
  const artifact = artifactValue as Record<string, unknown>;
  const artifactKind = artifact["kind"];
  const artifactHasValue = Object.hasOwn(artifact, "value");
  if (artifactKind === "proprietary") {
    return artifactHasValue
      ? { kind: "malformed" }
      : { kind: "known", artifactKind: "proprietary" };
  }
  if (artifactKind !== "digest" || !artifactHasValue) return { kind: "malformed" };
  return {
    kind: "known",
    artifactKind: "digest",
    value: artifact["value"],
  };
}

/** Snapshot serving descriptor fields exactly once. */
function snapshotServing(
  value: unknown,
): { kind: EndpointServingKind; provider: unknown; model: unknown } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const servingKind = record["kind"];
  if (!isEndpointServingKind(servingKind)) return undefined;

  if (servingKind === "vinci_hosted") {
    return { kind: "vinci_hosted", provider: undefined, model: undefined };
  } else {
    return {
      kind: "third_party_api",
      provider: record["provider"],
      model: record["model"],
    };
  }
}

/** Extract the actual identifier value from an ExplicitValue. */
function snapshotExplicitIdentifier(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const kind = record["kind"];
  if (kind === "unknown") return undefined;
  if (kind !== "known") return undefined;
  return record["value"];
}

function snapshotIdentity(value: unknown): EndpointIdentity | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const sourceClass = record["sourceClass"];
  if (!isEndpointSourceClass(sourceClass)) return undefined;

  const serving = snapshotServing(record["serving"]);
  if (serving === undefined) return undefined;

  const endpointId = record["endpointId"];
  const snapshot: EndpointIdentity = sourceClass === "frontier_api"
    ? {
        endpointId,
        sourceClass,
        servingKind: serving.kind,
        servingProvider: serving.provider,
        servingModel: serving.model,
        weightsDigest: undefined,
        servedArtifact: snapshotServedArtifact(record["servedArtifact"]),
      }
    : {
        endpointId,
        sourceClass,
        servingKind: serving.kind,
        servingProvider: serving.provider,
        servingModel: serving.model,
        weightsDigest: snapshotExplicitIdentifier(record["weightsDigest"]),
        servedArtifact: { kind: "malformed" },
      };
  if (!isIdentifier(snapshot.endpointId)) return undefined;
  return snapshot;
}

function hasLegibleArtifactIdentity(identity: EndpointIdentity): boolean {
  if (identityScheme(identity.sourceClass) === "frontier") {
    const artifact = identity.servedArtifact;
    if (artifact.kind === "unknown" || artifact.kind === "malformed") return false;
    if (artifact.artifactKind === "proprietary") return true;
    return typeof artifact.value === "string" && artifact.value.length > 0;
  }

  // For digest-identified endpoints, we need the weightsDigest
  if (!isIdentifier(identity.weightsDigest)) return false;

  // For third-party served endpoints, we also need provider and model
  if (identity.servingKind === "third_party_api") {
    return (
      typeof identity.servingProvider === "string" &&
      identity.servingProvider.length > 0 &&
      typeof identity.servingModel === "string" &&
      identity.servingModel.length > 0
    );
  }

  return true;
}

function crossSchemeViolation(
  frontier: EndpointIdentity,
  digest: EndpointIdentity,
): boolean {
  const artifact = frontier.servedArtifact;
  if (artifact.kind === "unknown" || artifact.kind === "malformed") return true;
  if (artifact.artifactKind === "proprietary") return false;
  if (typeof artifact.value !== "string" || artifact.value.length === 0) return true;
  return artifact.value === digest.weightsDigest;
}

export function violatesIndependence(
  producer: ModelEndpointSpec,
  reviewer: ModelEndpointSpec,
): boolean {
  try {
    // May only answer "independent" when BOTH identities are legible. An absent
    // identity is not a different identity: comparing absent fields silently
    // succeeds, which is how every earlier version of this bug worked.
    const p = snapshotIdentity(producer);
    const r = snapshotIdentity(reviewer);
    if (p === undefined || r === undefined) return true;
    if (!hasLegibleArtifactIdentity(p) || !hasLegibleArtifactIdentity(r)) return true;

    if (p.endpointId === r.endpointId) return true;

    // Open-weight and Vinci-pretrained are two provenance classes for the same
    // digest-identified identity scheme. The class labels may differ while the
    // weights are byte-identical, so compare their digests before considering
    // a differing source class independent.
    const pIsDigestIdentified = identityScheme(p.sourceClass) === "digest";
    const rIsDigestIdentified = identityScheme(r.sourceClass) === "digest";
    if (pIsDigestIdentified && rIsDigestIdentified) {
      return p.weightsDigest === r.weightsDigest;
    }

    // An absent identity is not a different identity. Across schemes, the
    // frontier's snapshotted artifact declaration must prove either that it is
    // proprietary or that its digest differs from the local artifact.
    if (pIsDigestIdentified !== rIsDigestIdentified) {
      return pIsDigestIdentified
        ? crossSchemeViolation(r, p)
        : crossSchemeViolation(p, r);
    }

    if (identityScheme(p.sourceClass) === "frontier") {
      // For frontier endpoints, check if both are on the same provider+model
      // (for third-party API serving). If so, they're not independent.
      if (
        p.servingKind === "third_party_api" &&
        r.servingKind === "third_party_api" &&
        p.servingProvider === r.servingProvider &&
        p.servingModel === r.servingModel
      ) {
        return true;
      }

      // Weaker than a digest by construction: a provider may serve changed
      // weights behind an unchanged model name, so equality is a LOWER BOUND on
      // sameness and inequality does not prove independence. Until the contract
      // carries stronger identity evidence, no frontier/frontier pair can
      // establish an independent review relationship.
      return true;
    }

    // The only remaining same-class cases are digest-identified and returned
    // above. Keep this fail-closed if the source-class union grows without an
    // explicit identity rule.
    return true;
  } catch {
    return true;
  }
}
