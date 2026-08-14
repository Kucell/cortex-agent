"use strict";

// ─── Runtime Layout Logical URI (M-026 MS-001) ─────────────────────────────
//
// Implements P-001 §4 "逻辑路径":
//
//   project://<project-id>/…
//   repo://<repository-id>/<relative-path>
//   workspace://<workspace-id>/<relative-path>
//   agent://<relative-path>
//   runtime://<relative-path>
//   artifact://<task-id>/<artifact-id>
//
// Rules:
//   • '/' is the only separator (even on Windows); the resolver translates
//     to platform separators when binding a URI to a host filesystem path.
//   • Segments use NFC normalisation; reserved characters are
//     percent-encoded on `format` and percent-decoded on `parse`.
//   • Absolute paths (`/Users/...`, `C:\...`, `\\host\...`) are NOT
//     permitted anywhere in a logical URI. VC-002 forbids using resolved
//     absolute paths for equality, dedupe, lease, or fencing.
//   • `..` and `.` segments are refused on parse and on join, except for
//     `agent://` and `runtime://` which accept a single leading `.`.

const {
  URI_SCHEMES,
  URI_SCHEME_LIST,
  URI_PATH_SEGMENT_SAFE,
  PROJECT_ID_SAFE,
  REPOSITORY_ID_SAFE,
  WORKSPACE_ID_SAFE,
  ID_SAFE,
  SCHEME_SAFE,
  CONTROL_CHARS,
  MAX_URI_LEN,
  validateLogicalUri,
} = require("./schemas");

const IDENTITY_PATTERNS = {
  [URI_SCHEMES.project]: PROJECT_ID_SAFE,
  [URI_SCHEMES.repo]: REPOSITORY_ID_SAFE,
  [URI_SCHEMES.workspace]: WORKSPACE_ID_SAFE,
  [URI_SCHEMES.artifact]: ID_SAFE,
};

const ABSOLUTE_PATH_HINT = /^(?:\/(?:Users|home|var|tmp|private|opt|etc)|[A-Za-z]:[\\/]|\\\\[^\\]+\\)/;
const WINDOWS_DRIVE = /^[A-Za-z]:/;

class LogicalUriError extends Error {
  constructor(code, details) {
    super(`LOGICAL_URI_ERROR:${code}`);
    this.name = "LogicalUriError";
    this.code = code;
    this.details = details || {};
  }
}

function assertSafeScheme(scheme) {
  if (typeof scheme !== "string" || !scheme) {
    throw new LogicalUriError("empty_scheme");
  }
  if (!SCHEME_SAFE.test(scheme)) {
    throw new LogicalUriError("unsafe_scheme", { scheme });
  }
  if (!URI_SCHEME_LIST.includes(scheme)) {
    throw new LogicalUriError("unknown_scheme", { scheme, allowed: URI_SCHEME_LIST });
  }
}

// Case policy: schemes are lowercase by RFC 3986. We refuse anything else
// at the parser boundary so consumers cannot smuggle in `Project://…` and
// have it collide with a different vocabulary entry on a case-insensitive
// filesystem.
function assertSchemeCase(scheme) {
  if (scheme !== scheme.toLowerCase()) {
    throw new LogicalUriError("scheme_case_mismatch", { scheme });
  }
}

function assertSafeSegment(segment, scheme, index) {
  if (typeof segment !== "string" || !segment) {
    throw new LogicalUriError("empty_segment", { scheme, index });
  }
  if (CONTROL_CHARS.test(segment)) {
    throw new LogicalUriError("control_chars", { scheme, index });
  }
  if (ABSOLUTE_PATH_HINT.test(segment) || WINDOWS_DRIVE.test(segment)) {
    throw new LogicalUriError("absolute_path_segment", { scheme, index, segment });
  }
  if (segment === "." || segment === "..") {
    throw new LogicalUriError("traversal_segment", { scheme, index, segment });
  }
  if (!URI_PATH_SEGMENT_SAFE.test(segment)) {
    throw new LogicalUriError("unsafe_chars", { scheme, index, segment });
  }
  if (IDENTITY_PATTERNS[scheme] && index === 0 && !IDENTITY_PATTERNS[scheme].test(segment)) {
    throw new LogicalUriError("invalid_identity_segment", { scheme, index, segment });
  }
}

