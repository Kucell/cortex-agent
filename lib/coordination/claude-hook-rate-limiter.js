"use strict";

// ─── Claude Hook Rate Limiter (T-ACN-017) ───────────────────────────────────
// Rate limiting and progress merging for PostToolUse hooks.
// Separated from the adapter per project standards.
//
// Zero external dependencies — Node.js built-ins only.

const DEFAULT_RATE_LIMIT_MS = 5000;

// ─── Rate limiter ───────────────────────────────────────────────────────────
//
// Creates a rate limiter for PostToolUse hooks. Tracks the last emission time
// per tool name and returns true if the hook should be emitted.

function createRateLimiter(windowMs = DEFAULT_RATE_LIMIT_MS) {
  const lastEmitted = new Map();

  function shouldEmit(toolName, now = Date.now()) {
    if (!toolName) return true;
    const last = lastEmitted.get(toolName) || 0;
    if (now - last >= windowMs) {
      lastEmitted.set(toolName, now);
      return true;
    }
    return false;
  }

  function reset(toolName) {
    if (toolName) {
      lastEmitted.delete(toolName);
    } else {
      lastEmitted.clear();
    }
  }

  return Object.freeze({
    shouldEmit,
    reset,
    windowMs,
  });
}

// ─── Progress merger ────────────────────────────────────────────────────────
//
// Merges multiple PostToolUse payloads into a single progress update.

function mergeProgress(existing, incoming) {
  if (!incoming) return existing;
  if (!existing) return incoming;

  return Object.freeze({
    message: incoming.message || existing.message,
    toolName: incoming.toolName || existing.toolName,
    toolCount: (existing.toolCount || 0) + (incoming.toolCount || 1),
    result: incoming.result || existing.result,
    merged: true,
    mergedAt: new Date().toISOString(),
  });
}

module.exports = {
  DEFAULT_RATE_LIMIT_MS,
  createRateLimiter,
  mergeProgress,
};