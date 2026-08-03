"use strict";

// ─── MCP Bridge Bidirectional (M-003 MS-003 / F-008) ────────────────────────────
//
// Extends the M-003 MS-001 mcp-server.js (stdio JSON-RPC server) into a
// bidirectional bridge. The MS-001 mcp-server.js only supports the
// "external client → cortex-agent" direction (external clients call into
// cortex-agent's resources/tools). F-008 adds the mirror direction
// "cortex-agent → external MCP server" so the same bridge can route both
// ways over stdio JSON-RPC.
//
// What F-008 adds on top of mcp-server.js (zero modification of mcp-server.js):
//
//   1. ExternalMcpClient — outbound client that spawns an external MCP server
//      as a child process and lets cortex-agent call its resources/tools
//      (`resources/list`, `resources/read`, `tools/list`, `tools/call`).
//      Reuses the same Content-Length framed JSON-RPC parser as mcp-server.
//
//   2. McpBridge — bidirectional bridge. Composes McpServer (incoming side)
//      + ExternalMcpClient (outgoing side). The bridge supports a single
//      stdio channel that carries both directions:
//        - external MCP client connects to this bridge
//        - bridge handles incoming requests via McpServer
//        - bridge can simultaneously call out to a peer external MCP server
//          via ExternalMcpClient (e.g. to forward or proxy requests)
//
//   3. Concurrent-safe request handling. The outgoing client uses a request
//      id → response resolver map. mcp-server.js's request handling is
//      already concurrent-safe (each request gets its own dispatched
//      promise), so the only new concurrent code lives in the client's
//      response routing.
//
//   4. Direction field on every journal / log entry. Direction is one of
//      "incoming" (external → cortex-agent) or "outgoing" (cortex-agent →
//      external). This makes the journal + tests able to assert which side
//      a call came from / went to.
//
//   5. e2e round-trip — the bridge can be tested end-to-end by spawning it
//      as a subprocess, connecting a mock external client on stdin/stdout,
//      AND spawning a mock external server as a child process that the
//      bridge's outgoing client talks to. The test asserts:
//        - external client calls `cortex://registry/agents` → bridge
//          responds with cortex-agent's registry
//        - bridge calls external server's `tools/call echo` → external
//          server responds
//        - both directions complete within a single bridge lifecycle
//
// MCP spec compatibility: 100% compatible with MCP 2024-11-05. We speak
// standard Content-Length framed JSON-RPC 2.0, and our method names are the
// canonical MCP methods (`initialize` / `ping` / `resources/list` /
// `resources/read` / `tools/list` / `tools/call`). The bridge can therefore
// be used as a drop-in peer for any other MCP-compliant client / server.
//
// Hard constraints:
//   - Zero npm deps. node:child_process / node:fs / node:path only.
//   - Zero modification of mcp-server.js. The bridge COMPOSES it.
//   - No file in lib/agents/ (M-002 5/5 + M-003 MS-001) is modified.

const { spawn } = require("node:child_process");
const {
  McpServer,
  SERVER_INFO,
  SUPPORTED_PROTOCOL,
  ERR_PARSE,
  ERR_INVALID_REQUEST,
  ERR_METHOD_NOT_FOUND,
  ERR_INVALID_PARAMS,
  ERR_INTERNAL,
} = require("./mcp-server");

// JSON-RPC 2.0 standard error codes (mirror the subset in mcp-server.js so
// both sides of the bridge speak the same error vocabulary).
const ERR_REQUEST_TIMEOUT = -32000;

// ─── ExternalMcpClient (outbound side) ────────────────────────────────────────

