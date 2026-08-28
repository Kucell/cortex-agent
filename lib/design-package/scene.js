"use strict";

// design-scene.v1 — provider-neutral scene contract for cortex-agent.
//
// Goals:
//   - No dependency on Pixso / Penpot / Figma private DSLs.
//   - Stable flat node list with accumulated global geometry.
//   - Honest coverage: known nodes, omitted subtrees, unsupported types.
//
// Functions are pure; callers own I/O.

const SCHEMA_VERSION = "design-scene.v1";

const DRAWABLE_TYPES = new Set(["FRAME", "RECTANGLE", "ELLIPSE", "TEXT", "LINE"]);
const STRUCTURAL_TYPES = new Set(["GROUP", "COMPONENT", "COMPONENT_SET", "INSTANCE"]);
const UNSUPPORTED_TYPES = new Set(["VECTOR", "VECTOR_NETWORK", "STICKY", "SHAPE_WITH_TEXT", "REGULAR_POLYGON", "STAR", "BOOLEAN_OPERATION"]);

function num(value) {
  const v = Number(value);
  return Number.isFinite(v) ? v : 0;
}

function solidFill(node) {
  if (!node || !Array.isArray(node.fills)) return "transparent";
  const fill = node.fills.find((f) => f && f.type === "solid" && f.value);
  return fill ? String(fill.value) : "transparent";
}

function nodeText(node) {
  if (!node || !node.text || typeof node.text.content !== "string") return "";
  return node.text.content;
}

function makeId(rawId) {
  return String(rawId || "");
}

// Convert a provider-specific node into a design-scene.v1 node entry.
// `parent` is the previous scene node (or null); the child's geometry is
// accumulated from `parent.x/parent.y + node.box.x/node.box.y`.
function toSceneNode(rawNode, parent, depth) {
  const box = rawNode.box || {};
  const x = (parent ? parent.x : 0) + num(box.x);
  const y = (parent ? parent.y : 0) + num(box.y);
  const w = num(box.w);
  const h = num(box.h);
  const type = String(rawNode.type || "UNKNOWN");
  const renderable = DRAWABLE_TYPES.has(type) && !!rawNode.box;
  const visible = rawNode.visible !== false;
  const style = { fill: solidFill(rawNode), radius: num(rawNode.radius) };
  return {
    id: makeId(rawNode.id),
    parentId: parent ? parent.id : null,
    name: String(rawNode.name || type || "Untitled"),
    type,
    depth,
    x, y, w, h,
    visible,
    style,
    content: {
      text: nodeText(rawNode),
      fontFamily: rawNode.text && rawNode.text.fontFamily ? String(rawNode.text.fontFamily) : "Noto Sans SC",
      fontSize: num(rawNode.text && rawNode.text.fontSize) || 14,
    },
    renderable,
  };
}

// Build a design-scene.v1 from a provider-raw tree.
// `rawRoots` is expected to be the `roots[]` array of the provider DSL.
function buildScene(providerInput) {
  const provider = providerInput && providerInput.provider ? String(providerInput.provider) : "unknown";
  const source = providerInput && providerInput.source ? providerInput.source : {};
  const roots = providerInput && Array.isArray(providerInput.roots) ? providerInput.roots : [];
  const nodes = [];
  let omittedSubtrees = 0;
  const unsupported = new Set();
  const drawable = [];
  const textContents = [];

  function visit(rawNode, parent, depth) {
    if (!rawNode || typeof rawNode !== "object") return;
    const sceneNode = toSceneNode(rawNode, parent, depth);
    nodes.push(sceneNode);
    if (sceneNode.renderable && sceneNode.visible) drawable.push(sceneNode);
    if (sceneNode.content.text) textContents.push(sceneNode.content.text);
    if (UNSUPPORTED_TYPES.has(sceneNode.type)) unsupported.add(sceneNode.type);
    if (rawNode.childrenSummary && Number(rawNode.childrenSummary.omitted)) {
      omittedSubtrees += Number(rawNode.childrenSummary.omitted);
    }
    for (const child of rawNode.children || []) visit(child, sceneNode, depth + 1);
  }

  for (const root of roots) visit(root, null, 0);

  const root = nodes[0] || null;
  const canvas = {
    width: root ? root.w : 0,
    height: root ? root.h : 0,
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    source: {
      provider,
      documentId: source.documentId || null,
      rootId: source.rootId || (root ? root.id : null),
      sourceDigest: source.sourceDigest || null,
    },
    canvas,
    nodes,
    components: [],
    tokens: [],
    assets: [],
    coverage: {
      knownNodes: nodes.length,
      drawableNodes: drawable.length,
      textNodes: textContents.length,
      omittedSubtrees,
      unsupportedTypes: [...unsupported].sort(),
      rendering: "known-node-layout",
    },
  };
}

function findNode(scene, id) {
  if (!scene || !id) return null;
  return scene.nodes.find((n) => n.id === id) || null;
}

function selectPage(scene, id) {
  const page = findNode(scene, id);
  if (!page) throw new Error(`design-package: --page-id not found in scene: ${id}`);
  if (page.w !== 1920 || page.h !== 1080) {
    throw new Error(`design-package: --page-id must identify a 1920×1080 node: ${id} is ${page.w}×${page.h}`);
  }
  return page;
}

module.exports = {
  SCHEMA_VERSION,
  buildScene,
  findNode,
  selectPage,
};
