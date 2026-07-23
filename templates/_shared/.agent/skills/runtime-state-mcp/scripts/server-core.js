"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const URI_PREFIX = "cortex://management/";
const PROTOCOLS = new Set(["2025-03-26", "2024-11-05"]);

function diagnostic(message) {
  process.stderr.write(`[runtime-state-mcp] ${message}\n`);
}

function rpcError(code, message, data) {
  const error = new Error(message);
  error.rpc = { code, message, data };
  return error;
}

function configuredScript() {
  const marker = "--management-api-script";
  const index = process.argv.indexOf(marker);
  const value = index >= 0 ? process.argv[index + 1] : process.env.CORTEX_MANAGEMENT_API_SCRIPT;
  const candidate = value || path.join(".agent", "skills", "management-api", "scripts", "index.js");
  const script = path.resolve(process.cwd(), candidate);
  if (!fs.existsSync(script)) throw rpcError(-32001, "Management API unavailable", { reason: "management_api_not_found" });
  return script;
}

function invokeApi(args) {
  const result = spawnSync(process.execPath, [configuredScript(), ...args], {
    cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error ? result.error.message : String(result.stderr || "").trim();
    diagnostic(`Management API ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
    throw rpcError(-32001, "Management API unavailable", { reason: "management_api_query_failed", command: args.slice(0, 2) });
  }
  try {
    const payload = JSON.parse(result.stdout);
    if (!payload || payload.ok !== true) throw new Error("response is not ok");
    return payload;
  } catch (error) {
    diagnostic(`Management API returned invalid JSON: ${error.message}`);
    throw rpcError(-32002, "Invalid Management API projection", { reason: "invalid_projection" });
  }
}

function capabilities() {
  const payload = invokeApi(["query", "capabilities"]);
  const projections = Array.isArray(payload.projections) ? payload.projections.filter((entry) => entry && entry.name) : [];
  return { payload, projections, names: new Set(projections.map((entry) => entry.name)) };
}

function queryProjection(query, filters = {}) {
  const available = capabilities();
  if (!available.names.has(query)) throw rpcError(-32602, "Unsupported Management API projection", { query, allowed_queries: [...available.names] });
  const args = ["query", query];
  const definition = available.projections.find((entry) => entry.name === query);
  for (const name of ["since", "until"]) {
    if (filters[name] === undefined) continue;
    if (!Array.isArray(definition.filters) || !definition.filters.includes(name) || typeof filters[name] !== "string") {
      throw rpcError(-32602, "Unsupported projection filter", { query, filter: name });
    }
    args.push(`--${name}`, filters[name]);
  }
  const projection = invokeApi(args);
  if (projection.query !== query) throw rpcError(-32002, "Invalid Management API projection", { reason: "projection_identity_mismatch", query });
  return projection;
}

function resources() {
  return capabilities().projections.map((entry) => ({
    uri: `${URI_PREFIX}${entry.name}`,
    name: `Cortex Management API: ${entry.name}`,
    description: `Read-only ${entry.name} projection from the target project Management API`,
    mimeType: "application/json",
    annotations: { readOnlyHint: true },
  }));
}

function projectIdentity() {
  const root = fs.realpathSync(process.cwd());
  let agentRoot = path.join(root, ".agent");
  try { agentRoot = fs.realpathSync(agentRoot); } catch (_) {}
  return { root, agent_root: agentRoot };
}

function handle(request) {
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    throw rpcError(-32600, "Invalid Request", { reason: "invalid_json_rpc_request" });
  }
  if (request.method === "initialize") {
    const requested = request.params && request.params.protocolVersion;
    if (requested && !PROTOCOLS.has(requested)) throw rpcError(-32602, "Unsupported protocol version", { requested, supported: [...PROTOCOLS] });
    const project = projectIdentity();
    return {
      protocolVersion: requested || "2025-03-26",
      capabilities: { resources: {}, tools: {} },
      serverInfo: { name: "cortex-management", version: "1.0.0" },
      instructions: `Read-only Cortex Management API for ${project.root}. Writer tools are disabled.`,
    };
  }
  if (request.method === "notifications/initialized") return null;
  if (request.method === "resources/list") return { resources: resources() };
  if (request.method === "resources/read") {
    const uri = request.params && request.params.uri;
    if (typeof uri !== "string" || !uri.startsWith(URI_PREFIX)) throw rpcError(-32602, "Unsupported resource URI", { uri: uri || null, allowed_prefix: URI_PREFIX });
    const query = uri.slice(URI_PREFIX.length);
    if (!query || query.includes("/")) throw rpcError(-32602, "Unsupported resource URI", { uri });
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(queryProjection(query)) }] };
  }
  if (request.method === "tools/list") {
    return { tools: [{
      name: "cortex.query",
      description: "Read one supported Management API projection from the bound project.",
      inputSchema: { type: "object", required: ["projection"], properties: { projection: { type: "string" }, since: { type: "string" }, until: { type: "string" } }, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }] };
  }
  if (request.method === "tools/call") {
    const name = request.params && request.params.name;
    const args = request.params && request.params.arguments;
    if (name !== "cortex.query" || !args || typeof args.projection !== "string") throw rpcError(-32602, "Unsupported tool call", { name: name || null, read_only: true });
    const allowed = new Set(["projection", "since", "until"]);
    if (Object.keys(args).some((key) => !allowed.has(key))) throw rpcError(-32602, "Unsupported tool argument", { read_only: true });
    const projection = queryProjection(args.projection, { since: args.since, until: args.until });
    return { content: [{ type: "text", text: JSON.stringify(projection) }], structuredContent: projection, isError: false };
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

function start() {
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
}

module.exports = { start };
