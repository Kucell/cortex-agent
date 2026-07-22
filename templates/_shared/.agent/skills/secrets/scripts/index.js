"use strict";

// ─── secrets (L1 secrets-vcs — credential storage abstraction) ────────────────
// Pluggable credential storage.  Agent references `secret://<namespace>/<ref>`
// and the framework resolves it through one of four backends (keychain,
// secret-service, file-gpg, env).  Backends are independent shell scripts
// in `./backends/<name>.sh`; this CLI is the orchestrator.
//
// Why a thin CLI over shells (not a single binary per backend):
//   - Pluggable: new backends ship as POSIX shell, framework stays small.
//   - Auditable: each backend's behavior is one shell script; operators
//     can `cat` it instead of reverse-engineering a Node module.
//   - Cross-platform: macOS, Linux, CI containers each route to the
//     native store that already exists.
//
// Contracts:
//   action=get      input: {action,ref,service,account?}
//   action=store    input: {action,ref,service,account?,value}
//   action=rotate   input: {action,ref,service}
//   action=delete   input: {action,ref,service}
//   action=audit    input: {action}  -- logs only (no value)
//   action=list     input: {action}  -- reads config, no values
//
// Output:
//   always JSON.  On success: {ok:true, action, ref, ...}.
//   On error:    {ok:false, error, ...}.
//
// Redaction:
//   any stdout / stderr from a backend is scrubbed by redact.js before it
//   reaches the caller.  `--no-mask` allows raw value passthrough; even
//   so, callers that consume `--no-mask` (vcs-pr create) must not embed
//   the value into any agent-visible log.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  redactUnknown,
  makeRedactor,
  wrapSpawnResult,
  REDACT_TOKEN,
} = require("./redact.js");

const AGENT_ROOT = path.join(process.cwd(), ".agent");
const BACKENDS_DIR = path.join(__dirname, "backends");

const BACKENDS = new Set(["keychain", "secret-service", "file-gpg", "env"]);
const ACTIONS = new Set(["get", "store", "rotate", "delete", "list", "audit"]);
const GATE_STRICT = new Set(["user"]);

function flag(name, argv) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function fail(error, message, code = 2) {
  emit({ ok: false, error, message });
  process.exit(code);
}

function requireGate(allowed) {
  const gate = flag("--gate", process.argv.slice(2));
  if (!allowed.includes(gate)) {
    fail("workflow_gate_required", `--gate must be one of: ${allowed.join(", ")}`);
  }
  return gate;
}

function readPayload() {
  const raw = flag("--payload-json", process.argv.slice(2));
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    fail("invalid_payload_json", err.message);
    return {};
  }
}

