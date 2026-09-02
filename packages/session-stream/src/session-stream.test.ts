import { describe, expect, it } from "vitest";
import { assertSchemaMetaComplete } from "@getsimpledirect/vinci-contracts";
import { REMOTE_PROTOCOL_VERSION } from "@getsimpledirect/vinci-remote-protocol";
import { validateRunEvent } from "../../run-events/src/index.ts";
import {
  MAX_DIFF_HUNK_BYTES,
  MAX_SESSION_FRAME_BYTES,
  MAX_TOOL_SUMMARY_BYTES,
  SESSION_FRAME_KINDS,
  SESSION_FRAME_SCHEMA_META,
  frameMatchesBinding,
  nextSeqIsValid,
  validateSessionFrame,
} from "./index.ts";

const AT = "2026-08-26T12:00:00.000Z";
const DIGEST = "a".repeat(64);

function frame(kind: string, body: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    sessionId: "session-1",
    runId: "run-1",
    organizationId: null,
    workspaceId: "workspace-1",
    seq: 0,
    at: AT,
    kind,
    body,
    ...overrides,
  };
}

const VALID_BODIES = {
  current_action: { text: "Reading the validator" },
  tool_activity: { toolName: "read_file", summary: "Read schema.ts" },
  diff_preview: {
    path: "src/schema.ts",
    hunk: "@@ -1 +1 @@\n-old\n+new",
    truncated: false,
    digest: DIGEST,
  },
  question: { questionId: "question-1", prompt: "Which environment should I deploy to?" },
  warning: { reasonCode: "provider_stalled", message: "The provider has not answered in 40s." },
  artifact_preview: {
    artifactId: "artifact-1",
    mime: "text/plain",
    caption: "Test output",
    textExcerpt: "12 tests passed",
  },
  redaction_notice: { count: 2, category: "credential" },
} as const;

describe("session frame kinds", () => {
  it("validates every declared frame kind", () => {
    expect(Object.keys(VALID_BODIES).sort()).toEqual([...SESSION_FRAME_KINDS].sort());
    for (const kind of SESSION_FRAME_KINDS) {
      expect(validateSessionFrame(frame(kind, VALID_BODIES[kind])).ok, kind).toBe(true);
    }
  });

  it("keeps model chain-of-thought outside the closed frame vocabulary", () => {
    expect(SESSION_FRAME_KINDS).not.toContain("chain_of_thought");
    expect(SESSION_FRAME_KINDS).not.toContain("model_cot");
    expect(validateSessionFrame(frame("model_cot", { text: "private reasoning" })).ok).toBe(false);
  });

  it("checks the remote protocol version at the envelope", () => {
    expect(
      validateSessionFrame(
        frame("warning", VALID_BODIES.warning, {
          protocolVersion: REMOTE_PROTOCOL_VERSION + 1,
        }),
      ).ok,
    ).toBe(false);
  });

  it("requires an explicit organization binding and accepts explicit null", () => {
    const { organizationId: _dropped, ...withoutOrganization } = frame(
      "warning",
      VALID_BODIES.warning,
    );
    const absent = validateSessionFrame(withoutOrganization);
    expect(absent.ok).toBe(false);
    if (!absent.ok) {
      expect(absent.issues).toContainEqual(
        expect.objectContaining({ path: "/organizationId", code: "required_field" }),
      );
    }

    expect(
      validateSessionFrame(
        frame("warning", VALID_BODIES.warning, { organizationId: null }),
      ).ok,
    ).toBe(true);
  });

  it.each([
    ["organizationId", "not an identifier", "/organizationId"],
    ["workspaceId", "not an identifier", "/workspaceId"],
  ])("rejects an invalid binding field %s", (field, value, path) => {
    const result = validateSessionFrame(
      frame("warning", VALID_BODIES.warning, { [field]: value }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ path, code: "invalid_id" }),
      );
    }
  });

  it("rejects an absent workspace binding", () => {
    const { workspaceId: _dropped, ...withoutWorkspace } = frame(
      "warning",
      VALID_BODIES.warning,
    );
    const result = validateSessionFrame(withoutWorkspace);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ path: "/workspaceId", code: "invalid_id" }),
      );
    }
  });

  it("declares the frame schema ephemeral", () => {
    expect(() => assertSchemaMetaComplete(SESSION_FRAME_SCHEMA_META)).not.toThrow();
    expect(SESSION_FRAME_SCHEMA_META.version).toBe(2);
    expect(SESSION_FRAME_SCHEMA_META.migration).not.toBe("none");
    expect(SESSION_FRAME_SCHEMA_META.retention).toBe("ephemeral");
    expect(SESSION_FRAME_SCHEMA_META.unknownFields).toBe("reject");
  });
});

