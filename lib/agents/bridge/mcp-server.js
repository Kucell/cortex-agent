"use strict";

// ─── MCP Bridge Core (M-003 MS-001 / F-007) ────────────────────────────────────
//
// Minimal Model Context Protocol (MCP) stdio JSON-RPC server. Exposes the
// cortex-agent Agent Registry (M-002 scope) over MCP so external MCP clients
// (Codex, IDE plugins, etc.) can discover agents and trigger invocations
// without coupling to cortex-agent's internal CLI surface.
//
// Transport: JSON-RPC 2.0 over stdio, framed with `Content-Length: N\r\n\r\n`
// (per the JSON-RPC over stdio spec used by MCP and Language Server Protocol).
//
// What MS-001 ships (read-first, D-003-2):
//   - 1 read-only resource: `cortex://registry/agents`
//   - 1 tool:               `cortex://invoke`   (returns a plan via M-002 invoke())
//   - ping + initialize handshake
//
// What MS-003 will extend (out of scope here, F-008):
//   - Bidirectional event subscription
//   - Write resources / tools (mutations go through M-002 / M-008 paths)
//   - Sampling / completion from external LLM providers
//
// Hard constraints:
//   - Zero npm deps. node:stream (process.stdin/stdout) + node:fs + node:path.
//   - Pure addition. No file in lib/agents/ (M-002 5/5) is modified.

const { listAgents } = require("../../registry/index");
const { invoke } = require("../invoke");

// JSON-RPC 2.0 standard error codes (subset; see jsonrpc.org/specification).
const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;

const SERVER_INFO = Object.freeze({
  name: "cortex-agent-mcp-bridge",
  version: "0.1.0",
});

const SUPPORTED_PROTOCOL = "2024-11-05";

class McpServer {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
    // Transport streams. Tests inject duplex mocks; production uses
    // process.stdin / process.stdout.
    this.input = options.input || process.stdin;
    this.output = options.output || process.stdout;
    this.error = options.error || process.stderr;
    this.log = typeof options.log === "function" ? options.log : null;
    // _log is the private log sink; it falls back to no-op if the caller
    // didn't supply one. The public `log` field above is for callers that
    // want to override the sink after construction.
    this._log = (msg) => {
      if (typeof this.log === "function") this.log(msg);
    };

    this._buffer = Buffer.alloc(0);
    this._initialized = false;
    this._closed = false;

