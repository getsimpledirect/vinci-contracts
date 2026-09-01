function providerTerms(endpoint) {
  if (endpoint?.provider === "aws-bedrock") return "AWS Bedrock service terms";
  if (endpoint?.provider === "openrouter") return "OpenRouter terms of service";
  if (endpoint?.provider) return `${endpoint.provider} terms of service`;
  return "provider terms of service";
}

/**
 * Map every unevaluable matcher reason into something the report will show.
 * An unknown reason is an instrument gap, never evidence that there are no
 * undeclared facts.
 */
export function mapUnevaluableReason(reason, endpoint) {
  if (reason?.code === "rights_undeclared") {
    const match = typeof reason.detail === "string"
      ? reason.detail.match(/requires (\w+) to be declared/)
      : null;
    return {
      field: match?.[1] || "unparsed:rights_undeclared",
      document: providerTerms(endpoint),
    };
  }
  if (reason?.code === "retention_undeclared") {
    return { field: "outputRetainedByProvider", document: providerTerms(endpoint) };
  }
  if (reason?.code === "external_provider_undeclared") {
    return { field: "inferenceIsExternal", document: "endpoint infrastructure audit" };
  }
  if (reason?.code === "protected_data_approval_undeclared") {
    return {
      field: "approvedForProtectedData",
      document: "internal protected-data approval record",
    };
  }

  if (reason?.code === "harness_capabilities_unverified") {
    // Not a property of the endpoint or of any provider's terms. The unresolved fact is
    // whether the CALLING HARNESS has established these capabilities, which only the
    // caller can attest by passing them to matchEndpointToRole.
    return {
      field: "attestedHarnessCapabilities",
      document: "harness capability attestation (supplied by the caller, not the registry)",
    };
  }

  const code = typeof reason?.code === "string" && reason.code.length > 0
    ? reason.code
    : "unknown_reason";
  return {
    field: `unmapped:${code}`,
    document: "matcher/report mapping audit",
  };
}
