"use strict";

const REF_KINDS = Object.freeze([
  "project",
  "workspace",
  "run",
  "agent",
  "host",
  "runtime",
  "session",
]);

const REF_KIND_SET = new Set(REF_KINDS);
const REF_PATTERN = /^([a-z][a-z0-9-]*):(.+)$/;

function createRef(kind, value) {
  if (!REF_KIND_SET.has(kind)) {
    const error = new Error(`Unknown Cortex ref kind: ${kind}`);
    error.code = "ERR_REF_KIND_UNKNOWN";
    throw error;
  }
  const id = String(value || "").trim();
  if (!id || /[\r\n]/.test(id)) {
    const error = new Error("Cortex ref value must be a non-empty single-line string.");
    error.code = "ERR_REF_VALUE_INVALID";
    throw error;
  }
  return `${kind}:${id}`;
}

function parseRef(value, expectedKind) {
  if (typeof value !== "string") return null;
  const match = REF_PATTERN.exec(value);
  if (!match || !REF_KIND_SET.has(match[1])) return null;
  if (expectedKind && match[1] !== expectedKind) return null;
  return Object.freeze({ kind: match[1], value: match[2], ref: value });
}

function isRef(value, expectedKind) {
  return parseRef(value, expectedKind) !== null;
}

module.exports = {
  REF_KINDS,
  createRef,
  parseRef,
  isRef,
};
