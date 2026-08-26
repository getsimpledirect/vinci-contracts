import type { ArtifactId } from "@getsimpledirect/vinci-contracts";

/** Closed deliberately: internal model reasoning is not session-stream data. */
export const SESSION_FRAME_KINDS = [
  "current_action",
  "tool_activity",
  "diff_preview",
  "question",
  "warning",
  "artifact_preview",
  "redaction_notice",
] as const;

export type SessionFrameKind = (typeof SESSION_FRAME_KINDS)[number];

export type CurrentActionBody = {
  /** A single human-readable line describing what is happening now. */
  readonly text: string;
};

export type ToolActivityBody = {
  readonly toolName: string;
  /** A bounded human-readable projection, never the raw invocation payload. */
  readonly summary: string;
};

export type DiffPreviewBody = {
  readonly path: string;
  readonly hunk: string;
  /** True when the host shortened the hunk before constructing this frame. */
  readonly truncated: boolean;
  /** SHA-256 of the complete, untruncated diff content. */
  readonly digest: string;
};

export type QuestionBody = {
  /** Correlates this ephemeral prompt to the durable `run.question` event. */
  readonly questionId: string;
  readonly prompt: string;
};

export type WarningBody = {
  readonly message: string;
};

type ArtifactPreviewIdentity = {
  readonly artifactId: ArtifactId;
  readonly mime: string;
  readonly caption: string;
};

/** Inline excerpts and digest-only previews are mutually exclusive. */
export type ArtifactPreviewBody = ArtifactPreviewIdentity &
  (
    | { readonly textExcerpt: string; readonly digest?: never }
    | { readonly digest: string; readonly textExcerpt?: never }
  );

export type RedactionNoticeBody = {
  readonly count: number;
  /** A short symbolic category, not a redacted value. */
  readonly category: string;
};

export type SessionFrameBodyByKind = {
  readonly current_action: CurrentActionBody;
  readonly tool_activity: ToolActivityBody;
  readonly diff_preview: DiffPreviewBody;
  readonly question: QuestionBody;
  readonly warning: WarningBody;
  readonly artifact_preview: ArtifactPreviewBody;
  readonly redaction_notice: RedactionNoticeBody;
};
