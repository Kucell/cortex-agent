"use strict";

// ─── mission-state (shared mission plan state reader) ────────────────────────
//
// The `State:` / `Status:` token a mission plan declares.
//
// This is the OUTER copy of the rule. The governance repository keeps the
// same rule in `.agent/missions/scripts/mission-state.js`, where it is the
// home of the full state-derivation ladder; the two repositories are
// independent, so the rule is vendored here and the drift between them is
// locked by `tests/mission-state-parity.test.js`.
//
// A single reader serves both the archive gate and the mission.json
// derivation, so the two can never disagree about what a plan declares.
//
// Accepted forms:
//   - plain:      `- State: COMPLETE`
//   - bold:       `- **State**: **COMPLETE**`
//   - inline code:`- State: `COMPLETE``
//   - prose:      `- State: MISSION COMPLETE`  (the last token wins)
//
// Tokens may contain digits (`MS_001`).

// The `## Current State` section of a plan, or null when the plan has none.
function readCurrentStateSection(planText) {
  const text = String(planText || "");
  const match = text.match(/^##\s+Current State\s*$([\s\S]*?)(?=^##\s|$(?![\s\S]))/m);
  return match ? match[1] : null;
}

// The state token a plan declares, uppercased. Returns null when the plan
// declares none.
function readStateToken(planText) {
  const section = readCurrentStateSection(planText);
  const scope = section === null ? String(planText || "") : section;
  const match = scope.match(/^[-*]\s*\**\s*(?:State|Status)\b\**\s*[：:]\s*[`*_]*((?:[A-Za-z_][A-Za-z0-9_]*\s*){1,3})/m);
  if (!match) return null;
  const tokens = match[1].trim().toUpperCase().split(/\s+/);
  return tokens[tokens.length - 1];
}

// A terminal state means the mission is done: it may be archived.
function isCompleteState(state) {
  return state === "COMPLETE" || state === "COMPLETED";
}

module.exports = {
  readCurrentStateSection,
  readStateToken,
  isCompleteState,
};