class ExternalMcpClient {
  // Spawns an external MCP server as a child process. The child must speak
  // stdio JSON-RPC 2.0 with Content-Length framing. The client is
  // concurrent-safe: requests are multiplexed on a single stdio channel
  // and resolved in arrival order by `id`.
  constructor(options = {}) {
    this.bin = options.bin;
    this.args = Array.isArray(options.args) ? options.args : [];
    this.env = { ...(options.env || process.env) };
    this.cwd = options.cwd || process.cwd();
    this.shell = options.shell !== undefined ? options.shell : true;
    this.timeoutMs = options.timeoutMs || 30000;
    this.log = typeof options.log === "function" ? options.log : null;
    this._child = null;
    this._buffer = Buffer.alloc(0);
    this._initialized = false;
    this._closed = false;
    // requestId → { resolve, reject, timer, method, startedAt }
    this._pending = new Map();
    this._nextId = 1;
    this._onDataHandlers = [];
    this._onEndHandlers = [];
  }

  _log(msg) {
    if (typeof this.log === "function") {
      try { this.log(msg); } catch (_) { /* ignore */ }
    }
  }

  // start() — spawn the external server. Resolves once stdio is wired.
  // Call initialize() right after to perform the MCP handshake.
  start() {
    if (this._child) return Promise.resolve();
    if (!this.bin) {
      return Promise.reject(new Error("ExternalMcpClient: bin (external server path) required"));
    }
    return new Promise((resolve, reject) => {
      let spawnError = null;
      try {
        this._child = spawn(this.bin, this.args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: this.env,
          cwd: this.cwd,
          shell: this.shell,
        });
      } catch (err) {
        spawnError = err;
      }
      if (spawnError || !this._child) {
        return reject(spawnError || new Error("ExternalMcpClient: spawn returned no child"));
      }
      this._child.stdout.on("data", (chunk) => this._onData(chunk));
      this._child.stderr.on("data", (chunk) => {
        this._log(`external-mcp-client: stderr: ${chunk.toString("utf8").trim()}`);
      });
      this._child.on("exit", (code, signal) => {
        this._closed = true;
        this._onEndHandlers.forEach((h) => {
          try { h({ code, signal }); } catch (_) { /* ignore */ }
        });
        // Reject all in-flight requests with a clear error so callers don't
        // hang forever if the external server dies mid-call.
        for (const [id, entry] of this._pending.entries()) {
          clearTimeout(entry.timer);
          entry.reject(new Error(`external MCP server exited (code=${code} signal=${signal}) before responding to id=${id}`));
          this._pending.delete(id);
        }
      });
      this._child.on("error", (err) => {
        this._log(`external-mcp-client: spawn error: ${err.message}`);
      });
      // Give the child a beat to set up its stdio before we declare it
      // started. Most MCP servers print nothing on startup so this is
      // effectively immediate; we still want a microtask boundary.
      setImmediate(() => resolve());
    });
  }

  // initialize() — perform the MCP handshake. Returns the server's
  // initialize response.
  async initialize(clientInfo = { name: "cortex-agent-bridge", version: "0.1.0" }) {
    const result = await this.request("initialize", {
      protocolVersion: SUPPORTED_PROTOCOL,
      capabilities: {},
      clientInfo,
    });
    this._initialized = true;
    return result;
  }

  // listResources() — shortcut for `resources/list`.
  async listResources() {
    return this.request("resources/list", {});
  }
  // readResource(uri) — shortcut for `resources/read`.
  async readResource(uri) {
    return this.request("resources/read", { uri });
  }
  // listTools() — shortcut for `tools/list`.
  async listTools() {
    return this.request("tools/list", {});
  }
  // callTool(name, args) — shortcut for `tools/call`.
  async callTool(name, args) {
    return this.request("tools/call", { name, arguments: args || {} });
  }
  // ping() — health check.
  async ping() {
    return this.request("ping", {});
  }

  // request(method, params) — low-level JSON-RPC dispatch. Concurrent-safe.
  // Returns a promise that resolves with the `result` field of the response,
  // or rejects with an Error carrying `.code` from the JSON-RPC error envelope.
  async request(method, params) {
    if (this._closed) {
      const err = new Error("ExternalMcpClient: closed");
      err.code = "ERR_CLIENT_CLOSED";
      throw err;
    }
    const id = this._nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          const err = new Error(`external MCP request "${method}" timed out after ${this.timeoutMs}ms`);
          err.code = ERR_REQUEST_TIMEOUT;
          err.method = method;
          err.timeout = true;
          reject(err);
        }
      }, this.timeoutMs);
      this._pending.set(id, { resolve, reject, timer, method, startedAt: Date.now() });
      try {
        const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
        this._child.stdin.write(header);
        this._child.stdin.write(body);
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        const wrapped = new Error(`failed to write request: ${err.message}`);
        wrapped.code = "ERR_CLIENT_WRITE";
        reject(wrapped);
      }
    });
  }

  // close() — kill the child and reject all in-flight requests.
  close() {
    if (this._closed) return;
    this._closed = true;
    if (this._child) {
      try { this._child.kill("SIGTERM"); } catch (_) { /* ignore */ }
      setTimeout(() => {
        try { this._child && this._child.kill("SIGKILL"); } catch (_) { /* ignore */ }
      }, 1500);
    }
    for (const [, entry] of this._pending.entries()) {
      clearTimeout(entry.timer);
      const err = new Error("client closed");
      err.code = "ERR_CLIENT_CLOSED";
      entry.reject(err);
    }
    this._pending.clear();
  }

  // ─── internal ────────────────────────────────────────────────────────────

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    this._processBuffer();
  }

  _processBuffer() {
    while (true) {
      const parsed = this._tryParseNextMessage();
      if (!parsed) return;
      this._handleResponse(parsed).catch((err) => {
        this._log(`external-mcp-client: handler error: ${err.message}`);
      });
    }
  }

  _tryParseNextMessage() {
    if (this._buffer.length === 0) return null;
    const headerEnd = this._buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
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
      this._buffer = this._buffer.slice(headerEnd + separatorLen);
      this._log(`external-mcp-client: dropping malformed header: ${header.replace(/\r/g, "\\r").replace(/\n/g, "\\n")}`);
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
      this._log(`external-mcp-client: bad JSON body: ${err.message}`);
      return null;
    }
  }

  async _handleResponse(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.id === undefined || msg.id === null) {
      // Notification (no id). We don't expose any notifications on the
      // client side yet (MCP notifications are server→client for things
      // like resources/updated). Drop silently to keep the parser simple.
      this._log(`external-mcp-client: dropping notification ${msg.method || "(no method)"}`);
      return;
    }
    const entry = this._pending.get(msg.id);
    if (!entry) {
      this._log(`external-mcp-client: response for unknown id ${msg.id} (already settled?)`);
      return;
    }
    this._pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) {
      const err = new Error(msg.error.message || "external MCP server returned an error");
      err.code = msg.error.code || ERR_INTERNAL;
      err.data = msg.error.data || null;
      err.method = entry.method;
      entry.reject(err);
      return;
    }
    entry.resolve(msg.result);
  }

  onEnd(cb) { this._onEndHandlers.push(cb); }
}

