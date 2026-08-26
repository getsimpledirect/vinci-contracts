import type { RunId, Timestamp } from "@getsimpledirect/vinci-contracts";
import type { SessionId } from "@getsimpledirect/vinci-remote-protocol";
import type { SessionFrameBodyByKind, SessionFrameKind } from "./frame-types.ts";

export type SessionFrameFor<T extends SessionFrameKind> = {
  readonly protocolVersion: number;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  /** Position in this session stream. Zero is valid; values are contiguous. */
  readonly seq: number;
  readonly at: Timestamp;
  readonly kind: T;
  readonly body: SessionFrameBodyByKind[T];
};

export type SessionFrame = {
  [T in SessionFrameKind]: SessionFrameFor<T>;
}[SessionFrameKind];