    // Method → handler map. Bound here so subclasses can override one method
    // by reassigning the property (e.g. `server._handlers["tools/call"] = ...`).
    this._handlers = {
      initialize: this._handleInitialize.bind(this),
      "resources/list": this._handleResourcesList.bind(this),
      "resources/read": this._handleResourcesRead.bind(this),
      "tools/list": this._handleToolsList.bind(this),
      "tools/call": this._handleToolsCall.bind(this),
      ping: this._handlePing.bind(this),
    };
  }

  // ─── public surface ────────────────────────────────────────────────────

  start() {
    if (this._closed) throw new Error("McpServer: already closed");
    this.input.on("data", (chunk) => this._onData(chunk));
    this.input.on("end", () => this._onEnd());
  }

  close() {
    this._closed = true;
  }

  // Direct entry point for unit tests (skips stream wiring). Returns the
  // response payload (or null for notifications / parse errors).
  async handleRequest(msg) {
    return this._dispatch(msg);
  }

  // ─── stream glue ───────────────────────────────────────────────────────

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    this._processBuffer();
  }

  _onEnd() {
    this._closed = true;
  }

  _processBuffer() {
    while (true) {
      const parsed = this._tryParseNextMessage();
      if (!parsed) return;
      // Fire-and-forget; the handler writes the response synchronously or
      // via an awaited promise.
      this._dispatch(parsed).catch((err) => {
        this._log(`mcp: handler threw: ${err && err.message}`);
      });
    }
  }

  _tryParseNextMessage() {
    if (this._buffer.length === 0) return null;
    const headerEnd = this._buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      // No header found — but we may have an LF-only separator. Try that.
      const lfEnd = this._buffer.indexOf("\n\n");
      if (lfEnd === -1) return null;
      return this._parseFromHeader(lfEnd, 2);
    }
    return this._parseFromHeader(headerEnd, 4);
  }

  _parseFromHeader(headerEnd, separatorLen) {
    const header = this._buffer.slice(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      // Malformed framing — discard the partial header so we don't loop
      // forever. The next byte sequence will be re-evaluated.
      this._buffer = this._buffer.slice(headerEnd + separatorLen);
      this._log(`mcp: dropping malformed header: ${header.replace(/\r/g, "\\r").replace(/\n/g, "\\n")}`);
      return null;
    }
    const length = parseInt(match[1], 10);
    const bodyStart = headerEnd + separatorLen;
    if (this._buffer.length < bodyStart + length) return null;
    const body = this._buffer.slice(bodyStart, bodyStart + length).toString("utf8");
    this._buffer = this._buffer.slice(bodyStart + length);
    try {
      return JSON.parse(body);
    } catch (err) {
      this._log(`mcp: bad JSON body: ${err.message}`);
      return null;
    }
  }

  // ─── dispatch ──────────────────────────────────────────────────────────

  async _dispatch(msg) {
    if (!msg || typeof msg !== "object") {
      return this._sendError(null, ERR_INVALID_REQUEST, "Invalid request");
    }
    if (msg.jsonrpc !== "2.0") {
      return this._sendError(msg.id || null, ERR_INVALID_REQUEST, "jsonrpc must be '2.0'");
    }
    // Notifications (no id) don't get a response.
    const isNotification = msg.id === undefined || msg.id === null;
    const handler = this._handlers[msg.method];
    if (!handler) {
      if (isNotification) {
        this._log(`mcp: no handler for notification ${msg.method} (silently dropped)`);
        return null;
      }
      return this._sendError(msg.id, ERR_METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
    }
    try {
      const result = await handler(msg.params || {}, msg);
      if (isNotification) return null;
      return this._sendResponse(msg.id, result);
    } catch (err) {
      if (isNotification) {
        this._log(`mcp: handler error in notification ${msg.method}: ${err.message}`);
        return null;
      }
      return this._sendError(
        msg.id,
        err.code || ERR_INTERNAL,
        err.message || "Internal error",
      );
    }
  }

  _sendResponse(id, result) {
    const body = JSON.stringify({ jsonrpc: "2.0", id, result });
    this._writeFrame(body);
    return { id, result };
  }

  _sendError(id, code, message) {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: id === undefined ? null : id,
      error: { code, message },
    });
    this._writeFrame(body);
    return { id, error: { code, message } };
  }

  _writeFrame(body) {
    const length = Buffer.byteLength(body, "utf8");
    const header = `Content-Length: ${length}\r\n\r\n`;
    this.output.write(header);
    this.output.write(body);
  }

  // ─── method handlers ───────────────────────────────────────────────────

  async _handleInitialize(params) {
    this._initialized = true;
    return {
      protocolVersion: SUPPORTED_PROTOCOL,
      serverInfo: SERVER_INFO,
      capabilities: {
        resources: { subscribe: false, listChanged: false },
        tools: {},
      },
      ...(params && params.clientInfo ? {} : {}),
    };
  }

  async _handleResourcesList() {
    return {
      resources: [
        {
          uri: "cortex://registry/agents",
          name: "Agent Registry",
          description:
            "List of agents from .agent/agents/ (M-002 scope). Read-only.",
          mimeType: "application/json",
        },
      ],
    };
  }

  async _handleResourcesRead(params) {
    if (!params || !params.uri) {
      const err = new Error("params.uri is required");
      err.code = ERR_INVALID_PARAMS;
      throw err;
    }
    if (params.uri === "cortex://registry/agents") {
      const agents = listAgents(this.projectRoot);
      const text = JSON.stringify({ agents, count: agents.length });
      return {
        contents: [
          {
            uri: "cortex://registry/agents",
            mimeType: "application/json",
            text,
          },
        ],
      };
    }
    const err = new Error(`Unknown resource: ${params.uri}`);
    err.code = ERR_INVALID_PARAMS;
    throw err;
  }

  async _handleToolsList() {
    return {
      tools: [
        {
          name: "cortex://invoke",
          description:
            "Invoke an agent from the Agent Registry. MS-001 returns a deterministic " +
            "plan via M-002 lib/agents/invoke.js (no real dispatch); MS-003 will wire " +
            "real adapters via lib/agents/dispatch-execute.js.",
          inputSchema: {
            type: "object",
            required: ["agent_id", "task"],
            properties: {
              agent_id: { type: "string", description: "Agent id (e.g. Worker-A-MS001)" },
              task: { type: "string", description: "Task description" },
              input: {
                type: ["string", "object", "null"],
                description: "Optional input payload (object or stringified JSON)",
              },
              required_capabilities: {
                type: "array",
                items: { type: "string" },
                description: "Capabilities the caller requires (subset of declared)",
              },
              timeout: {
                type: "number",
                description: "Timeout in seconds (default 300)",
              },
            },
          },
        },
      ],
    };
  }

  async _handleToolsCall(params) {
    if (!params || !params.name) {
      const err = new Error("params.name is required");
      err.code = ERR_INVALID_PARAMS;
      throw err;
    }
    if (params.name === "cortex://invoke") {
      const args = params.arguments || {};
      if (!args.agent_id) {
        const err = new Error("arguments.agent_id is required");
        err.code = ERR_INVALID_PARAMS;
        throw err;
      }
      if (!args.task) {
        const err = new Error("arguments.task is required");
        err.code = ERR_INVALID_PARAMS;
        throw err;
      }
      const result = invoke({
        projectRoot: this.projectRoot,
        agentId: args.agent_id,
        taskDescription: args.task,
        input: args.input || null,
        requiredCapabilities: Array.isArray(args.required_capabilities)
          ? args.required_capabilities
          : [],
        timeout: args.timeout || 300,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
        isError: !!result.error,
      };
    }
    const err = new Error(`Unknown tool: ${params.name}`);
    err.code = ERR_INVALID_PARAMS;
    throw err;
  }

  async _handlePing() {
    return {};
  }
}

module.exports = {
  McpServer,
  SERVER_INFO,
  SUPPORTED_PROTOCOL,
  ERR_PARSE,
  ERR_INVALID_REQUEST,
  ERR_METHOD_NOT_FOUND,
  ERR_INVALID_PARAMS,
  ERR_INTERNAL,
};
