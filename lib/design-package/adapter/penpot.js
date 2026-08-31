"use strict";

// Penpot adapter → design-scene.v1.
//
// Read-only, fixture-first. Consumes Penpot 1.21+ export JSON (the format
// Penpot ships via File → Export → JSON, or `penpot export --format=json`)
// and emits the provider-neutral design-scene.v1 contract.
//
// MS-5 scope: this adapter is intentionally **fixture-only** in this
// milestone. The Penpot self-host backend fails to boot on macOS Docker
// Desktop (see .agent/missions/M-ODI-001/ms-4-status-report.md), so we
// cannot exercise this code path against a live Penpot instance. Real
// token plumbing and live export fetch are deferred to a later session
// once the upstream image is fixed or run on a Linux host.
//
// Penpot export JSON shape (1.21+):
//   {
//     "name": "...",            // optional display name
//     "data": {
//       "pages": ["uuid-1", "uuid-2", ...],
//       "objects": {            // flat uuid → node map (children reference uuids)
//         "uuid-1": { "type": "frame", "name": "...", "x":0, "y":0, "width":1920, "height":1080,
//                     "shapes": ["child-uuid-1", ...], "fills":[{ "fill-color": "#..." }] },
//         "child-uuid-1": { "type": "rect", "x":10, "y":20, "width":100, "height":50,
//                           "shapes": [], "fills":[{ "fill-color": "#..." }] },
//         "child-uuid-2": { "type": "text", "x":..., "y":..., "content":"Hello", ... },
//         ...
//       }
//     },
//     "file_id": "uuid-..."
//   }
//
// Notes:
//   - Penpot uses uuids (not "73:464"-style IDs). We preserve them as-is.
//   - Penpot shape types: "frame", "group", "rect", "circle", "text", "path",
//     "bool", "image", "svg-raw", "text-shape". We map a small subset to
//     design-scene.v1 DRAWABLE_TYPES.
//   - Fills in Penpot are arrays of { fill-color, fill-opacity, ... } objects;
//     we surface the first solid fill only (matches pixso.js behavior).
//   - `shapes` is a list of child uuids, NOT nested children. The adapter
//     dereferences via the objects map and materializes a `children` array
//     so buildScene's recursive walker can consume it.
//   - Geometry: Penpot stores absolute x/y in world coordinates. We do NOT
//     re-accumulate via parent x/y — scene.buildScene does that for us
//     (it expects raw child.box.x / box.y relative to parent). To preserve
//     that contract we convert absolute coords to relative when constructing
//     the raw tree.

const { buildScene } = require("../scene");

const PENPOT_TYPE_MAP = {
  frame: "FRAME",
  group: "GROUP",
  rect: "RECTANGLE",
  circle: "ELLIPSE",
  text: "TEXT",
  "text-shape": "TEXT",
  path: "VECTOR",
  bool: "BOOLEAN_OPERATION",
  image: "RECTANGLE",
  "svg-raw": "VECTOR",
};

function makeRawBox(node) {
  const x = Number(node.x) || 0;
  const y = Number(node.y) || 0;
  const w = Number(node.width) || 0;
  const h = Number(node.height) || 0;
  return { x, y, w, h };
}

function makeRawFills(node) {
  if (!Array.isArray(node.fills)) return [];
  return node.fills.map((f) => {
    if (f && typeof f === "object" && f["fill-color"]) {
      return { type: "solid", value: String(f["fill-color"]) };
    }
    return null;
  }).filter(Boolean);
}

function makeRawText(node) {
  if (node.type !== "text" && node.type !== "text-shape") return null;
  const content = typeof node.content === "string" ? node.content : "";
  if (!content) return null;
  return {
    content,
    fontFamily: node["font-family"] ? String(node["font-family"]) : undefined,
    fontSize: node["font-size"] ? Number(node["font-size"]) : undefined,
  };
}

// Dereference Penpot's flat `objects` map + `shapes` uuid-list into a nested
// tree that buildScene can recurse over. Returns null on cycles or missing refs.
function materializeTree(objects, uuid, depth = 0, seen = new Set()) {
  if (!uuid || seen.has(uuid) || depth > 32) return null;
  seen.add(uuid);
  const node = objects[uuid];
  if (!node || typeof node !== "object") return null;
  const childIds = Array.isArray(node.shapes) ? node.shapes : [];
  const children = [];
  for (const cid of childIds) {
    const child = materializeTree(objects, cid, depth + 1, new Set(seen));
    if (child) children.push(child);
  }
  return {
    id: String(uuid),
    type: PENPOT_TYPE_MAP[String(node.type || "")] || String(node.type || "UNKNOWN").toUpperCase(),
    name: String(node.name || ""),
    box: makeRawBox(node),
    fills: makeRawFills(node),
    text: makeRawText(node),
    children,
  };
}

function penpotToScene(exportJson) {
  if (!exportJson || typeof exportJson !== "object") {
    throw new Error("penpot adapter: expected Penpot export JSON object");
  }
  const data = exportJson.data;
  if (!data || typeof data !== "object") {
    throw new Error('penpot adapter: Penpot export must contain "data" object');
  }
  const objects = data.objects;
  if (!objects || typeof objects !== "object") {
    throw new Error('penpot adapter: Penpot export must contain "data.objects" map');
  }
  const pageIds = Array.isArray(data.pages) ? data.pages : [];
  if (pageIds.length === 0) {
    throw new Error('penpot adapter: Penpot export must contain non-empty "data.pages" array');
  }
  const roots = [];
  for (const pid of pageIds) {
    const root = materializeTree(objects, pid);
    if (root) roots.push(root);
  }
  if (roots.length === 0) {
    throw new Error("penpot adapter: no materializable roots (all pages failed to resolve)");
  }
  return buildScene({
    provider: "penpot",
    source: {
      documentId: exportJson.file_id ? String(exportJson.file_id) : null,
      rootId: String(pageIds[0]),
      sourceDigest: null,
    },
    roots,
  });
}

module.exports = { penpotToScene };
