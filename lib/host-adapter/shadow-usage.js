"use strict";

// ─── Shadow Usage Adapters (M-025/MS-002) ─────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Public barrel for token usage shadow adapters.
//
// Usage:
//   const shadow = require("./lib/host-adapter/shadow-usage");
//   const piAdapter = shadow.getAdapter("pi-json");
//   const codexAdapter = shadow.getAdapter("codex");

const index = require("./shadow-usage/index.js");
const piJsonShadow = require("./shadow-usage/pi-json-shadow.js");
const codexShadow = require("./shadow-usage/codex-shadow.js");

module.exports = {
  // Framework exports
  ...index,

  // Pi JSON adapter
  PiJsonShadowAdapter: piJsonShadow.PiJsonShadowAdapter,
  createPiJsonShadowAdapter: piJsonShadow.createPiJsonShadowAdapter,
  PI_JSON_HOST_ID: piJsonShadow.HOST_ID,

  // Codex adapter
  CodexShadowAdapter: codexShadow.CodexShadowAdapter,
  createCodexShadowAdapter: codexShadow.createCodexShadowAdapter,
  createClaudeCodeShadowAdapter: codexShadow.createClaudeCodeShadowAdapter,
  CODEX_HOST_ID: codexShadow.HOST_ID_CODEX,
  CLAUDE_CODE_HOST_ID: codexShadow.HOST_ID_CLAUDE_CODE,
};