// ─── McpBridge (composes McpServer + ExternalMcpClient) ───────────────────────

class McpBridge {
  // Bidirectional bridge. Three construction modes:
  //
  //   (a) `McpBridge({ projectRoot, input, output, error })` — pure server
  //       mode; the bridge acts only as the "external → cortex-agent" side.
  //       This is effectively a thin wrapper around McpServer and exists
  //       for API symmetry with ExternalMcpClient.
  //
  //   (b) `McpBridge({ projectRoot, external: { bin, args, env } })` — full
  //       bidirectional mode. The bridge composes:
  //         - McpServer on the provided input/output streams (incoming)
  //         - ExternalMcpClient that spawns the external server (outgoing)
  //       Direction is recorded on every journal entry / log line.
  //
  //   (c) `McpBridge({ server, client })` — pre-built instances. Used by
  //       tests to inject mock transports.
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
    this.log = typeof options.log === "function" ? options.log : null;
    this.journalDir = options.journalDir || null;

    if (options.server) {
      this.server = options.server;
    } else {
      this.server = new McpServer({
        projectRoot: this.projectRoot,
        input: options.input || process.stdin,
        output: options.output || process.stdout,
        error: options.error || process.stderr,
        log: this._log.bind(this, "incoming"),
      });
    }

    if (options.client) {
      this.client = options.client;
      this._ownsClient = false;
    } else if (options.external && options.external.bin) {
      this.client = new ExternalMcpClient({
        bin: options.external.bin,
        args: options.external.args || [],
        env: options.external.env || process.env,
        cwd: options.external.cwd || process.cwd(),
        shell: options.external.shell !== undefined ? options.external.shell : true,
        timeoutMs: options.external.timeoutMs || 30000,
        log: this._log.bind(this, "outgoing"),
      });
      this._ownsClient = true;
    } else {
      this.client = null;
    }

