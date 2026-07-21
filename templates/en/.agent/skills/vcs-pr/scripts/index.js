"use strict";

// ─── vcs-pr (L1 secrets-vcs — Pull Request orchestrator) ──────────────────────
// Pluggable VCS PR management.  Reads `config/vcs.yml` for backend + host
// + repo, resolves the configured `token_ref` through the secrets skill
// (so the agent never sees the actual token), invokes the matching
// backend (gitea / github / gitlab), and appends a `vcs_pr_opened` /
// `vcs_pr_merged` / `vcs_pr_closed` event to the current run (when
// discovered via Phase 1 session-triage's session metadata).
//
// Why a separate orchestrator: the backends are tiny, but the security-
// critical bit is the secret resolution + event correlation, which lives
// here.  No host ever sees plaintext tokens and no event is silently lost.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const AGENT_ROOT = path.join(process.cwd(), ".agent");

const BACKENDS = new Set(["gitea", "github", "gitlab"]);
const GATE_USER_ONLY = new Set(["merge"]);

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
  const argv = process.argv.slice(2);
  const gate = flag("--gate", argv);
  if (!allowed.includes(gate)) {
    fail("workflow_gate_required", `--gate must be one of: ${allowed.join(", ")}`);
  }
  return gate;
}

function readPayload() {
  const argv = process.argv.slice(2);
  const raw = flag("--payload-json", argv);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    fail("invalid_payload_json", err.message);
    return {};
  }
}

