import type { SchemaMeta } from "@getsimpledirect/vinci-contracts";

const ADDITIVE_PRESERVING_SCHEMA = {
  version: 1,
  compatibility: "additive-only",
  unknownFields: "preserve",
  malformedData: "fail-closed",
  migration: "none",
} as const;

export const MODEL_PROVENANCE_SCHEMA_META = {
  id: "vinci.model-provenance",
  ...ADDITIVE_PRESERVING_SCHEMA,
} as const satisfies SchemaMeta;

export const FALLBACK_RECORD_SCHEMA_META = {
  id: "vinci.model-fallback",
  ...ADDITIVE_PRESERVING_SCHEMA,
} as const satisfies SchemaMeta;

export const CUSTOMER_ENDPOINT_SCHEMA_META = {
  id: "vinci.customer-model-endpoint",
  ...ADDITIVE_PRESERVING_SCHEMA,
} as const satisfies SchemaMeta;

export const RESIDENCY_RECORD_SCHEMA_META = {
  id: "vinci.model-residency",
  ...ADDITIVE_PRESERVING_SCHEMA,
} as const satisfies SchemaMeta;

export const MODEL_ROLE_SPEC_SCHEMA_META = {
  id: "vinci.model-role",
  version: 1,
  compatibility: "additive-only",
  unknownFields: "preserve",
  malformedData: "fail-closed",
  migration: "none",
} as const satisfies SchemaMeta;

export const MODEL_ENDPOINT_SPEC_SCHEMA_META = {
  id: "vinci.model-endpoint",
  version: 1,
  compatibility: "additive-only",
  unknownFields: "preserve",
  malformedData: "fail-closed",
  migration: "none",
} as const satisfies SchemaMeta;
