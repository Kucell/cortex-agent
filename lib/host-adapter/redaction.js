/**
 * lib/host-adapter/redaction.js
 *
 * M-013 SP-003 / VC-002a: 6 redaction classes enforced at adapter boundary.
 *
 * Per P-005 §5.1 + §9: at the adapter boundary, raw content is replaced
 * with digests + bounded metadata. The journal only carries category +
 * status + duration + digest, never raw body / args / path.
 *
 * Redaction classes:
 *   - prompt: LLM prompt text
 *   - response: LLM response text
 *   - tool_arguments: tool call args
 *   - tool_output: tool output body
 *   - file_body: file content
 *   - absolute_path: absolute filesystem path
 */
'use strict';

const crypto = require('node:crypto');

const SECRET_PATTERNS = [
  /api[-_]?key\s*[=:]\s*[\w-]+/gi,
  /password\s*[=:]\s*[\w-]+/gi,
  /token\s*[=:]\s*[\w-]+/gi,
  /secret\s*[=:]\s*[\w-]+/gi,
  /bearer\s+[\w-]+/gi,
  /sk-[a-zA-Z0-9]{20,}/g,
  /AKIA[A-Z0-9]{16}/g
];

function redactString(value, class_) {
  if (typeof value !== 'string') return null;
  return {
    redacted_class: class_,
    digest: sha256(value),
    length: value.length,
    secrets_detected: detectSecrets(value).length
  };
}

function redactObject(obj, class_) {
  if (!obj || typeof obj !== 'object') return null;
  const fields = Object.keys(obj);
  return {
    redacted_class: class_,
    digest: sha256(JSON.stringify(obj)),
    fieldCount: fields.length,
    fieldNames: fields.map((f) => f.slice(0, 32))  // bounded, no PII
  };
}

function redactPath(absolutePath, repoRoot) {
  if (typeof absolutePath !== 'string') return null;
  let repoPath = absolutePath;
  if (repoRoot && absolutePath.startsWith(repoRoot)) {
    repoPath = absolutePath.slice(repoRoot.length).replace(/^[/\\]/, '');
  }
  return {
    redacted_class: 'absolute_path',
    repoPath,
    absolutePathDigest: sha256(absolutePath),
    length: absolutePath.length
  };
}

function redactFileBody(content, repoPath) {
  if (typeof content !== 'string') return null;
  return {
    redacted_class: 'file_body',
    repoPath: repoPath || 'unknown',
    bodyDigest: sha256(content),
    length: content.length,
    secrets_detected: detectSecrets(content).length
  };
}

function detectSecrets(content) {
  if (typeof content !== 'string') return [];
  const hits = [];
  for (const pat of SECRET_PATTERNS) {
    pat.lastIndex = 0;
    const matches = content.match(pat);
    if (matches) hits.push({ pattern: pat.source, count: matches.length });
  }
  return hits;
}

function sha256(s) {
  return 'sha256:' + crypto.createHash('sha256').update(String(s)).digest('hex');
}

module.exports = {
  redactString,
  redactObject,
  redactPath,
  redactFileBody,
  detectSecrets,
  sha256,
  SECRET_PATTERNS
};
