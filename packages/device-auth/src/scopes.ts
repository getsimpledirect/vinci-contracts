/**
 * Scopes a credential may request.
 *
 * Mirrors `Scope` from `app/api/keys/route.ts`: `inference`, `models`, `usage`
 * and `acceptance`.
 *
 * **Device tokens may NOT hold `acceptance`.** The `acceptance` scope grants the
 * ability to pass or fail verification work, and a device token must never be
 * able to certify the very work it produced (FR-6.4 / §8.1: the worker cannot
 * issue its own verdict). This is enforced here in two ways, not left as a
 * comment:
 *
 *  - at the **type level**, `DeviceScope` has no `acceptance` member and
 *    `DeviceCredential.scopes` is `readonly DeviceScope[]`, so a device
 *    credential literally cannot be constructed holding it;
 *  - at **runtime**, `validateDeviceCredential` fails closed if an
 *    `acceptance` scope is present.
 */
export const SCOPES = ["inference", "models", "usage", "acceptance"] as const;

export type Scope = (typeof SCOPES)[number];

/** Scopes a device credential may hold. `acceptance` is deliberately absent. */
export const DEVICE_SCOPES = ["inference", "models", "usage"] as const;

export type DeviceScope = (typeof DEVICE_SCOPES)[number];

/** `'acceptance'` may never appear on a device token. */
export type AcceptanceScope = Extract<Scope, "acceptance">;

export function isScope(value: unknown): value is Scope {
  return typeof value === "string" && (SCOPES as readonly string[]).includes(value);
}

export function isDeviceScope(value: unknown): value is DeviceScope {
  return typeof value === "string" && (DEVICE_SCOPES as readonly string[]).includes(value);
}
