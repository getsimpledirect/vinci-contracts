import { assertSchemaMetaComplete } from "@getsimpledirect/vinci-contracts";
import {
  BROADENING_COMMANDS,
  REVERSIBLE_BRAKING_COMMANDS,
  STEERING_COMMANDS,
  TERMINAL_COMMANDS,
  type RemoteCommandKind,
} from "@getsimpledirect/vinci-remote-protocol";
import { describe, expect, it } from "vitest";
import {
  TRUST_LEVEL_REQUIREMENTS,
  TRUST_LEVELS,
  UNMAPPED_COMMANDS,
  WORKER_DECLARATION_SCHEMA_META,
  compareTrustLevels,
  derivedTrustLevel,
  isTrustLevel,
  permittedRemoteCommands,
  trustLevelLabel,
  validateWorkerDeclaration,
  type CapabilityMatrix,
  type TrustLevel,
} from "./index.ts";

function matrix(overrides: Partial<CapabilityMatrix> = {}): CapabilityMatrix {
  return {
    activityStream: false,
    questions: false,
    steering: false,
    approvals: "none",
    pause: false,
    restrictToReadOnly: false,
    abort: false,
    filesystemEnforcement: false,
    networkEnforcement: false,
    structuredEvidence: false,
    nativeReceipts: false,
    safeResume: false,
    independentVerification: false,
    ...overrides,
  };
}

const observed = matrix({ activityStream: true });
const supervised = matrix({
  activityStream: true,
  questions: true,
  approvals: "translated",
  abort: true,
});
const governed = matrix({
  ...supervised,
  pause: true,
  restrictToReadOnly: true,
  filesystemEnforcement: true,
  networkEnforcement: true,
  nativeReceipts: true,
});
const assured = matrix({
  ...governed,
  independentVerification: true,
  structuredEvidence: true,
});

function declaration(
  controlLevel: TrustLevel = "inventoried",
  supports: CapabilityMatrix = matrix(),
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    worker: {
      id: "worker-1",
      name: "Example worker",
      version: "1.2.3",
      buildDigest: "a".repeat(64),
    },
    adapter: { id: "adapter-1", version: "2.0.0" },
    controlLevel,
    supports,
  };
}

describe("ordered trust ladder", () => {
  it("keeps the public order and comparison stable", () => {
    expect(TRUST_LEVELS).toEqual([
      "inventoried",
      "observed",
      "supervised",
      "governed",
      "assured",
    ]);
    expect(TRUST_LEVELS.every(isTrustLevel)).toBe(true);
    expect(isTrustLevel("secure")).toBe(false);
    expect(compareTrustLevels("inventoried", "assured")).toBeLessThan(0);
    expect(compareTrustLevels("governed", "observed")).toBeGreaterThan(0);
    expect(compareTrustLevels("supervised", "supervised")).toBe(0);
  });

  it.each([
    [matrix(), "inventoried"],
    [observed, "observed"],
    [supervised, "supervised"],
    [governed, "governed"],
    [assured, "assured"],
  ] as const)("derives $1 from demonstrated capabilities", (capabilities, expected) => {
    expect(derivedTrustLevel(capabilities)).toBe(expected);
  });

  it("requires each complete rung and ignores unrelated capabilities", () => {
    expect(derivedTrustLevel(matrix({ questions: true, abort: true, steering: true }))).toBe(
      "inventoried",
    );
    expect(derivedTrustLevel(matrix({ ...governed, networkEnforcement: false }))).toBe(
      "supervised",
    );
    expect(derivedTrustLevel(matrix({ ...assured, structuredEvidence: false }))).toBe("governed");
    expect(derivedTrustLevel(matrix({ safeResume: true, steering: true }))).toBe("inventoried");
  });

  it("uses public language that does not overstate the ladder", () => {
    const forbidden = /secure|safe|controlled/i;
    for (const rung of TRUST_LEVEL_REQUIREMENTS) {
      expect(trustLevelLabel(rung.level)).not.toMatch(forbidden);
      expect(rung.description).not.toMatch(forbidden);
      for (const requirement of rung.requirements) {
        expect(requirement.description).not.toMatch(forbidden);
      }
    }
    expect(TRUST_LEVELS.map(trustLevelLabel)).toEqual([
      "Inventoried",
      "Observed",
      "Supervised",
      "Governed",
      "Assured",
    ]);
  });
});

