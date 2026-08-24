import { isIdentifier } from "./scalars.ts";
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
 * Checked constructors for the branded ids above.
 *
 * Without these a consumer has exactly one way to produce an `EvidenceId`:
 *
 *   const id = "evidence-1" as EvidenceId;
 *
 * which is an UNCHECKED cast — the one construct this repository argues against
 * everywhere else. It asserts a property the compiler then stops questioning,
 * and it does not look at the value at all, so `"" as EvidenceId` and
 * `"   " as EvidenceId` both typecheck and both name nothing.
 *
 * This was found the way most things here are found: a README example failed to
 * compile, and the only workaround visible to its author was to copy the cast
 * out of a test file. Five repositories are about to depend on this package;
 * each of them would have hit the same wall on their first line and reached for
 * the same cast.
 *
 * Each constructor validates before branding and returns null on failure, so a
 * bad id is refused at the boundary rather than carried as a lie. They do not
 * throw: an identifier arriving from outside is data, not a programming error.
 */
function checkedId<T extends string>(): (value: unknown) => Branded<T> | null {
  return (value: unknown) => (isIdentifier(value) ? (value as Branded<T>) : null);
}

export const toOrganizationId = checkedId<"OrganizationId">();
export const toWorkspaceId = checkedId<"WorkspaceId">();
export const toRunId = checkedId<"RunId">();
export const toWorkerId = checkedId<"WorkerId">();
export const toAgentId = checkedId<"AgentId">();
export const toDeviceId = checkedId<"DeviceId">();
export const toUserId = checkedId<"UserId">();
export const toApprovalId = checkedId<"ApprovalId">();
export const toArtifactId = checkedId<"ArtifactId">();
export const toEvidenceId = checkedId<"EvidenceId">();
export const toReceiptId = checkedId<"ReceiptId">();
export const toPolicyId = checkedId<"PolicyId">();

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
