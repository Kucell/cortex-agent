"use strict";

// ─── registry — 4-kind catalog index (P-001 MS-002) ───────────────────────────
//
// Aggregates 4 kinds into a single catalog surface. For design-system, this
// delegates to the existing lib/design/registry (T-OD-001 frozen). For
// plugin / skill / template, this is a thin starter-index over hard-coded
// starter ids — the upstream enumeration is gated by lib/catalog/fetch.js
// (MS-002 follow-up). All entries carry a `kind` discriminator.
//
// No npm deps. All file I/O via node:fs; HTTP via the injected `fetcher`
// (default: lib/design/registry's httpsGetJson).

const fs = require("node:fs");
const path = require("node:path");

const { KINDS, KIND_LIST, getStarterIds, getKind, hasKind } = require("./kind-map");
const { STARTER_IDS } = require("./kind-map");

// T-OD-001 frozen registry — we reuse it for design-system.
const designRegistry = require("../design/registry");

const DEFAULT_UPSTREAM = "https://raw.githubusercontent.com/nexu-io/open-design/main";

/**
 * Build a 4-kind index from (a) the design-system catalog and (b) starter
 * ids for the other 3 kinds. When `fetchCatalog` is supplied, it overrides
 * the design-system branch.
 *
 * @param {{ fetcher?: Function, now?: Function, upstream?: string, fetchCatalog?: Promise }} [opts]
 * @returns {{ kinds: Record<string, { entries: Array, source: string }>, fetched_at: string, upstream: string }}
 */
function loadAllKinds(opts) {
  opts = opts || {};
  const upstream = opts.upstream || DEFAULT_UPSTREAM;
  const now = (opts.now || (() => new Date().toISOString()))();

  const kinds = {};
  for (const kind of KIND_LIST) {
    kinds[kind] = { entries: [], source: "starter" };
  }

  // design-system: pull from T-OD-001 registry (with injected fetcher for tests).
  if (opts.fetchCatalog) {
    kinds["design-system"] = {
      entries: opts.fetchCatalog.then
        ? null
        : null, // sync fallback below
      source: "upstream",
    };
  } else {
    // Sync path: leverage cached entries if present (loadCatalog is async;
    // we accept starter-only when no cache available). Cache entries are
    // upstream-shaped (no `kind` field) — we inject it.
    try {
      const cache = designRegistry.readCacheRaw();
      if (cache && Array.isArray(cache.entries) && cache.entries.length > 0) {
        kinds["design-system"] = {
          entries: cache.entries.map((e) => ({ ...e, kind: "design-system" })),
          source: "cache",
        };
      }
    } catch (_) {
      // No cache yet — fall through to starter.
    }
    if (kinds["design-system"].entries.length === 0) {
      kinds["design-system"] = {
        entries: getStarterIds("design-system").map((id) => ({
          id,
          kind: "design-system",
          source: "starter",
        })),
        source: "starter",
      };
    }
  }

  // plugin / skill / template: starter indices for now (real upstream
  // enumeration is gated by lib/catalog/fetch.js in a follow-up sprint).
  for (const kind of ["plugin", "skill", "template"]) {
    kinds[kind] = {
      entries: getStarterIds(kind).map((id) => ({
        id,
        kind,
        source: "starter",
      })),
      source: "starter",
    };
  }

  return { kinds, fetched_at: now, upstream };
}

/**
 * Async variant that awaits upstream fetch for design-system.
 * Other 3 kinds remain starter-indexed.
 *
 * @param {{ fetcher?: Function, now?: Function, upstream?: string }} [opts]
 */
