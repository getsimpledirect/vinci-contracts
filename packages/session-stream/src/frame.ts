import type {
  OrganizationId,
  RunId,
  Timestamp,
  WorkspaceId,
} from "@getsimpledirect/vinci-contracts";
import type { SessionId } from "@getsimpledirect/vinci-remote-protocol";
import type { SessionFrameBodyByKind, SessionFrameKind } from "./frame-types.ts";

export type SessionFrameFor<T extends SessionFrameKind> = {
  readonly protocolVersion: number;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  /** Required and explicitly null for a personal workspace, never absent. */
  readonly organizationId: OrganizationId | null;
  readonly workspaceId: WorkspaceId;
  /** Position in this session stream. Zero is valid; values are contiguous. */
  readonly seq: number;
  readonly at: Timestamp;
  readonly kind: T;
  readonly body: SessionFrameBodyByKind[T];
};

export type SessionFrame = {
  [T in SessionFrameKind]: SessionFrameFor<T>;
}[SessionFrameKind];
