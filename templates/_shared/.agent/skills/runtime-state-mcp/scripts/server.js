#!/usr/bin/env node
"use strict";

const path = require("path");
const { spawnSync } = require("child_process");

const QUERIES = Object.freeze([
  "runtime-state", "workspaces", "hook-runs", "resource-leases",
  "composite-workspaces", "resource-events", "guided-reviews", "benchmarks",
]);
const URI_PREFIX = "cortex://runtime-state/";
const querySet = new Set(QUERIES);

function diagnostic(message) {
  process.stderr.write(`[runtime-state-mcp] ${message}\n`);
}

function configuredScript() {
  const marker = "--management-api-script";
  const index = process.argv.indexOf(marker);
  const value = index >= 0 ? process.argv[index + 1] : process.env.CORTEX_MANAGEMENT_API_SCRIPT;
  if (!value) throw rpcError(-32001, "Management API unavailable", { reason: "management_api_not_configured" });
  return path.resolve(process.cwd(), value);
}

function rpcError(code, message, data) {
  const error = new Error(message);
  error.rpc = { code, message, data };
  return error;
}

function queryProjection(query) {
  if (!querySet.has(query)) throw rpcError(-32602, "Unsupported runtime-state query", { query, allowed_queries: QUERIES });
  const script = configuredScript();
  const result = spawnSync(process.execPath, [script, "query", query], {
    cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    const detail = result.error ? result.error.message : String(result.stderr || "").trim();
    diagnostic(`Management API query ${query} failed${detail ? `: ${detail}` : ""}`);
    throw rpcError(-32001, "Management API unavailable", { reason: "management_api_query_failed", query });
  }
  try {
    const projection = JSON.parse(result.stdout);
    if (!projection || projection.ok !== true || projection.query !== query) throw new Error("projection identity mismatch");
    return projection;
  } catch (error) {
    diagnostic(`Management API query ${query} returned invalid JSON: ${error.message}`);
    throw rpcError(-32002, "Invalid Management API projection", { reason: "invalid_projection", query });
  }
}

function resources() {
  return QUERIES.map((query) => ({
    uri: `${URI_PREFIX}${query}`,
    name: `Cortex runtime state: ${query}`,
    description: `Read-only ${query} projection from the Cortex Agent Management API`,
    mimeType: "application/json",
  }));
}

function handle(request) {
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    throw rpcError(-32600, "Invalid Request", { reason: "invalid_json_rpc_request" });
  }
  if (request.method === "initialize") {
    return { protocolVersion: "2025-03-26", capabilities: { resources: {} }, serverInfo: { name: "cortex-runtime-state", version: "1.0.0" } };
  }
  if (request.method === "notifications/initialized") return null;
  if (request.method === "resources/list") return { resources: resources() };
  if (request.method === "resources/read") {
    const uri = request.params && request.params.uri;
    if (typeof uri !== "string" || !uri.startsWith(URI_PREFIX)) {
      throw rpcError(-32602, "Unsupported resource URI", { uri: uri || null, allowed_prefix: URI_PREFIX });
    }
    const query = uri.slice(URI_PREFIX.length);
    if (!querySet.has(query) || query.includes("/")) {
      throw rpcError(-32602, "Unsupported resource URI", { uri, allowed_queries: QUERIES });
    }
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(queryProjection(query)) }] };
  }
  throw rpcError(-32601, "Method not found", { method: request.method, read_only: true });
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function respond(request) {
  try {
    const result = handle(request);
    if (request.id === undefined || request.id === null || result === null) return;
    send({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    const rpc = error.rpc || { code: -32603, message: "Internal error", data: { reason: "internal_error" } };
    diagnostic(`${rpc.message}: ${rpc.data && rpc.data.reason ? rpc.data.reason : "unknown"}`);
    if (request && request.id !== undefined && request.id !== null) send({ jsonrpc: "2.0", id: request.id, error: rpc });
  }
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  while (buffer.includes("\n")) {
    const boundary = buffer.indexOf("\n");
    const body = buffer.slice(0, boundary).trim();
    buffer = buffer.slice(boundary + 1);
    if (!body) continue;
    try { respond(JSON.parse(body)); } catch (error) { diagnostic(`invalid JSON message: ${error.message}`); }
  }
});
process.stdin.on("error", (error) => diagnostic(`stdin error: ${error.message}`));
