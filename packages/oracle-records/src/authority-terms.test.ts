import { describe, expect, it } from "vitest";
import { AUTHORITY_TERMS, forbiddenTermIn } from "./lib/validate.ts";
import { validateAttestedEnvelope, validateResearchRequest, validateDecisionProposal } from "./index.ts";
import { validDecisionProposal, validResearchRequest } from "./fixtures.test-helpers.ts";

/**
 * CON-03: which layer actually refuses an authority field in a model payload.
 *
 * This file exists because a review established that the answer was not the one
 * the comments gave. `validateAttestedEnvelope`'s deep walk was documented as
 * refusing "an authority-bearing key by name, at any depth". It refuses a key
 * containing one of FOURTEEN WORD STEMS, and twenty-one authority-bearing names
 * pass it — `authorizedBy` among them, because "authorized" does not contain
 * "authority".
 *
 * The finding did not amount to an exploitable hole, and the reason is worth
 * pinning rather than remembering: every record in this package declares a
 * closed payload allowlist that runs at every depth, so an undeclared key is
 * refused whatever it is called. That is the defence. The stem walk is a naming
 * net over the common spellings whose value is its distinct issue code.
 *
 * Both halves are asserted here, in both directions, so the day someone adds a
 * free-form payload subtree — a map, a passthrough object, anything the
 * allowlist stops covering — the missing defence is visible as a failing test
 * rather than as a comment that used to be true.
 */

/**
 * Authority-bearing key names the stem list does NOT match.
 *
 * Kept as data rather than prose because the point is the size of the gap. This
 * is the reviewer's list, verbatim.
 */
const UNMATCHED_AUTHORITY_NAMES = [
  "authorizedBy",
  "authorization",
  "authorizedToExecute",
  "approvalRef",
  "approvedBy",
  "entitlements",
  "privileges",
  "capabilities",
  "roleAssignment",
  "identityRef",
  "scopeOverride",
  "clearance",
  "canMerge",
  "signedBy",
  "certificate",
  "sudo",
  "runAs",
  "costUsd",
  "sourceIds",
  "artifactSha256",
  "toolObservation",
];

/** Names the stem list DOES match, so the net is not empty. */
const MATCHED_AUTHORITY_NAMES = [
  "policyRef",
  "grantRefs",
  "budgetMicrousd",
  "contextManifestDigest",
  "principal",
  "workspaceRef",
  "attestedBy",
  "credentialRef",
];

describe("the stem walk is a net over spellings, not a definition of authority", () => {
  it("names it does NOT match, stated as a measured number rather than a claim", () => {
    const unmatched = UNMATCHED_AUTHORITY_NAMES.filter(
      (name) => forbiddenTermIn(name, AUTHORITY_TERMS) === null,
    );
    // Every one of them. If a future edit adds stems, this fails and the
    // comment describing the mechanism has to be revisited with it — which is
    // the point: the number is documentation that cannot go stale silently.
    expect(unmatched).toEqual(UNMATCHED_AUTHORITY_NAMES);
    expect(unmatched.length).toBe(21);
  });

  it("NON-VACUITY CONTROL: the names it does match", () => {
    // Without this, "the stem list misses things" would also be satisfied by a
    // stem list that matched nothing at all.
    for (const name of MATCHED_AUTHORITY_NAMES) {
      expect(forbiddenTermIn(name, AUTHORITY_TERMS), name).not.toBeNull();
    }
  });
});

describe("the payload allowlist is what refuses them, and it refuses all of them", () => {
  it("the envelope walk alone does NOT refuse payload.completion.authorizedBy", () => {
    // The exact case the corrected comments name. `validateAttestedEnvelope`
    // leaves both record-specific halves opaque, so this is the stem walk on
    // its own, with no record allowlist in front of it.
    const base = validResearchRequest();
    const smuggled = {
      ...base,
      payload: {
        ...base.payload,
        completion: { ...base.payload.completion, authorizedBy: "release-captain" },
      },
    };
    const envelope = validateAttestedEnvelope(smuggled);
    expect(envelope.ok, "the stem walk did not fire, which is the finding").toBe(true);
  });

  it("but the RECORD's validator refuses it, by path, at that depth", () => {
    const base = validResearchRequest();
    const smuggled = {
      ...base,
      payload: {
        ...base.payload,
        completion: { ...base.payload.completion, authorizedBy: "release-captain" },
      },
    };
    const result = validateResearchRequest(smuggled);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => ({ path: i.path, code: i.code }))).toEqual([
      { path: "/payload/completion/authorizedBy", code: "unknown_field" },
    ]);
  });

  it("SWEEP: every one of the twenty-one is refused by the allowlist, at every depth tried", () => {
    // The population, not the one example. Two records, three depths each: the
    // payload root, a nested object, and a nested object one level further in.
    const request = validResearchRequest();
    const proposal = validDecisionProposal();
    for (const name of UNMATCHED_AUTHORITY_NAMES) {
      const atRoot = validateResearchRequest({
        ...request,
        payload: { ...request.payload, [name]: "x" },
      });
      expect(atRoot.ok, `${name} at /payload`).toBe(false);
      if (!atRoot.ok) {
        expect(atRoot.issues.map((i) => i.path), name).toEqual([`/payload/${name}`]);
      }

      const nested = validateResearchRequest({
        ...request,
        payload: {
          ...request.payload,
          completion: { ...request.payload.completion, [name]: "x" },
        },
      });
      expect(nested.ok, `${name} at /payload/completion`).toBe(false);

      const deeper = validateDecisionProposal({
        ...proposal,
        payload: { ...proposal.payload, target: { ...proposal.payload.target, [name]: "x" } },
      });
      expect(deeper.ok, `${name} at /payload/target`).toBe(false);
    }
  });

  it("POSITIVE REACHABILITY CONTROL: the same records without the extra key still validate", () => {
    // Without this the sweep above would be satisfied by validators that refuse
    // everything, and the whole file would be measuring nothing.
    expect(validateResearchRequest(validResearchRequest()).ok).toBe(true);
    expect(validateDecisionProposal(validDecisionProposal()).ok).toBe(true);
  });

  it("and the stem walk still fires, with its own code, on the spellings it does cover", () => {
    // The net's actual value: a caller learns WHICH rule refused, rather than
    // "unknown field". Both mechanisms are live; they are not alternatives.
    const base = validDecisionProposal();
    const result = validateDecisionProposal({
      ...base,
      payload: { ...base.payload, target: { ...base.payload.target, grantRef: "grant-1" } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => ({ path: i.path, code: i.code }))).toEqual([
      { path: "/payload/target/grantRef", code: "authority_field_in_model_payload" },
    ]);
  });
});