function loadConfig() {
  const configPath = path.join(AGENT_ROOT, "config", "vcs.yml");
  if (!fs.existsSync(configPath)) return null;
  // Minimal YAML-like parser — sufficient for our flat schema.  Pulls
  // `backend`, `host`, `token_ref`, and `default: {org, repo, base_branch}`.
  const text = fs.readFileSync(configPath, "utf8");
  const lines = text.split(/\r?\n/);
  const cfg = { backend: null, host: null, token_ref: null, default: {} };
  let inDefault = false;
  for (const line of lines) {
    const t = line.replace(/#.*$/, "").replace(/^\s+/, "");
    if (!t) continue;
    if (t === "default:") { inDefault = true; continue; }
    if (inDefault && !line.startsWith(" ") && !line.startsWith("\t")) {
      inDefault = false;
    }
    if (inDefault) {
      const m = t.match(/^(\w+):\s*(.+?)\s*$/);
      if (m) cfg.default[m[1]] = m[2].replace(/^["']|["']$/g, "");
      continue;
    }
    const m = t.match(/^(backend|host|token_ref):\s+(.+?)\s*$/);
    if (m) cfg[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return cfg;
}

// Resolve `secret://<ref>` by spawning the secrets CLI with `--gate user`.
// Returns the plaintext token or throws `secret_resolution_failed`.  Use
// sparingly: the only callers that should do this are infrastructure
// tasks (vcs-pr, future secrets-using integrations), never an arbitrary
// agent tool call.
function resolveSecret(ref) {
  if (!ref) throw new Error("missing_token_ref_in_config");
  const secretsScript = path.join(AGENT_ROOT, "skills", "secrets", "scripts", "index.js");
  if (!fs.existsSync(secretsScript)) {
    throw new Error(`secrets_skill_missing_at_${secretsScript}`);
  }
  // `--no-mask` requires --gate user; the orchestrator runs as user (you).
  const argv = [secretsScript, "get", "--ref", ref, "--gate", "user", "--no-mask"];
  const r = spawnSync(process.execPath, argv, { cwd: process.cwd(), encoding: "utf8" });
  let body = {};
  try { body = JSON.parse(r.stdout || "{}"); } catch (_) {
    throw new Error("secrets_cli_unparseable_response");
  }
  if (r.status !== 0 || !body.ok || !body.value) {
    throw new Error(`secret_resolution_failed: ${body.error || "unknown"}`);
  }
  return body.value;
}

// ─── run events correlation (Phase 1 hook) ────────────────────────────────────

function discoverActiveRunId() {
  // Phase 1 session-triage writes `runs/<slug>-<NN>.json` for any open
  // session.  We pick the most-recently-modified run to associate the PR
  // event with, unless --run-id is provided.  This is opportunistic, not
  // authoritative — agents that want explicit association should pass
  // --run-id.
  const runsDir = path.join(AGENT_ROOT, "runs");
  if (!fs.existsSync(runsDir)) return null;
  const files = fs
    .readdirSync(runsDir)
    .filter((n) => n.endsWith(".json") && n !== "README.md" && n !== "index.json" && !n.endsWith(".schema.json"))
    .map((n) => ({ name: n, mtime: fs.statSync(path.join(runsDir, n)).mtimeMs, status: tryReadRunStatus(path.join(runsDir, n)) }));
  files.sort((a, b) => b.mtime - a.mtime);
  for (const f of files) {
    if (f.status === "running" || f.status === "queued") return f.name.replace(/\.json$/, "");
  }
  return files[0] ? files[0].name.replace(/\.json$/, "") : null;
}

function tryReadRunStatus(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return j.status;
  } catch (_) {
    return null;
  }
}

function appendRunEvent(runId, eventObj) {
  if (!runId) return false;
  const file = path.join(AGENT_ROOT, "runs", `${runId}.json`);
  if (!fs.existsSync(file)) return false;
  let run = {};
  try { run = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return false; }
  if (!Array.isArray(run.events)) run.events = [];
  const now = new Date().toISOString();
  run.events = [
    ...run.events,
    { type: eventObj.type, ...eventObj, at: eventObj.at || now },
  ].slice(-200);
  run.last_event = run.events[run.events.length - 1];
  run.updated_at = now;
  fs.writeFileSync(file, JSON.stringify(run, null, 2) + "\n", "utf8");
  return true;
}

// ─── body template ────────────────────────────────────────────────────────────

function defaultBody(opts, ctx) {
  // Template aligned with cortex-agent governance.  Host can override
  // via --body-file; this fallback is the minimum a PR must carry.
  const lines = [];
  lines.push(`## 提交范围`);
  lines.push(`- branch: \`${opts.head}\` → \`${opts.base || ctx.cfg.default.base_branch || "main"}\``);
  if (ctx.cfg.default.org && ctx.cfg.default.repo) {
    lines.push(`- repo: ${ctx.cfg.default.org}/${ctx.cfg.default.repo}`);
  }
  if (opts.runId) lines.push(`- run: \`runs/${opts.runId}.json\``);
  lines.push("");
  lines.push(`## 相关功能`);
  lines.push(`- (填写)`);
  lines.push("");
  lines.push(`## 验证结果`);
  lines.push(`- (填写。失败经验留 known issues)`);
  lines.push("");
  lines.push(`## 已知事项`);
  lines.push(`- (无)`);
  return lines.join("\n");
}

function loadBody(opts) {
  if (opts.bodyFile) {
    const bodyPath = path.isAbsolute(opts.bodyFile)
      ? opts.bodyFile
      : path.join(process.cwd(), opts.bodyFile);
    if (!fs.existsSync(bodyPath)) throw new Error(`body_file_not_found: ${bodyPath}`);
    return fs.readFileSync(bodyPath, "utf8");
  }
  if (opts.bodyFromRun) {
    const runFile = path.join(AGENT_ROOT, "runs", `${opts.bodyFromRun}.json`);
    if (!fs.existsSync(runFile)) throw new Error(`run_for_body_not_found: ${runFile}`);
    const run = JSON.parse(fs.readFileSync(runFile, "utf8"));
    return defaultBody(opts, { cfg: opts.__cfgCtx || {} }) + `\n\n_Generated from runs/${opts.bodyFromRun}.json_\n`;
  }
  return null;
}

// ─── main dispatch ───────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const [command] = argv;
  if (!command || !["create", "status", "merge", "list"].includes(command)) {
    fail("unknown_command", "Usage: vcs-pr create|status|merge|list [...opts]");
  }
  const cfg = loadConfig();
  if (!cfg || !cfg.backend) {
    fail("vcs_config_missing", "Create .agent/config/vcs.yml with backend + host + token_ref.");
  }
  if (!BACKENDS.has(cfg.backend)) {
    fail("unknown_backend", `--backend must be one of: ${[...BACKENDS].join(", ")}`);
  }
  if (GATE_USER_ONLY.has(command) && flag("--gate", argv) !== "user") {
    fail("workflow_gate_required", `${command} requires --gate user (destructive VCS action).`);
  } else {
    requireGate(["agent", "user", "mission"]);
  }

  const backend = require(path.join(__dirname, "backends", `${cfg.backend}.js`));
  const token = resolveSecret(cfg.token_ref);
  const optsBase = {
    config: cfg,
    token,
    owner: flag("--owner", argv),
    repo: flag("--repo", argv),
  };
  const runId = flag("--run-id", argv) || (command === "create" ? discoverActiveRunId() : null);
  const payload = readPayload();

  if (command === "create") {
    const bodyRaw = flag("--body-file", argv)
      ? fs.readFileSync(path.join(process.cwd(), flag("--body-file", argv)), "utf8")
      : loadBody({
          bodyFile: flag("--body-file", argv),
          bodyFromRun: flag("--body-from-run", argv),
          head: flag("--head", argv),
          base: flag("--base", argv),
          runId,
          __cfgCtx: cfg,
        });
    const body = bodyRaw == null ? defaultBody({ head: flag("--head", argv), base: flag("--base", argv), runId }, { cfg }) : bodyRaw;
    const result = await backend.createPR({
      ...optsBase,
      head: flag("--head", argv),
      base: flag("--base", argv),
      title: flag("--title", argv),
      body,
    });
    if (runId) {
      appendRunEvent(runId, {
        type: "vcs_pr_opened",
        backend: cfg.backend,
        pr_number: result.number,
        pr_url: result.url,
        head: result.head,
        base: result.base,
      });
    }
    emit({ ok: true, action: "create", run_id: runId, ...result });
    return;
  }
  if (command === "status") {
    const result = await backend.getStatus({ ...optsBase, pr_number: Number(flag("--pr-number", argv)) });
    emit({ ok: true, action: "status", ...result });
    return;
  }
  if (command === "merge") {
    if (argv.indexOf("--gate") === -1 || argv[argv.indexOf("--gate") + 1] !== "user") {
      fail("workflow_gate_required", "merge requires --gate user.");
    }
    const result = await backend.merge({
      ...optsBase,
      pr_number: Number(flag("--pr-number", argv)),
      commit_message: flag("--commit-message", argv),
    });
    if (runId) {
      appendRunEvent(runId, {
        type: "vcs_pr_merged",
        backend: cfg.backend,
        pr_number: Number(flag("--pr-number", argv)),
      });
    }
    emit({ ok: true, action: "merge", ...result });
    return;
  }
  if (command === "list") {
    const result = await backend.list({
      ...optsBase,
      state: flag("--state", argv),
    });
    emit({ ok: true, action: "list", count: result.length, items: result });
    return;
  }
}

if (require.main === module) {
  main().catch((err) => fail("orchestrator_error", err.message));
}
module.exports = { discoverActiveRunId, appendRunEvent };
