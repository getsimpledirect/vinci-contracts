import type { RunId } from "@getsimpledirect/vinci-contracts";

import type { ResidencyRecord } from "./residency.ts";

const unknownLocation = { kind: "unknown" } as const;
const knownLocation = { kind: "known", value: { jurisdiction: "CA" } } as const;

const residency = {
  schemaVersion: 1,
  runId: "run-residency-typecheck" as RunId,
  recordedAt: "2026-08-23T12:34:56.789Z",
  recordedBy: { kind: "system", component: "residency-typecheck" },
  accountDataLocation: unknownLocation,
  projectContentLocation: knownLocation,
  inferenceLocation: knownLocation,
  verificationLocation: unknownLocation,
} satisfies ResidencyRecord;

const _residencyWithSwappedLocations = {
  ...residency,
  accountDataLocation: knownLocation,
  projectContentLocation: unknownLocation,
  inferenceLocation: unknownLocation,
  verificationLocation: knownLocation,
} satisfies ResidencyRecord;

const { accountDataLocation: _accountDataLocation, ...withoutAccountDataLocation } = residency;
// @ts-expect-error Account data location is required even when its value is unknown.
const _accountDataLocationRequired: ResidencyRecord = withoutAccountDataLocation;

const { projectContentLocation: _projectContentLocation, ...withoutProjectContentLocation } = residency;
// @ts-expect-error Project content location is required independently of account data location.
const _projectContentLocationRequired: ResidencyRecord = withoutProjectContentLocation;

const { inferenceLocation: _inferenceLocation, ...withoutInferenceLocation } = residency;
// @ts-expect-error Inference location is required independently of verification location.
const _inferenceLocationRequired: ResidencyRecord = withoutInferenceLocation;

const { verificationLocation: _verificationLocation, ...withoutVerificationLocation } = residency;
// @ts-expect-error Verification location is required independently of inference location.
const _verificationLocationRequired: ResidencyRecord = withoutVerificationLocation;

const _residencyWithoutJurisdiction = {
  ...residency,
  // @ts-expect-error A known location requires a jurisdiction even when it has a region.
  inferenceLocation: { kind: "known", value: { region: "ca-central-1" } },
} satisfies ResidencyRecord;
