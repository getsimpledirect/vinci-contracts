/**
 * Identifier types for the glossary nouns of §7.
 *
 * These are branded strings rather than bare `string` so that a `RunId` cannot
 * be passed where a `WorkspaceId` is expected. That mistake is otherwise
 * invisible to the compiler and expensive at runtime — an event attributed to
 * the wrong workspace crosses an organizational boundary (FR-9.4).
 */

import { ownData } from "./scalars.ts";

declare const brand: unique symbol;
type Branded<T extends string> = string & { readonly [brand]: T };

export type OrganizationId = Branded<"OrganizationId">;
export type WorkspaceId = Branded<"WorkspaceId">;
export type RunId = Branded<"RunId">;
export type WorkerId = Branded<"WorkerId">;
export type AgentId = Branded<"AgentId">;
export type DeviceId = Branded<"DeviceId">;
export type UserId = Branded<"UserId">;
export type ApprovalId = Branded<"ApprovalId">;
export type ArtifactId = Branded<"ArtifactId">;
export type EvidenceId = Branded<"EvidenceId">;
export type ReceiptId = Branded<"ReceiptId">;
export type PolicyId = Branded<"PolicyId">;

/**
 * A workspace is either personal or organizational, and the two must stay
 * distinguishable (§7, FR-9.4). Modelling this as a discriminated union rather
 * than a nullable `organizationId` means code cannot forget to handle the
 * personal case, which is how personal content leaks into an organizational
 * view — or how personal credit gets spent on organizational work.
 */
export type WorkspaceRef =
  | { readonly kind: "personal"; readonly workspaceId: WorkspaceId; readonly ownerId: UserId }
  | {
      readonly kind: "organization";
      readonly workspaceId: WorkspaceId;
      readonly organizationId: OrganizationId;
    };

export function isOrganizationWorkspace(
  ref: WorkspaceRef,
): ref is Extract<WorkspaceRef, { kind: "organization" }> {
  return ownData(ref, "kind") === "organization";
}