function percentEncode(value) {
  // encodeURIComponent encodes everything except A-Z a-z 0-9 - _ . ! ~ * ' ( ).
  // We additionally encode the three RFC 3986 sub-delims that some JSON
  // consumers treat as control characters: ', (, ). They are individually
  // substituted AFTER encodeURIComponent so we never double-encode an
  // existing percent sequence.
  return encodeURIComponent(value)
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

function percentDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (cause) {
    throw new LogicalUriError("decode_failed", { cause: cause && cause.message });
  }
}

function format(scheme, segments) {
  assertSafeScheme(scheme);
  assertSchemeCase(scheme);
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new LogicalUriError("empty_path", { scheme });
  }
  const encoded = segments.map((segment, index) => {
    assertSafeSegment(segment, scheme, index);
    return percentEncode(segment);
  });
  const out = `${scheme}://${encoded.join("/")}`;
  if (out.length > MAX_URI_LEN) {
    throw new LogicalUriError("uri_too_long", { scheme, length: out.length });
  }
  return out;
}

function parse(input) {
  if (typeof input !== "string" || !input) {
    throw new LogicalUriError("empty");
  }
  if (input.length > MAX_URI_LEN) {
    throw new LogicalUriError("uri_too_long", { length: input.length });
  }
  if (ABSOLUTE_PATH_HINT.test(input)) {
    throw new LogicalUriError("absolute_path", { input });
  }
  const match = /^([a-zA-Z][a-z0-9+.-]*):\/\/(.*)$/i.exec(input);
  if (!match) {
    throw new LogicalUriError("malformed", { input });
  }
  const rawScheme = match[1];
  // Check the case policy first so `PROJECT://...` is reported with a
  // dedicated error code, not a generic "unknown scheme" — the case
  // discipline is part of the proposal vocabulary.
  assertSchemeCase(rawScheme);
  assertSafeScheme(rawScheme);
  const scheme = rawScheme;
  const rawTail = match[2];
  // Reject ANY empty segment (leading, trailing, or doubled slash) at
  // the parser boundary. `split` keeps the empty strings here on purpose
  // so a URI like `runtime://coordination//tasks` cannot silently
  // collapse to `coordination/tasks` and collide with the well-formed
  // `runtime://coordination/tasks` input. We deliberately do NOT
  // canonicalise — every double-slash, leading-slash, and trailing-slash
  // is an authoring error and must fail closed.
  const rawSegments = rawTail.split("/");
  if (rawSegments.some((segment) => segment.length === 0)) {
    throw new LogicalUriError("empty_segment", { scheme });
  }
  if (rawSegments.length === 0) {
    throw new LogicalUriError("empty_path", { scheme });
  }
  const segments = rawSegments.map((segment, index) => {
    const decoded = percentDecode(segment);
    assertSafeSegment(decoded, scheme, index);
    return decoded;
  });
  const record = { scheme, path: segments.join("/") };
  const verdict = validateLogicalUri(record);
  if (!verdict.ok) {
    throw new LogicalUriError("invalid", { scheme, errors: verdict.errors });
  }
  // The returned object carries `kind: "logical_uri"` so the parser
  // output can be handed directly to `resolver.portablePath` (which
  // requires `kind === "logical_uri"`). This unifies the public-API
  // shape: every parser output satisfies the same discriminator that
  // other resolver helpers expect, and consumers do not need a separate
  // shape to bridge parser → resolver.
  return Object.freeze({
    kind: "logical_uri",
    scheme,
    path: Object.freeze(segments.join("/")),
    segments: Object.freeze(segments.slice()),
    toString() { return input; },
    [Symbol.toPrimitive]() { return input; },
  });
}

// Helpers for the most common cases; these keep call sites readable while
// the underlying machinery stays in `format`/`parse`.

function project(projectId, ...rest) {
  return format(URI_SCHEMES.project, [projectId, ...rest]);
}

function repo(repositoryId, ...rest) {
  return format(URI_SCHEMES.repo, [repositoryId, ...rest]);
}

function workspace(workspaceId, ...rest) {
  return format(URI_SCHEMES.workspace, [workspaceId, ...rest]);
}

function agent(...segments) {
  return format(URI_SCHEMES.agent, segments);
}

function runtime(...segments) {
  return format(URI_SCHEMES.runtime, segments);
}

function artifact(taskId, artifactId, ...rest) {
  return format(URI_SCHEMES.artifact, [taskId, artifactId, ...rest]);
}

module.exports = {
  LogicalUriError,
  URI_SCHEMES,
  URI_SCHEME_LIST,
  format,
  parse,
  project,
  repo,
  workspace,
  agent,
  runtime,
  artifact,
};