/**
 * Client types for device credentials.
 *
 * The shipping database enum is two members (`DeviceClientType`, and the
 * `client_type` column in `device_pairings` / `api_keys`): `'work' | 'code'`,
 * enforced by a DB CHECK constraint, with `NULL` reserved for manually issued
 * developer keys.
 *
 * This is extended **additively** — `'work'` and `'code'` are never renamed or
 * re-meaning — with the device surfaces named by the product: **Web, Desktop,
 * Mobile, Code, Admin**.
 *
 * ### Mapping from `work` / `code`
 *
 * The extended value a record persists *as* is the DB `client_type` it maps to:
 *
 * | Extended `ClientType` | Persisted as (`client_type`) | Meaning |
 * | --- | --- | --- |
 * | `work`   | `work`  | The work app surface (shipping value, unchanged). |
 * | `code`   | `code`  | The CLI / code surface (shipping value, unchanged). |
 * | `web`    | `work`  | The work app running in a browser. |
 * | `desktop`| `work`  | The work app running as a desktop client. |
 * | `mobile` | `work`  | The work app running on a phone / tablet. |
 * | `admin`  | `null`  | The developer console. Not a device credential; `NULL` marks a manually issued key. |
 *
 * `web` / `desktop` / `mobile` are surfaces of the same *work* credential class,
 * so they persist as `'work'`. `admin` is not a device credential at all — it
 * maps to `NULL`, exactly the store's meaning for "manually issued developer
 * key".
 */
export const SHIPPING_CLIENT_TYPES = ["work", "code"] as const;

export type ShippingClientType = (typeof SHIPPING_CLIENT_TYPES)[number];

export const CLIENT_TYPES = ["work", "code", "web", "desktop", "mobile", "admin"] as const;

export type ClientType = (typeof CLIENT_TYPES)[number];

/** Mapping from each extended client type to the DB `client_type` it persists as. */
export const CLIENT_TYPE_TO_DB: Readonly<Record<ClientType, ShippingClientType | null>> = {
  work: "work",
  code: "code",
  web: "work",
  desktop: "work",
  mobile: "work",
  admin: null,
};

export function isClientType(value: unknown): value is ClientType {
  return typeof value === "string" && (CLIENT_TYPES as readonly string[]).includes(value);
}

export function isShippingClientType(value: unknown): value is ShippingClientType {
  return typeof value === "string" && (SHIPPING_CLIENT_TYPES as readonly string[]).includes(value);
}
