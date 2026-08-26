/**
 * @getsimpledirect/vinci-session-stream — the EPHEMERAL, human-facing channel
 * of a remote session: what the worker is doing now, a bounded diff, a
 * question, a warning, an artifact preview. Frames are display transport with
 * `retention: "ephemeral"`; they are not run history and must never be
 * persisted as the durable record (that is `vinci-run-events`) nor carry
 * authority (that is `vinci-remote-protocol`).
 *
 * Model chain-of-thought is NOT a frame kind and never will be. The stream
 * shows a supervising human what the worker is doing, not what the model is
 * thinking; the kinds are a closed set and reasoning text is excluded by
 * design, not by omission.
 */
export * from "./frame-types.ts";
export * from "./frame.ts";
export * from "./schema.ts";
