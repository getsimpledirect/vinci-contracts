/**
 * The `path:` grant token — WRITE SCOPE, stated positively.
 *
 * A work order that grants `repo:` and `branch:` says where a run may land
 * commits; it says nothing about which files those commits may touch. Until
 * this token existed every pinned order had ROOT scope by omission (the
 * vinci-gpu-control #197 review, BLOCK-1), which is exactly the kind of
 * authority the positive-list rule exists to make impossible to hold by
 * accident. So:
 *
 *   path:<root>      <root> is a relative, normalised path inside the
 *                    repository. A trailing "/" grants the directory and
 *                    everything under it; otherwise the token grants ONE file.
 *
 * FAIL CLOSED: no `path:` grant means no write scope. There is no token that
 * spells the repository root — `path:.`, `path:/`, and `path:` are all
 * refused — so root scope cannot be granted at all, only enumerated. An order
 * without a path grant is an order whose worker may write nothing, and the
 * Governor refuses a write claim that no grant covers.
 *
 * <root> is refused, with a typed reason, when it
 *   - is empty                                     (empty)
 *   - begins with "/" (absolute)                   (absolute)
 *   - is "." alone, i.e. names the root            (root_scope)
 *   - has a "." segment ("./a", "a/./b")           (dot_segment)
 *   - has a ".." segment ("a/../b", "../a")        (dotdot_segment)
 *   - has an empty segment ("a//b")                (empty_segment)
 *   - contains a backslash                         (backslash)
 *   - contains a NUL                               (nul)
 *   - is longer than MAX_PATH_ROOT_LENGTH Unicode
 *     code points                                  (too_long)
 *
 * The grammar is deliberately not a normaliser: "a/../b" is refused, not
 * rewritten to "b". A grant that has to be cleaned before it can be read is a
 * grant two implementations can clean differently, and this grammar is
 * mirrored byte for byte by the vendored Python in vinci-gpu-control.
 */

export const PATH_GRANT_PREFIX = "path:" as const;
export const MAX_PATH_ROOT_LENGTH = 1024;

export const PATH_ROOT_REFUSALS = [
  "empty", "absolute", "root_scope", "dot_segment", "dotdot_segment",
  "empty_segment", "backslash", "nul", "too_long",
  "wildcard", "control_char", "bidi_control", "edge_space",
] as const;

/**
 * Characters refused by EXPLICIT CODE POINT rather than by a library predicate.
 *
 * This grammar is mirrored byte for byte by vendored Python, and `trim()` and
 * `str.strip()` do NOT agree on what counts as whitespace. Calling either one
 * would make the two implementations disagree about a grant's validity in
 * exactly the silent way path-grant-cases.json exists to prevent. So the sets
 * are enumerated, and both sides can implement the same list.
 */
const EDGE_SPACES = new Set([
  "\u0020", // SPACE
  "\u0009", // TAB
  "\u00a0", // NO-BREAK SPACE   -- renders as a space
  "\u200b", // ZERO WIDTH SPACE -- renders as nothing
]);

/** Bidi overrides/isolates: they reorder how the REST of the root displays. */
const BIDI_CONTROLS = new Set([
  "\u202a", "\u202b", "\u202c", "\u202d", "\u202e",
  "\u2066", "\u2067", "\u2068", "\u2069",
]);
export type PathRootRefusal = (typeof PATH_ROOT_REFUSALS)[number];

export type PathRoot = {
  /** The root exactly as granted, trailing "/" included when it is a directory. */
  readonly root: string;
  /** "directory": the root and everything under it. "file": that one file. */
  readonly kind: "directory" | "file";
};

export type PathRootParse =
  | { readonly ok: true; readonly value: PathRoot }
  | { readonly ok: false; readonly reason: PathRootRefusal };

