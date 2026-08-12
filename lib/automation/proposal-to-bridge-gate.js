"use strict";

// ─── Bridge Sync Gate Deriver (P-006 Capability E helper) ────────────────────
//
// Consumed by proposal-to-mission.js (Capability B) and mission-completion-hook.js
// (Capability D). Inspects a proposal's frontmatter for cross-project bridge
// descriptors and synthesises a `bridge_sync` gate that the validation contract
// can later invoke.
//
// The gate spec follows the validation-contract.json schema (P-006 §3.3
// Capability E):
//
//   {
//     id: "bridge_sync_<id>",
//     type: "bridge_sync",
//     sources: ["peer-a", "peer-b"],
//     event_types: ["task.state_changed", "decision.resolved"],
//     correlation_groups: ["hmi-collab", "agentic-ui-delivery"],
//     expected_min_events: <n>,
//     query: { type: "inbox", … }
//   }
//
// Source: P-006 §3.5 Capability E.

function deriveBridgeSyncGate(frontmatter) {
  if (!frontmatter || typeof frontmatter !== "object") return null;
  const peersRaw = frontmatter.cross_project_peers || frontmatter.peers || null;
  if (!Array.isArray(peersRaw) || peersRaw.length === 0) return null;
  const sources = [];
  const correlationGroups = [];
  const eventTypes = new Set();
  let expectedMin = 0;
  for (const peer of peersRaw) {
    const projectId = typeof peer === "string" ? peer : peer.project_id || peer.source_project_id;
    if (!projectId) continue;
    sources.push(projectId);
    if (typeof peer === "object") {
      if (peer.correlation_group) correlationGroups.push(peer.correlation_group);
      if (Array.isArray(peer.event_types)) peer.event_types.forEach((t) => eventTypes.add(t));
      if (typeof peer.expected_min_events === "number") expectedMin += peer.expected_min_events;
    }
  }
  if (sources.length === 0) return null;
  return {
    id: "bridge_sync_auto",
    type: "bridge_sync",
    sources: Array.from(new Set(sources)),
    event_types: Array.from(eventTypes),
    correlation_groups: Array.from(new Set(correlationGroups)),
    expected_min_events: expectedMin,
    query: { type: "inbox" },
  };
}

module.exports = { deriveBridgeSyncGate };