describe("frame binding", () => {
  it("matches all five authenticated binding fields exactly", () => {
    const result = validateSessionFrame(frame("warning", VALID_BODIES.warning));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const binding = {
      protocolVersion: result.value.protocolVersion,
      organizationId: result.value.organizationId,
      workspaceId: result.value.workspaceId,
      runId: result.value.runId,
      sessionId: result.value.sessionId,
    };
    expect(frameMatchesBinding(result.value, binding)).toBe(true);

    const mismatches: Array<[keyof typeof binding, unknown]> = [
      ["protocolVersion", binding.protocolVersion + 1],
      ["organizationId", "organization-elsewhere"],
      ["workspaceId", "workspace-elsewhere"],
      ["runId", "run-elsewhere"],
      ["sessionId", "session-elsewhere"],
    ];
    for (const [field, mismatch] of mismatches) {
      expect(
        frameMatchesBinding(result.value, { ...binding, [field]: mismatch } as typeof binding),
        field,
      ).toBe(false);
    }
  });

  it("distinguishes explicit null from an organization identifier", () => {
    const result = validateSessionFrame(frame("warning", VALID_BODIES.warning));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(
      frameMatchesBinding(result.value, {
        protocolVersion: result.value.protocolVersion,
        organizationId: "organization-1" as typeof result.value.organizationId,
        workspaceId: result.value.workspaceId,
        runId: result.value.runId,
        sessionId: result.value.sessionId,
      }),
    ).toBe(false);
  });
});

