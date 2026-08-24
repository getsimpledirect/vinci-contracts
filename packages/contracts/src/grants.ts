import type { RunId } from "./ids.ts";

export const GRANT_KINDS = ["allow-once", "allow-remainder-of-run", "allow-bounded"] as const;
export type GrantKind = (typeof GRANT_KINDS)[number];
export type CanonicalGrant =
  | { readonly kind: "allow-once" }
  | { readonly kind: "allow-remainder-of-run"; readonly runId: RunId }
  | { readonly kind: "allow-bounded"; readonly resourceId: string; readonly durationMs: number };