describe("worker declarations", () => {
  it("accepts an exact declaration and exposes complete schema metadata", () => {
    const result = validateWorkerDeclaration(declaration("assured", assured));
    expect(result.ok).toBe(true);
    expect(() => assertSchemaMetaComplete(WORKER_DECLARATION_SCHEMA_META)).not.toThrow();
    expect(WORKER_DECLARATION_SCHEMA_META.unknownFields).toBe("reject");
  });

  it("allows a worker to claim below the derived level", () => {
    expect(validateWorkerDeclaration(declaration("observed", assured)).ok).toBe(true);
  });

  it("rejects a control level above what the adapter demonstrated", () => {
    const result = validateWorkerDeclaration(declaration("governed", observed));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        path: "/controlLevel",
        code: "control_level_overclaimed",
        message: "declared control level governed exceeds derived trust level observed",
      });
    }
  });

  it.each([
    ["root", { extra: true }],
    ["worker", { worker: { extra: true } }],
    ["adapter", { adapter: { extra: true } }],
    ["supports", { supports: { extra: true } }],
  ])("rejects an extra field at the %s level", (_level, change) => {
    const input = declaration();
    if ("extra" in change) input.extra = true;
    if (change.worker) input.worker = { ...(input.worker as object), ...change.worker };
    if (change.adapter) input.adapter = { ...(input.adapter as object), ...change.adapter };
    if (change.supports) input.supports = { ...(input.supports as object), ...change.supports };
    const result = validateWorkerDeclaration(input);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues.map((issue) => issue.code)).toContain("unknown_field");
  });

  it("requires every matrix key and validates the optional digest", () => {
    const missing = declaration();
    const { safeResume: _removed, ...incomplete } = missing.supports as CapabilityMatrix;
    missing.supports = incomplete;
    expect(validateWorkerDeclaration(missing).ok).toBe(false);

    const badDigest = declaration();
    badDigest.worker = { ...(badDigest.worker as object), buildDigest: "ABC" };
    expect(validateWorkerDeclaration(badDigest).ok).toBe(false);
  });

  it.each(["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"])(
    "rejects hostile own key %s without throwing",
    (key) => {
      const input = declaration();
      Object.defineProperty(input, key, { value: true, enumerable: true, configurable: true });
      expect(() => validateWorkerDeclaration(input)).not.toThrow();
      expect(validateWorkerDeclaration(input).ok).toBe(false);
    },
  );
});

describe("remote command rendering", () => {
  it("renders each command only from its corresponding demonstrated capability", () => {
    expect(permittedRemoteCommands(matrix())).toEqual([]);
    expect(permittedRemoteCommands(matrix({ pause: true }))).toEqual(["pause"]);
    expect(permittedRemoteCommands(matrix({ restrictToReadOnly: true }))).toEqual([
      "restrict_to_read_only",
    ]);
    expect(permittedRemoteCommands(matrix({ approvals: "translated" }))).toEqual([
      "deny_pending_approval",
      "approve_pending_approval",
    ]);
    expect(permittedRemoteCommands(matrix({ abort: true }))).toEqual(["abort"]);
    expect(permittedRemoteCommands(matrix({ questions: true }))).toEqual(["answer_question"]);
    expect(permittedRemoteCommands(matrix({ steering: true }))).toEqual(["send_message"]);
    expect(
      permittedRemoteCommands(
        matrix({ activityStream: true, safeResume: true, structuredEvidence: true }),
      ),
    ).toEqual([]);
  });

  it("keeps command order deterministic when every control is available", () => {
    const commands = permittedRemoteCommands(
      matrix({
        pause: true,
        restrictToReadOnly: true,
        approvals: "native",
        abort: true,
        questions: true,
        steering: true,
      }),
    );
    expect(commands).toEqual([
      "pause",
      "restrict_to_read_only",
      "deny_pending_approval",
      "abort",
      "send_message",
      "answer_question",
      "approve_pending_approval",
    ]);
  });

  it("accounts for every RemoteCommandKind as mapped or explicitly unmapped", () => {
    const protocolCommands = [
      ...REVERSIBLE_BRAKING_COMMANDS,
      ...TERMINAL_COMMANDS,
      ...STEERING_COMMANDS,
      ...BROADENING_COMMANDS,
      "approve_pending_approval",
    ] as const satisfies readonly RemoteCommandKind[];
    const allEnabled = permittedRemoteCommands(
      matrix({
        pause: true,
        restrictToReadOnly: true,
        approvals: "native",
        abort: true,
        questions: true,
        steering: true,
      }),
    );
    const accountedFor = [
      ...allEnabled,
      ...UNMAPPED_COMMANDS.map(({ command }) => command),
    ];
    expect(new Set(accountedFor)).toEqual(new Set(protocolCommands));
    expect(UNMAPPED_COMMANDS).toEqual([]);
  });
});