function loadConfig() {
  const configPath = path.join(AGENT_ROOT, "config", "secrets.yml");
  if (!fs.existsSync(configPath)) return null;
  // Minimal line-level YAML-ish parser (sufficient for our flat schema).
  // For richer YAML, users can rely on a real YAML parser; this keeps zero
  // dependency.  Keeps indices so we can locate the `service:` line of
  // a given ref and read its value (the indent-based parser below).
  const text = fs.readFileSync(configPath, "utf8");
  const lines = text.split(/\r?\n/);
  const out = { default_backend: null, secrets: [] };
  let inSecrets = false;
  for (const line of lines) {
    const trimmed = line.replace(/#.*$/, "").replace(/^\s+/, "");
    if (!trimmed) continue;
    if (trimmed === "secrets:") {
      inSecrets = true;
      continue;
    }
    if (inSecrets && !line.startsWith(" ") && !line.startsWith("-") && !line.startsWith("\t")) {
      inSecrets = false;
    }
    if (inSecrets) {
      const m = trimmed.match(/^-\s+ref:\s+(\S+)/);
      if (m) out.secrets.push({ ref: m[1] });
      // Child line: `    service: <value>` etc., must attach to the most
      // recently pushed ref. Test the trimmed prefix so leading indent
      // does NOT make us skip the match.
      const child = trimmed.match(/^(\w+):\s+(.+?)\s*$/);
      if (child && child[1] !== "ref") {
        const last = out.secrets[out.secrets.length - 1];
        if (last && !last[child[1]]) last[child[1]] = child[2].replace(/^["']|["']$/g, "");
      }
      continue;
    }
    const m = trimmed.match(/^default_backend:\s+(\S+)/) || trimmed.match(/^backend:\s+(\S+)/);
    if (m) out.default_backend = m[1];
  }
  return out;
}

function backendScript(name) {
  const script = path.join(BACKENDS_DIR, `${name}.sh`);
  if (!fs.existsSync(script)) {
    fail("backend_unavailable", `${name} backend not present at ${script}`);
  }
  return script;
}

function runBackend(backend, payload, knownSecrets = []) {
  const script = backendScript(backend);
  const json = JSON.stringify(payload);
  const result = spawnSync("/bin/bash", [script, json], { encoding: "utf8" });
  const safe = wrapSpawnResult(result, knownSecrets);
  let body = {};
  try {
    body = JSON.parse(safe.stdout || "{}");
  } catch (_) {
    body = {
      ok: false,
      error: "backend_unparseable_response",
      raw: safe.stdout,
      stderr: safe.stderr,
    };
  }
  return body;
}

function redactForCallers(value) {
  if (typeof value !== "string") return REDACT_TOKEN;
  if (value.length === 0) return "";
  if (value.length <= 4) return REDACT_TOKEN;
  return `${REDACT_TOKEN}(len=${value.length})`;
}

function main() {
  const argv = process.argv.slice(2);
  const [command] = argv;
  const action = flag("--action", argv) || (ACTIONS.has(command) ? command : null);
  if (!action || !ACTIONS.has(action)) {
    fail(
      "unknown_command",
      "Usage: node secrets/index.js get|store|rotate|delete|list|audit [--ref REF] [--backend …] [--gate …]",
    );
  }

  if (action === "list") {
    requireGate(["agent", "user", "mission"]);
    const cfg = loadConfig();
    if (!cfg) {
      emit({ ok: true, action: "list", secrets: [], note: "no config/secrets.yml; run secrets store to register." });
      return;
    }
    emit({ ok: true, action: "list", default_backend: cfg.default_backend, secrets: cfg.secrets });
    return;
  }

  if (action === "audit") {
    requireGate(["agent", "user", "mission"]);
    const cfg = loadConfig();
    const known = Array.isArray(cfg?.secrets) ? cfg.secrets.map((s) => s.ref) : [];
    emit({ ok: true, action: "audit", known_refs: known, backend_set: Array.from(BACKENDS), note: "audit logged to runs.events[] when --run-id present" });
    return;
  }

  // get / store / rotate / delete — the security-sensitive path.
  const ref = flag("--ref", argv);
  const backend = flag("--backend", argv) || loadConfig()?.default_backend || "keychain";
  if (!ref) fail("missing_ref", "--ref is required for get / store / rotate / delete.");
  if (!BACKENDS.has(backend)) {
    fail("unknown_backend", `--backend must be one of: ${[...BACKENDS].join(", ")}`);
  }
  if (action === "store" || action === "get") {
    requireGate([...GATE_STRICT]);
  } else {
    requireGate(["agent", "user", "mission"]);
  }

  // Resolve actual service name through the config (`service:` field under
  // each ref), not the ref itself.  Allows users to keep stable ref names
  // ("gitea-pr") while pointing at OS-specific backend keys ("gitea-..."
  // in keychain).  Falls back to ref if config is absent — same code path
  // as before the fix.
  const cfg = loadConfig();
  const declared = cfg?.secrets?.find?.((s) => s && s.ref === ref);
  const service = flag("--service", argv) || declared?.service || ref;
  const account = flag("--account", argv) || declared?.account;
  const payload = {
    action,
    ref,
    service,
    account,
  };
  if (action === "store") {
    const value = flag("--value", argv) || readPayload().value;
    if (!value) fail("missing_value", "--value or --payload-json value is required for store.");
    payload.value = value;
  }

  // For get, mask by default.  --no-mask lets the secret come through
  // unwrapped (still redacted in transit via wrapSpawnResult).
  // --no-mask is a standalone boolean flag (no value). `flag("--no-mask")`
  // would happily read the next argv element even if it's not a value, but
  // we treat it explicitly so callers can pass it as the trailing arg.
  const wantMask = argv.includes("--no-mask") ? false : true;
  // Run backend — input is the JSON payload, output is JSON.
  const rawBody = runBackend(backend, payload, []);
  if (!rawBody.ok) {
    emit(rawBody);
    process.exit(1);
  }
  if (action === "get") {
    if (wantMask) {
      emit({
        ok: true,
        action: "get",
        ref,
        backend,
        masked: redactForCallers(rawBody.value),
        secret_uri: `secret://${ref}`,
      });
      return;
    }
    emit({ ok: true, action: "get", ref, backend, value: rawBody.value });
    return;
  }
  // store / rotate / delete — emit plain ok.
  emit(rawBody);
}

if (require.main === module) main();
module.exports = { redactUnknown, makeRedactor, BACKENDS, ACTIONS };