async function loadAllKindsAsync(opts) {
  opts = opts || {};
  const upstream = opts.upstream || DEFAULT_UPSTREAM;
  // Pass `now` as a FUNCTION (lib/design/registry.loadCatalog calls
  // `new Date(now()).toISOString()` internally). Default to Date.now.
  const now = opts.now || Date.now;
  const fetcher = opts.fetcher || designRegistry.httpsGetJson;

  const kinds = {};
  for (const kind of KIND_LIST) {
    kinds[kind] = { entries: [], source: "starter" };
  }

  // design-system: delegate to lib/design/registry (T-OD-001). Inject `kind`
  // on each entry since upstream entries don't carry it. Forward
  // cachePath + forceRefresh for testability (cachePath must point at a
  // tmp path in tests to bypass the user's real ~/.agent cache).
  try {
    const dsEntries = await loadDesignSystemEntries({
      fetcher,
      now,
      upstream,
      cachePath: opts.cachePath,
      forceRefresh: opts.forceRefresh,
    });
    if (dsEntries && dsEntries.length > 0) {
      kinds["design-system"] = {
        entries: dsEntries.map((e) => ({ ...e, kind: "design-system" })),
        source: "upstream",
      };
    } else {
      // Empty upstream response — fall through to starter fallback.
      kinds["design-system"] = {
        entries: getStarterIds("design-system").map((id) => ({ id, kind: "design-system", source: "starter" })),
        source: "starter",
      };
    }
  } catch (_err) {
    // Fallback to cache or starter — same as loadAllKinds sync path.
    try {
      const cache = designRegistry.readCacheRaw();
      if (cache && Array.isArray(cache.entries) && cache.entries.length > 0) {
        kinds["design-system"] = {
          entries: cache.entries.map((e) => ({ ...e, kind: "design-system" })),
          source: "cache",
        };
      } else {
        kinds["design-system"] = {
          entries: getStarterIds("design-system").map((id) => ({ id, kind: "design-system", source: "starter" })),
          source: "starter",
        };
      }
    } catch (_) {
      kinds["design-system"] = {
        entries: getStarterIds("design-system").map((id) => ({ id, kind: "design-system", source: "starter" })),
        source: "starter",
      };
    }
  }

  // plugin / skill / template: starter indices
  for (const kind of ["plugin", "skill", "template"]) {
    kinds[kind] = {
      entries: getStarterIds(kind).map((id) => ({ id, kind, source: "starter" })),
      source: "starter",
    };
  }

  return { kinds, fetched_at: now, upstream };
}

async function loadDesignSystemEntries(opts) {
  const fetcher = opts.fetcher || designRegistry.httpsGetJson;
  const upstream = opts.upstream || DEFAULT_UPSTREAM;
  // lib/design/registry.loadCatalog returns the entries ARRAY directly
  // (not a wrapped object). Pass through fetcher + cachePath for testability.
  return designRegistry.loadCatalog({
    upstream,
    fetcher,
    now: opts.now,
    cachePath: opts.cachePath,
    forceRefresh: opts.forceRefresh,
  }).then((entries) => entries || []);
}

/**
 * Find a single entry across all 4 kinds by id (id is unique per kind, not
 * globally — so we return all matches).
 */
function findById(index, id) {
  if (!index || !index.kinds) return [];
  const matches = [];
  for (const kind of KIND_LIST) {
    const list = index.kinds[kind]?.entries || [];
    for (const e of list) {
      if (e.id === id) matches.push({ ...e, kind });
    }
  }
  return matches;
}

/**
 * Filter to a single kind.
 */
function listKind(index, kind) {
  if (!hasKind(kind)) {
    throw new Error(`registry.listKind: unknown kind "${kind}"`);
  }
  return (index.kinds[kind]?.entries || []).slice();
}

/**
 * Stable hash of the index for change detection. Avoids deep equality on
 * large lists.
 */
function indexDigest(index) {
  if (!index || !index.kinds) return "";
  const parts = [];
  for (const kind of KIND_LIST) {
    const ids = (index.kinds[kind]?.entries || []).map((e) => e.id).sort();
    parts.push(`${kind}:${ids.join(",")}`);
  }
  return parts.join("|");
}

module.exports = {
  loadAllKinds,
  loadAllKindsAsync,
  findById,
  listKind,
  indexDigest,
  DEFAULT_UPSTREAM,
  KIND_LIST,
  // exposed for tests
  _internal: { loadDesignSystemEntries },
};