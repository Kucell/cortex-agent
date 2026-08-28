"use strict";

// Pixso adapter → design-scene.v1.
//
// Read-only: takes Pixso compact DSL (the object returned by
// get_node_dsl({ simplify: true })) and emits the provider-neutral scene
// contract. Does NOT depend on any other cortex-agent module.

const { buildScene } = require("../scene");

// `pixsoDsl` shape:
//   {
//     stats: { source: { variableMap, variableSetMap, localStyleMap }, outputBytes },
//     roots: [ { id, type, name, box, fills, children, text, ... }, ... ],
//     refsIndex: { ... }
//   }
function pixsoToScene(pixsoDsl) {
  if (!pixsoDsl || typeof pixsoDsl !== "object") {
    throw new Error("pixso adapter: expected Pixso DSL object");
  }
  const roots = Array.isArray(pixsoDsl.roots) ? pixsoDsl.roots : [];
  if (roots.length === 0) {
    throw new Error('pixso adapter: Pixso DSL must contain a non-empty "roots" array');
  }
  return buildScene({
    provider: "pixso",
    source: {
      documentId: pixsoDsl.documentId || null,
      rootId: roots[0].id || null,
      sourceDigest: null,
    },
    roots,
  });
}

module.exports = { pixsoToScene };