describe("bounded display content", () => {
  it("rejects a frame larger than the total UTF-8 byte cap", () => {
    const result = validateSessionFrame(
      frame("warning", { message: "x".repeat(MAX_SESSION_FRAME_BYTES) }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((entry) => entry.code === "frame_too_large")).toBe(
      true,
    );
  });

  it("rejects an oversized diff instead of truncating it", () => {
    const result = validateSessionFrame(
      frame("diff_preview", {
        ...VALID_BODIES.diff_preview,
        hunk: "x".repeat(MAX_DIFF_HUNK_BYTES + 1),
        truncated: true,
      }),
    );
    expect(result.ok).toBe(false);
    expect(
      result.ok === false && result.issues.some((entry) => entry.code === "diff_hunk_too_large"),
    ).toBe(true);
  });

  it("counts UTF-8 bytes rather than JavaScript code units", () => {
    const result = validateSessionFrame(
      frame("diff_preview", {
        ...VALID_BODIES.diff_preview,
        hunk: "é".repeat(MAX_DIFF_HUNK_BYTES / 2 + 1),
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("bounds tool summaries independently of the total frame cap", () => {
    const result = validateSessionFrame(
      frame("tool_activity", {
        toolName: "shell",
        summary: "x".repeat(MAX_TOOL_SUMMARY_BYTES + 1),
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("accepts both values of the host-supplied truncated flag", () => {
    for (const truncated of [false, true]) {
      expect(
        validateSessionFrame(
          frame("diff_preview", { ...VALID_BODIES.diff_preview, truncated }),
        ).ok,
        String(truncated),
      ).toBe(true);
    }
  });
});

describe("content-safety boundaries", () => {
  it.each([
    "secret",
    "clientSecret",
    "secretAccessKey",
    "connectionString",
    "accessToken",
    "api_key",
    "private-key",
    "credentialValue",
  ])("rejects credential-like field name %s", (fieldName) => {
    const body: Record<string, unknown> = { ...VALID_BODIES.warning };
    body[fieldName] = "must-not-enter-the-result";
    const result = validateSessionFrame(frame("warning", body));
    expect(result.ok).toBe(false);
    expect(
      result.ok === false
        && result.issues.some((entry) => entry.code === "credential_field_forbidden"),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain("must-not-enter-the-result");
  });

  it.each(["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"])(
    "rejects hostile own key %s",
    (fieldName) => {
      const hostile = JSON.parse(JSON.stringify(frame("warning", VALID_BODIES.warning))) as Record<
        string,
        unknown
      >;
      Object.defineProperty(hostile, fieldName, {
        value: "hostile",
        enumerable: true,
        configurable: true,
      });
      expect(validateSessionFrame(hostile).ok).toBe(false);
    },
  );

  it("requires exactly one artifact preview representation", () => {
    const identity = {
      artifactId: "artifact-1",
      mime: "text/plain",
      caption: "Log",
    };
    expect(validateSessionFrame(frame("artifact_preview", { ...identity, digest: DIGEST })).ok).toBe(
      true,
    );
    expect(
      validateSessionFrame(
        frame("artifact_preview", { ...identity, digest: DIGEST, textExcerpt: "log" }),
      ).ok,
    ).toBe(false);
    expect(validateSessionFrame(frame("artifact_preview", identity)).ok).toBe(false);
  });
});

describe("sequence semantics", () => {
  it("accepts non-negative frame sequences and rejects negatives", () => {
    expect(validateSessionFrame(frame("warning", VALID_BODIES.warning, { seq: 0 })).ok).toBe(true);
    expect(validateSessionFrame(frame("warning", VALID_BODIES.warning, { seq: -1 })).ok).toBe(false);
    expect(validateSessionFrame(frame("warning", VALID_BODIES.warning, { seq: 1.5 })).ok).toBe(false);
    expect(
      validateSessionFrame(frame("warning", VALID_BODIES.warning, { seq: Number.MAX_SAFE_INTEGER + 1 }))
        .ok,
    ).toBe(false);
  });

  it("detects gaps, replays, negatives, and unsafe values", () => {
    expect(nextSeqIsValid(0, 1)).toBe(true);
    expect(nextSeqIsValid(8, 9)).toBe(true);
    expect(nextSeqIsValid(8, 10)).toBe(false);
    expect(nextSeqIsValid(8, 8)).toBe(false);
    expect(nextSeqIsValid(8, 7)).toBe(false);
    expect(nextSeqIsValid(-1, 0)).toBe(false);
    expect(nextSeqIsValid(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });
});

describe("durable and ephemeral envelopes are mutually exclusive", () => {
  const runEvent = {
    // Run-events schema 3 added a literal tenant binding to every durable event;
    // schema 4 (IR-00) added the governed-run event types. The fixture tracks
    // the CURRENT version because validateRunEvent must accept it (asserted
    // below) for the mutual-exclusion check to be reaching the right object.
    schemaVersion: 4,
    eventId: "event-1",
    runId: "run-1",
    organizationId: null,
    workspaceId: "workspace-1",
    sequence: 1,
    type: "run.question",
    actor: { kind: "worker", workerId: "worker-1" },
    occurredAt: AT,
    idempotencyKey: "key-1",
    traceId: "trace-1",
    payload: { questionId: { kind: "id", value: "question-1" } },
  };

  it("does not validate a durable run event as a session frame", () => {
    expect(validateRunEvent(runEvent).ok).toBe(true);
    expect(validateSessionFrame(runEvent).ok).toBe(false);
  });

  it("does not validate an ephemeral frame as a durable run event", () => {
    const sessionFrame = frame("question", VALID_BODIES.question);
    expect(validateSessionFrame(sessionFrame).ok).toBe(true);
    expect(validateRunEvent(sessionFrame).ok).toBe(false);
  });
});

describe("warning frames correlate to the durable worker.warning vocabulary", () => {
  it("rejects a reasonCode outside WORKER_WARNING_CODES", () => {
    const result = validateSessionFrame(
      frame("warning", { reasonCode: "something_else", message: "free text" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toContain("unknown_reason_code");
    }
  });

  it("rejects a warning with no reasonCode at all", () => {
    const result = validateSessionFrame(frame("warning", { message: "orphan" }));
    expect(result.ok).toBe(false);
  });
});

describe("frame schema version and binding coverage (review fixes)", () => {
  it("rejects a version-1 frame on the wire, not just in the meta", () => {
    const result = validateSessionFrame(frame("current_action", VALID_BODIES.current_action, { schemaVersion: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain("invalid_schema_version");
  });

  it("rejects organizationId: undefined as distinct from explicit null", () => {
    const result = validateSessionFrame(frame("current_action", VALID_BODIES.current_action, { organizationId: undefined }));
    expect(result.ok).toBe(false);
  });

  it("accepts a frame just under the byte cap with the binding fields present", () => {
    const probe = frame("warning", { ...VALID_BODIES.warning, message: "x" });
    const overhead = Buffer.byteLength(JSON.stringify(probe), "utf8") - 1;
    const message = "x".repeat(MAX_SESSION_FRAME_BYTES - overhead);
    expect(validateSessionFrame(frame("warning", { ...VALID_BODIES.warning, message })).ok).toBe(true);
    expect(validateSessionFrame(frame("warning", { ...VALID_BODIES.warning, message: message + "x" })).ok).toBe(false);
  });

  it("a run event carrying organizationId and workspaceId still is not a session frame", () => {
    const event = {
      schemaVersion: 2,
      eventId: "event-1",
      runId: "run-1",
      organizationId: null,
      workspaceId: "workspace-1",
      sequence: 1,
      type: "run.question",
      actor: { kind: "worker", workerId: "worker-1" },
      occurredAt: AT,
      idempotencyKey: "idem-1",
      traceId: "trace-1",
      payload: { questionId: "q-1" },
    };
    expect(validateSessionFrame(event).ok).toBe(false);
  });
});
