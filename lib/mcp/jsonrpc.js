"use strict";

/**
 * lib/mcp/jsonrpc.js — minimal JSON-RPC 2.0 over stdio (P-002 MS-003).
 *
 * Transport contract: newline-delimited JSON frames over a Node stream
 * (process.stdin / process.stdout for the real server; PassThrough in tests).
 * This mirrors the existing runtime-state MCP server framing
 * (templates/_shared/.agent/skills/runtime-state-mcp/scripts/server-core.js)
 * so MCP clients built against either server use the same wire format.
 *
 * Pure Node.js built-ins only (node:readline + node:stream). No npm deps.
 *
 * Exports:
 *   readFrames(stream)                    -> async iterable of parsed JSON frames
 *   sendResult(stream, id, result)        -> write a success response frame
 *   sendError(stream, id, code, message)  -> write an error response frame
 */

const readline = require("node:readline");

/**
 * Return an async iterable that yields each parsed JSON-RPC frame from
 * `stream`. Empty lines and malformed frames are skipped (never throw —
 * a hostile/broken peer must not take the server down). When the stream
 * ends, the iterator completes.
 *
 * @param {NodeJS.ReadableStream} stream
 * @returns {AsyncIterable<object>}
 */
async function* readFrames(stream) {
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
  for await (const rawLine of rl) {
    const line = String(rawLine).trim();
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch (_) {
      // Malformed frame — skip and keep serving the next one.
    }
  }
}

/**
 * Write a JSON-RPC 2.0 success response frame.
 *
 * @param {NodeJS.WritableStream} stream
 * @param {string|number} id   request id echoed back
 * @param {*} result           result payload (must be JSON-serializable)
 */
function sendResult(stream, id, result) {
  stream.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

/**
 * Write a JSON-RPC 2.0 error response frame.
 *
 * @param {NodeJS.WritableStream} stream
 * @param {string|number} id      request id echoed back
 * @param {number} code           JSON-RPC error code (-32700..-32603)
 * @param {string} message        human-readable error message
 * @param {*} [data]              optional structured error data
 */
function sendError(stream, id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  stream.write(`${JSON.stringify({ jsonrpc: "2.0", id, error })}\n`);
}

module.exports = { readFrames, sendResult, sendError };
