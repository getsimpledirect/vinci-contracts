import { describe, expect, it } from "vitest";
import { assertSchemaMetaComplete } from "@getsimpledirect/vinci-contracts";
import {
  PAYLOAD_FIELDS,
  RUN_EVENT_SCHEMA_META,
  RUN_EVENT_TYPES,
  canonicalize,
  eventDigest,
  payloadSpecIsComplete,
  validateRunEvent,
  verifyAppend,
  type RunEvent,
  type RunEventFor,
  type SeenEvent,
} from "./index.ts";

const AT = "2026-08-23T00:00:00.000Z";
const actor = { kind: "worker", workerId: "w-1" } as const;

const event = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 2,
  eventId: "evt-1",
  runId: "run-1",
  sequence: 1,
  type: "run.started",
  actor,
  occurredAt: AT,
  idempotencyKey: "key-1",
  traceId: "trace-1",
  payload: { workerId: { kind: "id", value: "w-1" } },
  ...overrides,
});

const valid = (o: Record<string, unknown> = {}): RunEvent => {
  const result = validateRunEvent(event(o));
  if (!result.ok) throw new Error(`fixture invalid: ${JSON.stringify(result.issues)}`);
  return result.value;
};

describe("the payload allowlist bounds where content can appear", () => {
  it("declares fields for every event type", () => {
    expect(payloadSpecIsComplete()).toBe(true);
    expect(Object.keys(PAYLOAD_FIELDS).sort()).toEqual([...RUN_EVENT_TYPES].sort());
  });

  it("refuses a field that is not declared for the event type", () => {
    // An earlier draft allowed arbitrary field names as long as each value was
    // tagged, so `{ prompt: { kind: "id", value: "<secret>" } }` was accepted.
    // A tag says what the author claims a value is, not what it holds.
    const result = validateRunEvent(
      event({
        type: "run.question",
        payload: {
          questionId: { kind: "id", value: "q-1" },
          prompt: { kind: "id", value: "SECRET PROMPT TEXT" },
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((i) => i.code === "field_not_allowed")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SECRET PROMPT TEXT");
  });

  it("refuses an identifier long enough to be prose", () => {
    const result = validateRunEvent(
      event({ type: "run.question", payload: { questionId: { kind: "id", value: "x".repeat(200) } } }),
    );
    expect(result.ok).toBe(false);
  });

  it("refuses a value whose kind is not what the field declares", () => {
    const result = validateRunEvent(
      event({ type: "run.question", payload: { questionId: { kind: "count", value: 1 } } }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((i) => i.code === "wrong_value_kind")).toBe(true);
  });

  it("closes every enum vocabulary it declares", () => {
    // Several fields were declared as enums with no members, which meant the
    // shape check accepted any token-shaped string — an open set wearing a
    // closed set's label.
    for (const [type, spec] of Object.entries(PAYLOAD_FIELDS)) {
      for (const [field, fieldSpec] of Object.entries(spec)) {
        if ((fieldSpec as { kind: string }).kind !== "enum") continue;
        expect(
          (fieldSpec as { members?: readonly string[] }).members,
          `${type}.${field} declares an enum with no closed set`,
        ).toBeDefined();
      }
    }
  });

  it("refuses an invented member of a closed vocabulary", () => {
    const result = validateRunEvent(
      event({
        type: "run.failed",
        payload: { reasonCode: { kind: "enum", value: "INVENTED_TOKEN" } },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((i) => i.code === "unknown_enum_member")).toBe(true);
  });
});

describe("human attention events", () => {
  const cases = [
    {
      type: "run.question_answered",
      payload: {
        questionId: { kind: "id", value: "q-1" },
        humanSeconds: { kind: "count", value: 12 },
      },
      newFields: ["questionId", "humanSeconds"],
    },
    {
      type: "approval.granted",
      payload: {
        approvalId: { kind: "id", value: "approval-1" },
        narrowed: { kind: "flag", value: false },
        humanSeconds: { kind: "count", value: 8 },
      },
      newFields: ["humanSeconds"],
    },
    {
      type: "approval.denied",
      payload: {
        approvalId: { kind: "id", value: "approval-1" },
        humanSeconds: { kind: "count", value: 5 },
      },
      newFields: ["humanSeconds"],
    },
    {
      type: "run.completed",
      payload: {
        terminalState: { kind: "enum", value: "DONE" },
        humanAttentionSeconds: { kind: "count", value: 25 },
        humanDecisions: { kind: "count", value: 2 },
        humanInterruptions: { kind: "count", value: 3 },
        escalations: { kind: "count", value: 1 },
      },
      newFields: [
        "humanAttentionSeconds",
        "humanDecisions",
        "humanInterruptions",
        "escalations",
      ],
    },
  ] as const;

  it.each(cases)("accepts the complete $type measurement", ({ type, payload }) => {
    expect(validateRunEvent(event({ type, payload })).ok).toBe(true);
  });

  it.each(cases)("requires every new $type field", ({ type, payload, newFields }) => {
    for (const field of newFields) {
      const incomplete = Object.fromEntries(
        Object.entries(payload).filter(([key]) => key !== field),
      );
      const result = validateRunEvent(event({ type, payload: incomplete }));
      expect(result.ok, field).toBe(false);
      expect(
        result.ok === false &&
          result.issues.some(
            (entry) => entry.path === `/payload/${field}` && entry.code === "required_field",
          ),
        field,
      ).toBe(true);
    }
  });

  it.each(cases)("validates the kind of every new $type field", ({ type, payload, newFields }) => {
    for (const field of newFields) {
      const expectedKind = (
        PAYLOAD_FIELDS[type][field as keyof (typeof PAYLOAD_FIELDS)[typeof type]] as {
          kind: string;
        }
      ).kind;
      const wrongValue =
        expectedKind === "count"
          ? { kind: "id", value: "not-a-count" }
          : { kind: "count", value: 1 };
      const result = validateRunEvent(
        event({ type, payload: { ...payload, [field]: wrongValue } }),
      );
      expect(result.ok, field).toBe(false);
      expect(
        result.ok === false &&
          result.issues.some(
            (entry) => entry.path === `/payload/${field}` && entry.code === "wrong_value_kind",
          ),
        field,
      ).toBe(true);
    }
  });

  it("rejects content and prototype-pollution fields on an answer", () => {
    const withContent = validateRunEvent(
      event({
        type: "run.question_answered",
        payload: {
          questionId: { kind: "id", value: "q-1" },
          humanSeconds: { kind: "count", value: 12 },
          answer: { kind: "id", value: "SECRET" },
        },
      }),
    );
    expect(withContent.ok).toBe(false);
    expect(
      withContent.ok === false &&
        withContent.issues.some((entry) => entry.code === "field_not_allowed"),
    ).toBe(true);

    const hostilePayload = JSON.parse(
      '{"questionId":{"kind":"id","value":"q-1"},"humanSeconds":{"kind":"count","value":12},"__proto__":{"polluted":true}}',
    );
    expect(
      validateRunEvent(
        event({ type: "run.question_answered", payload: hostilePayload }),
      ).ok,
    ).toBe(false);
  });
});

describe("actor arms are validated for presence and type, not just names", () => {
  it("refuses a worker actor with no workerId", () => {
    // Accepted before: the name allowlist says nothing about presence.
    expect(validateRunEvent(event({ actor: { kind: "worker" } })).ok).toBe(false);
  });

  it("refuses a worker actor whose workerId is a number", () => {
    expect(validateRunEvent(event({ actor: { kind: "worker", workerId: 5 } })).ok).toBe(false);
  });

  it("refuses a policy actor without a positive integer version", () => {
    for (const version of [undefined, 0, -1, 1.5, "2", 2 ** 53]) {
      const a: Record<string, unknown> = { kind: "policy", policyId: "p-1" };
      if (version !== undefined) a.policyVersion = version;
      expect(validateRunEvent(event({ actor: a })).ok, String(version)).toBe(false);
    }
  });

  it("refuses a verifier that does not state whether it is independent", () => {
    // FR-7.3 requires non-independence to be DISCLOSED; omitting the flag
    // discloses nothing, so it cannot be optional.
    expect(validateRunEvent(event({ actor: { kind: "verifier", verifierId: "v-1" } })).ok).toBe(false);
    expect(
      validateRunEvent(event({ actor: { kind: "verifier", verifierId: "v-1", independent: false } })).ok,
    ).toBe(true);
  });
});

describe("numbers are safe integers", () => {
  it.each([2 ** 53, 2 ** 53 + 2, 1.5, -1, 0, "1"])("refuses sequence %p", (sequence) => {
    expect(validateRunEvent(event({ sequence })).ok).toBe(false);
  });

  it("refuses a count beyond the safe integer range", () => {
    const result = validateRunEvent(
      event({
        type: "worker.heartbeat",
        payload: {
          phase: { kind: "enum", value: "working" },
          activeMs: { kind: "count", value: 2 ** 53 },
          safeToInterrupt: { kind: "flag", value: true },
        },
      }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("canonicalization and identity", () => {
  it("sorts keys recursively, and toPlainRecord does not", () => {
    const a = { b: 1, a: 2, n: { z: 1, y: { q: 1, p: 2 } } };
    const b = { a: 2, b: 1, n: { y: { p: 2, q: 1 }, z: 1 } };
    expect(canonicalize(a)).toBe(canonicalize(b));
    // The reason a separate canonicalizer exists at all.
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("preserves array order, because position is meaning", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it("gives identical events identical digests regardless of key order", () => {
    const one = valid();
    const reordered = validateRunEvent({
      payload: { workerId: { kind: "id", value: "w-1" } },
      traceId: "trace-1",
      idempotencyKey: "key-1",
      occurredAt: AT,
      actor,
      type: "run.started",
      sequence: 1,
      runId: "run-1",
      eventId: "evt-1",
      schemaVersion: 2,
    });
    expect(reordered.ok).toBe(true);
    if (reordered.ok) expect(eventDigest(one)).toBe(eventDigest(reordered.value));
  });

  it("changes the digest when any field changes, including sequence", () => {
    const base = valid();
    const variants: RunEvent[] = [
      valid({ eventId: "evt-2" }),
      valid({ sequence: 2 }),
      valid({ occurredAt: "2026-08-23T00:00:01.000Z" }),
      valid({ traceId: "trace-2" }),
      valid({ idempotencyKey: "key-2" }),
      valid({ actor: { kind: "worker", workerId: "w-2" } }),
      valid({ payload: { workerId: { kind: "id", value: "w-2" } } }),
    ];
    for (const variant of variants) {
      expect(eventDigest(variant)).not.toBe(eventDigest(base));
    }
  });
});

describe("appending to the log", () => {
  const seenWith = (e: RunEvent): Map<string, SeenEvent> => new Map([[e.idempotencyKey, e]]);

  it("accepts a contiguous first and second event", () => {
    const first = valid();
    const second = valid({ eventId: "evt-2", sequence: 2, idempotencyKey: "key-2" });
    expect(verifyAppend(null, first).kind).toBe("append");
    expect(verifyAppend(first, second, seenWith(first)).kind).toBe("append");
  });

  it("treats a true retry as a duplicate, not a rejection", () => {
    // Refusing a retry is how a worker concludes its event was lost and emits a
    // different one.
    const first = valid();
    expect(verifyAppend(null, first, seenWith(first)).kind).toBe("duplicate");
  });

  it("refuses the same key on a different run rather than calling it a retry", () => {
    // The draft checked the idempotency key BEFORE the run, so a key collision
    // across runs silently discarded a real event and reported success.
    const first = valid();
    const otherRun = valid({ runId: "run-2", eventId: "evt-9" });
    const verdict = verifyAppend(first, otherRun, seenWith(first));
    expect(verdict.kind).toBe("reject");
    expect(verdict.kind === "reject" && verdict.rejection.reason).toBe("wrong_run");
  });

  it.each([
    ["a different type", { type: "run.paused", payload: { requestedBy: { kind: "id", value: "u-1" } } }],
    ["a different actor", { actor: { kind: "worker", workerId: "w-2" } }],
    ["a different payload", { payload: { workerId: { kind: "id", value: "w-9" } } }],
    ["a different timestamp", { occurredAt: "2026-08-23T00:00:02.000Z" }],
    ["a different eventId", { eventId: "evt-other" }],
  ])("refuses the same key with %s as an idempotency conflict", (_label, overrides) => {
    const first = valid();
    const impostor = valid(overrides as Record<string, unknown>);
    const verdict = verifyAppend(null, impostor, seenWith(first));
    expect(verdict.kind).toBe("reject");
    expect(verdict.kind === "reject" && verdict.rejection.reason).toBe("idempotency_conflict");
  });

  it("refuses a gap, a reuse, and a first event that is not sequence 1", () => {
    const first = valid();
    expect(verifyAppend(first, valid({ eventId: "e3", sequence: 3, idempotencyKey: "k3" })).kind).toBe("reject");
    expect(verifyAppend(first, valid({ eventId: "e1b", sequence: 1, idempotencyKey: "k1b" })).kind).toBe("reject");
    expect(verifyAppend(null, valid({ sequence: 2, idempotencyKey: "k2" })).kind).toBe("reject");
  });

  it("refuses a timestamp that goes backwards", () => {
    const first = valid({ occurredAt: "2026-08-23T00:00:05.000Z" });
    const backwards = valid({ eventId: "e2", sequence: 2, idempotencyKey: "k2", occurredAt: AT });
    const verdict = verifyAppend(first, backwards);
    expect(verdict.kind).toBe("reject");
    expect(verdict.kind === "reject" && verdict.rejection.reason).toBe("time_went_backwards");
  });
});

describe("the boundary refuses hostile raw input", () => {
  it.each([
    ["a __proto__ key", () => JSON.parse(`{"__proto__":{"p":1},"schemaVersion":2}`)],
    ["an unknown top-level field", () => event({ extra: 1 })],
    ["a wrong schema version", () => event({ schemaVersion: 1 })],
    ["an unknown event type", () => event({ type: "run.exploded" })],
    ["a non-canonical timestamp", () => event({ occurredAt: "2026-08-23T00:00:00Z" })],
    ["a date that does not exist", () => event({ occurredAt: "2026-02-29T00:00:00.000Z" })],
    ["a payload that is an array", () => event({ payload: [] })],
    ["a missing required payload field", () => event({ payload: {} })],
  ])("refuses %s", (_label, build) => {
    expect(validateRunEvent(build()).ok).toBe(false);
  });

  it("drops an inherited field rather than refusing the record", () => {
    // E0's boundary neutralizes prototypes instead of refusing them: the
    // decision depends on the JSON, never on how the object was built. An
    // earlier version of this test asserted refusal, which is the OLD contract.
    // What matters is that the inherited field cannot reach the event.
    const withProto = Object.setPrototypeOf(event(), { injected: "SMUGGLED" });
    const result = validateRunEvent(withProto);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SMUGGLED");
    if (result.ok) expect(Object.hasOwn(result.value, "injected")).toBe(false);
  });

  it("answers all six schema questions", () => {
    expect(() => assertSchemaMetaComplete(RUN_EVENT_SCHEMA_META)).not.toThrow();
    expect(RUN_EVENT_SCHEMA_META.version).toBe(2);
    expect(RUN_EVENT_SCHEMA_META.unknownFields).toBe("reject");
  });
});

describe("the payload type is wired to the event, not merely derived beside it", () => {
  it("rejects a foreign payload field at compile time", () => {
    // The derived PayloadFor existed while RunEvent still carried a broad index
    // signature, so this typechecked and only the runtime rejected it. A
    // structural guarantee that holds only at runtime is a runtime check with a
    // comment attached.
    const good: RunEventFor<"run.question"> = {
      schemaVersion: 2,
      eventId: "evt-1",
      runId: "run-1" as RunEvent["runId"],
      sequence: 1,
      type: "run.question",
      actor,
      occurredAt: AT,
      idempotencyKey: "key-1",
      traceId: "trace-1",
      payload: { questionId: { kind: "id", value: "q-1" } },
    };
    expect(validateRunEvent(good).ok).toBe(true);

    const smuggled: RunEventFor<"run.question"> = {
      ...good,
      payload: {
        questionId: { kind: "id", value: "q-1" },
        // @ts-expect-error `prompt` is not a field of run.question
        prompt: { kind: "id", value: "SECRET" },
      },
    };
    expect(validateRunEvent(smuggled).ok).toBe(false);
  });

  it("rejects a payload belonging to a different event type", () => {
    const mismatched = {
      schemaVersion: 2,
      eventId: "evt-1",
      runId: "run-1",
      sequence: 1,
      type: "run.question",
      actor,
      occurredAt: AT,
      idempotencyKey: "key-1",
      traceId: "trace-1",
      // @ts-expect-error run.question does not take run.started's payload
      payload: { workerId: { kind: "id", value: "w-1" } },
    } satisfies RunEventFor<"run.question">;
    expect(validateRunEvent(mismatched).ok).toBe(false);
  });

  it("declares a compatibility policy its validator actually honours", () => {
    // additive-only means consumers tolerate new fields. This validator rejects
    // them, so the pair was incoherent.
    expect(RUN_EVENT_SCHEMA_META.unknownFields).toBe("reject");
    expect(RUN_EVENT_SCHEMA_META.compatibility).toBe("frozen");
  });
});

describe("idempotency compares events, never a supplied digest", () => {
  it("cannot be told that two different events are the same", () => {
    // The map used to carry { event, digest } with the digest supplied by the
    // caller, so storing event A under B's key with B's digest made B validate
    // as a retry of A: a real event discarded and success reported. A digest
    // left stale by a mutation had the same shape.
    const a = valid({ eventId: "evt-A" });
    const b = valid({ eventId: "evt-B" });
    expect(eventDigest(a)).not.toBe(eventDigest(b));

    // The map now holds events. There is nothing in it to get wrong, and the
    // closest a caller can come to the old attack is filing A under B's key —
    // which is a conflict, not a retry.
    const misfiled = new Map<string, SeenEvent>([[b.idempotencyKey, a]]);
    const verdict = verifyAppend(null, b, misfiled);
    expect(verdict.kind).toBe("reject");
    expect(verdict.kind === "reject" && verdict.rejection.reason).toBe("idempotency_conflict");
  });

  it("still recognises a genuine retry", () => {
    const a = valid();
    expect(verifyAppend(null, a, new Map([[a.idempotencyKey, a]])).kind).toBe("duplicate");
  });

  it("derives both sides of the comparison, so SeenEvent carries no digest", () => {
    // A structural check, not a behavioural one: if a digest field returns to
    // this type, a caller can assert identity again.
    const a = valid();
    const seen: SeenEvent = a;
    expect(Object.hasOwn(seen, "digest")).toBe(false);
    expect(seen).toBe(a);
  });
});

describe("what identifier shape-checking actually enforces", () => {
  // This replaces a claim that content has nowhere to go. It does not: an
  // identifier is bounded in length and alphabet, which excludes free-form
  // prose and not token-shaped content. These tests assert the property that
  // holds, so nobody reads the suite as proving the stronger one.
  const question = (value: string) => ({
    schemaVersion: 2,
    eventId: "evt-1",
    runId: "run-1",
    sequence: 1,
    type: "run.question",
    actor,
    occurredAt: AT,
    idempotencyKey: "key-1",
    traceId: "trace-1",
    payload: { questionId: { kind: "id", value } },
  });

  it.each([
    ["whitespace", "What is the database password"],
    ["a newline", "line one\nline two"],
    ["a tab", "a\tb"],
    ["over 128 characters", "a".repeat(129)],
    ["an empty value", ""],
  ])("refuses an identifier containing %s", (_label, value) => {
    expect(validateRunEvent(question(value)).ok).toBe(false);
  });

  it("ACCEPTS token-shaped content, which is the limit of this mechanism", () => {
    // Deliberately asserting the weakness. If a future change makes these
    // refuse, that is a real improvement and this test should be updated
    // knowingly — not a silent tightening nobody notices.
    for (const tokenShaped of [
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
      "aGVsbG8gd29ybGQgc2VjcmV0",
      "What.is.the.database.password",
    ]) {
      expect(validateRunEvent(question(tokenShaped)).ok, tokenShaped).toBe(true);
    }
  });

  it("still refuses a field that exists only to carry content", () => {
    // The part that IS enforced: no field whose purpose is content.
    const withPrompt = {
      ...question("q-1"),
      payload: { questionId: { kind: "id", value: "q-1" }, prompt: { kind: "id", value: "anything" } },
    };
    expect(validateRunEvent(withPrompt).ok).toBe(false);
  });
});