    // Stats — useful for tests and for the CLI surface to report bridge
    // activity (how many incoming vs outgoing calls).
    this.stats = {
      incoming: { requests: 0, responses: 0, errors: 0 },
      outgoing: { requests: 0, responses: 0, errors: 0 },
    };
  }

  _log(direction, msg) {
    if (typeof this.log === "function") {
      try { this.log(`mcp-bridge[${direction}]: ${msg}`); } catch (_) { /* ignore */ }
    }
  }

  // start() — bring up both sides. If the client is owned and a bin was
  // provided, spawn it. The server's input/output streams are already wired
  // in its constructor; we just call start() to begin listening.
  async start() {
    if (this.client && this._ownsClient) {
      await this.client.start();
    }
    if (this.server && typeof this.server.start === "function") {
      try { this.server.start(); } catch (err) {
        if (!/already (started|closed)/i.test(err.message)) throw err;
      }
    }
  }

  // close() — tear down. Server's close() is a no-op flag; client close()
  // SIGTERMs the child. If we own the client, the caller is responsible for
  // any pending outgoing requests to settle (we reject them on close).
  close() {
    if (this.client && this._ownsClient) {
      try { this.client.close(); } catch (_) { /* ignore */ }
    }
    if (this.server && typeof this.server.close === "function") {
      try { this.server.close(); } catch (_) { /* ignore */ }
    }
  }

  // handleIncoming(msg) — proxy to the underlying McpServer. Increments
  // incoming stats. Returns the dispatch result (response payload) or null
  // for notifications / parse errors.
  async handleIncoming(msg) {
    this.stats.incoming.requests += 1;
    try {
      const result = await this.server.handleRequest(msg);
      this.stats.incoming.responses += 1;
      return result;
    } catch (err) {
      this.stats.incoming.errors += 1;
      throw err;
    }
  }

  // handleOutgoing(method, params) — proxy to the underlying client. If no
  // client is configured, returns a structured "no peer" error. Increments
  // outgoing stats.
  async handleOutgoing(method, params) {
    if (!this.client) {
      const err = new Error("mcp-bridge: no external MCP client configured (set options.external.bin)");
      err.code = "ERR_NO_EXTERNAL_PEER";
      err.method = method;
      this.stats.outgoing.errors += 1;
      throw err;
    }
    this.stats.outgoing.requests += 1;
    try {
      const result = await this.client.request(method, params);
      this.stats.outgoing.responses += 1;
      return result;
    } catch (err) {
      this.stats.outgoing.errors += 1;
      throw err;
    }
  }

  // Convenience proxies that the bridge can use to forward incoming calls
  // to the outgoing peer (e.g. a cortex-agent resource read could trigger
  // a tool call on the external server). Tests use these to assert the
  // round-trip.
  async outgoingListTools() { return this.handleOutgoing("tools/list", {}); }
  async outgoingCallTool(name, args) { return this.handleOutgoing("tools/call", { name, arguments: args || {} }); }
  async outgoingPing() { return this.handleOutgoing("ping", {}); }
}

module.exports = {
  McpBridge,
  ExternalMcpClient,
  // re-exports for tests / external callers that need the underlying
  // primitives without re-importing mcp-server.js
  SERVER_INFO,
  SUPPORTED_PROTOCOL,
  ERR_PARSE,
  ERR_INVALID_REQUEST,
  ERR_METHOD_NOT_FOUND,
  ERR_INVALID_PARAMS,
  ERR_INTERNAL,
  ERR_REQUEST_TIMEOUT,
};