/** Parse the `<root>` part of a `path:` grant. Never throws; never normalises. */
export function parsePathRoot(root: unknown): PathRootParse {
  if (typeof root !== "string" || root.length === 0) return { ok: false, reason: "empty" };
  // JavaScript String.length counts UTF-16 code units while Python len()
  // counts Unicode code points. This grammar is mirrored in Python, so count
  // code points explicitly and stop as soon as the limit is exceeded.
  let codePointLength = 0;
  for (const _character of root) {
    codePointLength += 1;
    if (codePointLength > MAX_PATH_ROOT_LENGTH) return { ok: false, reason: "too_long" };
  }
  if (root.includes("\0")) return { ok: false, reason: "nul" };
  if (root.includes("\\")) return { ok: false, reason: "backslash" };
  if (root.startsWith("/")) return { ok: false, reason: "absolute" };
  if (root === ".") return { ok: false, reason: "root_scope" };

  // A grant is READ AND APPROVED BY A PERSON -- a work order carries an
  // attentionBudget and a requester -- so a root that does not look like what
  // it is defeats the point of stating authority positively. These refusals
  // only ever narrow what a grant can say.
  for (const character of root) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return { ok: false, reason: "control_char" };
    if (BIDI_CONTROLS.has(character)) return { ok: false, reason: "bidi_control" };
  }

  // `*` is a wildcard in the branch: grammar and would be a LITERAL filename
  // here. One token, two meanings, in one grant vocabulary: an author who
  // writes path:src/* means "everything under src" and would otherwise get a
  // valid grant for one file that almost certainly does not exist, failing far
  // away as path_not_granted. Refused so the mistake is named where it is made.
  if (root.includes("*")) return { ok: false, reason: "wildcard" };

  const directory = root.endsWith("/");
  const segments = (directory ? root.slice(0, -1) : root).split("/");
  for (const segment of segments) {
    if (segment === "") return { ok: false, reason: "empty_segment" };
    if (segment === ".") return { ok: false, reason: "dot_segment" };
    if (segment === "..") return { ok: false, reason: "dotdot_segment" };
    const first = [...segment][0] as string;
    const last = [...segment][[...segment].length - 1] as string;
    if (EDGE_SPACES.has(first) || EDGE_SPACES.has(last)) {
      return { ok: false, reason: "edge_space" };
    }
  }
  return { ok: true, value: { root, kind: directory ? "directory" : "file" } };
}

/**
 * Parse a whole grant token. `null` when the token is not a `path:` grant at
 * all (so the caller can leave prose and the other prefixes alone); otherwise
 * the parse of everything after the prefix.
 */
export function parsePathGrant(grant: unknown): PathRootParse | null {
  if (typeof grant !== "string" || !grant.startsWith(PATH_GRANT_PREFIX)) return null;
  return parsePathRoot(grant.slice(PATH_GRANT_PREFIX.length));
}

/** A grant-side refusal reason, worded for the issue it produces. */
export function describePathRootRefusal(reason: PathRootRefusal): string {
  switch (reason) {
    case "empty": return "a path root is non-empty";
    case "absolute": return "a path root is relative to the repository; no leading \"/\"";
    case "root_scope": return "\".\" would grant the whole repository; root scope is not expressible, enumerate the roots instead";
    case "dot_segment": return "a path root is normalised; no \".\" segment";
    case "dotdot_segment": return "a path root is normalised and inside the repository; no \"..\" segment";
    case "empty_segment": return "a path root is normalised; no empty segment (\"//\")";
    case "backslash": return "a path root uses \"/\" only; no backslash";
    case "nul": return "a path root contains no NUL";
    case "too_long": return `a path root is at most ${MAX_PATH_ROOT_LENGTH} Unicode code points`;
    case "wildcard": return "\"*\" is a wildcard in branch: but would be a literal filename here; grant a directory with a trailing \"/\", e.g. path:src/";
    case "control_char": return "a path root contains no control characters";
    case "bidi_control": return "a path root contains no bidirectional override characters; they reorder how the rest of the root displays to the person approving it";
    case "edge_space": return "a path root segment neither begins nor ends with a space, tab, no-break space, or zero-width space";
  }
}

/**
 * Does the grant `parent` admit the grant `child`? Both are ALREADY-PARSED
 * roots. A directory grant covers itself and anything nested under it (the
 * trailing "/" is part of the prefix, so "src/" does not cover "srcx/"); a
 * file grant covers exactly that file and nothing else — not a directory of
 * the same name, and never anything under it.
 */
export function pathRootCovers(parent: PathRoot, child: PathRoot): boolean {
  // An authority guard: it answers false, never true and never a throw, for
  // anything that is not a parsed root. A hand-built { root: "", kind:
  // "directory" } would otherwise cover everything through startsWith("").
  const p = reparse(parent);
  const c = reparse(child);
  if (p === null || c === null) return false;
  if (p.kind === "file") return c.kind === "file" && c.root === p.root;
  return c.root === p.root || c.root.startsWith(p.root);
}

function reparse(value: unknown): PathRoot | null {
  try {
    if (typeof value !== "object" || value === null) return null;
    const { root, kind } = value as { root?: unknown; kind?: unknown };
    const parsed = parsePathRoot(root);
    return parsed.ok && parsed.value.kind === kind ? parsed.value : null;
  } catch {
    return null;
  }
}
