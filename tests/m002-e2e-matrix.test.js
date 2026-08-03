"use strict";

// ─── M-002 E2E Test Matrix (MS-004) ────────────────────────────────────────────
//
// Coverage: full general-mode E2E flow per M-002 mission-plan §5
//   init --mode general → memory write → recall → agent discover → invoke → handoff
//
// This test matrix exercises the 4 general workflows end-to-end against
// `bin/cli.js` (no mock layers). Skipped when templates/_base/.agent/ is
// missing (e.g., pre-MS-001 state).
//
// Per D-002-3 / D-002-4: agent discover/invoke = M-002 scope; report/launch
// = M-008 scope. This matrix tests the M-002 side only.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const CLI = path.join(repoRoot, "bin", "cli.js");

const BASE_TEMPLATES = path.join(repoRoot, "templates", "_base", ".agent");
const GENERAL_TEMPLATES = path.join(repoRoot, "templates", "general", ".agent");

const skipIfMissingBase = !fs.existsSync(BASE_TEMPLATES)
  && "templates/_base/.agent missing — MS-001 not yet merged";
const skipIfMissingGeneral = !fs.existsSync(GENERAL_TEMPLATES)
  && "templates/general/.agent missing — MS-001 templates not yet merged";

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(cwd, args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LANG: "en_US.UTF-8", ...env },
  });
}

const EXPECTED_BASE_DIRS = [
  "inbox", "decisions", "runs", "sessions", "missions",
  "conversations", "memory", "agents", "tasks", "waitpoints", "handoffs",
];

const EXPECTED_GENERAL_SUBDIRS = [
  "workflows", "skills", "sub-agents", "domains", "prompts", "config",
];

const EXPECTED_WORKFLOWS = [
  "memory-recall.md",
  "memory-distill.md",
  "agent-discover.md",
  "agent-invoke.md",
];

// ─── Section 1: init --mode general extension ────────────────────────────────

test("MS-004: init --mode general copies both _base + general template layers", {
  skip: skipIfMissingBase || skipIfMissingGeneral,
}, () => {
  const dir = mkTmp("m002-ms004-init-");
  try {
    const result = runCli(dir, ["init", "--mode", "general"]);
    assert.equal(result.status, 0, `cli exit=${result.status}\nstderr=${result.stderr}`);

    // _base data layer (already verified by MS-002; re-verified here for completeness)
    for (const sub of EXPECTED_BASE_DIRS) {
      const target = path.join(dir, ".agent", sub);
      assert.ok(
        fs.existsSync(target) && fs.statSync(target).isDirectory(),
        `expected data dir ${sub} at ${target}`,
      );
    }

    // general template layer (new in MS-004)
    const generalDir = path.join(dir, ".agent", "general");
    assert.ok(
      fs.existsSync(generalDir) && fs.statSync(generalDir).isDirectory(),
      `expected general template layer at ${generalDir}`,
    );
    for (const sub of EXPECTED_GENERAL_SUBDIRS) {
      const target = path.join(generalDir, sub);
      assert.ok(
        fs.existsSync(target) && fs.statSync(target).isDirectory(),
        `expected general subdir ${sub} at ${target}`,
      );
    }

    // 4 general workflow files (per workflow contracts)
    for (const wf of EXPECTED_WORKFLOWS) {
      const target = path.join(generalDir, "workflows", wf);
      assert.ok(
        fs.existsSync(target),
        `expected workflow file ${wf} at ${target}`,
      );
    }
  } finally {
    rmrf(dir);
  }
});

test("MS-004: init --mode general is additive — pre-existing .agent/ contents preserved", {
  skip: skipIfMissingBase || skipIfMissingGeneral,
}, () => {
  const dir = mkTmp("m002-ms004-init-additive-");
  try {
    // Pre-create .agent/inbox with a marker file to verify it's preserved
    const inboxDir = path.join(dir, ".agent", "inbox");
    fs.mkdirSync(inboxDir, { recursive: true });
    const marker = path.join(inboxDir, "USER-MARKER.json");
    fs.writeFileSync(marker, JSON.stringify({ pre: "existing" }));

    const result = runCli(dir, ["init", "--mode", "general"]);
    assert.equal(result.status, 0, `cli exit=${result.status}\nstderr=${result.stderr}`);
    assert.ok(fs.existsSync(marker), "pre-existing marker file must be preserved (additive copy)");
    assert.deepEqual(
      JSON.parse(fs.readFileSync(marker, "utf8")),
      { pre: "existing" },
      "pre-existing file content must be preserved",
    );
  } finally {
    rmrf(dir);
  }
});

// ─── Section 2: E2E flow — init → memory distill → memory recall ─────────────

test("MS-004 E2E: init → memory distill → memory recall returns the distilled entry", {
  skip: skipIfMissingBase || skipIfMissingGeneral,
}, () => {
  const dir = mkTmp("m002-ms004-e2e-memory-");
  try {
    // Step 1: init
    const initResult = runCli(dir, ["init", "--mode", "general"]);
    assert.equal(initResult.status, 0, `init failed: ${initResult.stderr}`);

    // Step 2: write a candidates file for memory distill
    const candsFile = path.join(dir, "cands.json");
    fs.writeFileSync(
      candsFile,
      JSON.stringify([
        {
          type: "semantic",
          content: "Eric prefers concrete recommendations over pure menus",
          title: "Eric decision style",
          tags: ["user-preference", "decision-style"],
          confidence: 0.95,
        },
        {
          type: "episodic",
          content: "User asked to ship v1.10.0 release on 2026-08-01",
          title: "v1.10.0 release shipped",
          tags: ["release", "v1.10.0"],
          confidence: 0.85,
        },
      ]),
    );

    // Step 3: memory distill
    const distillResult = runCli(dir, [
      "memory", "distill",
      "--project", dir,
      "--candidates", candsFile,
      "--output", "json",
    ]);
    assert.equal(distillResult.status, 0, `distill exit=${distillResult.status}\nstderr=${distillResult.stderr}`);
    const distillJson = JSON.parse(distillResult.stdout);
    assert.equal(distillJson.error, null);
    assert.equal(distillJson.written.length, 2);

    // Verify memory files written
    const semanticDir = path.join(dir, ".agent", "memory", "semantic");
    const episodicDir = path.join(dir, ".agent", "memory", "episodic");
    assert.ok(fs.existsSync(semanticDir), "semantic/ should exist");
    assert.ok(fs.existsSync(episodicDir), "episodic/ should exist");
    const semanticFiles = fs.readdirSync(semanticDir).filter((f) => f.endsWith(".json"));
    const episodicFiles = fs.readdirSync(episodicDir).filter((f) => f.endsWith(".json"));
    assert.equal(semanticFiles.length, 1);
    assert.equal(episodicFiles.length, 1);

    // Step 4: memory recall with query
    const recallResult = runCli(dir, [
      "memory", "recall", "decision style",
      "--project", dir,
      "--output", "json",
    ]);
    assert.equal(recallResult.status, 0, `recall exit=${recallResult.status}\nstderr=${recallResult.stderr}`);
    const recallJson = JSON.parse(recallResult.stdout);
    // 2 candidates seeded; both should be returned (top-K limit defaults to 5).
    // Top result is the semantic one (matches "decision-style" tag + "decision style" content).
    assert.equal(recallJson.returned, 2);
    assert.match(recallJson.memories[0].content, /Eric prefers concrete recommendations/);
    assert.equal(recallJson.memories[0].type, "semantic");
  } finally {
    rmrf(dir);
  }
});

// ─── Section 3: E2E flow — agent discover + agent invoke (M-002 scope) ──────

test("MS-004 E2E: init → agent seed → agent discover finds the seeded agent", {
  skip: skipIfMissingBase || skipIfMissingGeneral,
}, () => {
  const dir = mkTmp("m002-ms004-e2e-agent-discover-");
  try {
    const initResult = runCli(dir, ["init", "--mode", "general"]);
    assert.equal(initResult.status, 0);

    // Seed an agent entry directly (no `agent register` CLI in MS-003 — this
    // would be a future CLI; for MS-004 E2E we use the registry file directly).
    const agentFile = path.join(dir, ".agent", "agents", "test-agent-001.json");
    fs.mkdirSync(path.dirname(agentFile), { recursive: true });
    fs.writeFileSync(
      agentFile,
      JSON.stringify({
        schema_version: 1,
        agent_id: "test-agent-001",
        role: "implementer",
        model: "MiniMax-M3",
        started_at: "2026-08-03T10:00:00.000Z",
        last_heartbeat: "2026-08-03T11:00:00.000Z",
        status: "running",
        capabilities: ["schema_design", "json_schema"],
        external: null,
      }),
    );

    const discoverResult = runCli(dir, [
      "agent", "discover",
      "--project", dir,
      "--capability", "schema_design",
      "--output", "json",
    ]);
    assert.equal(discoverResult.status, 0, `discover exit=${discoverResult.status}\nstderr=${discoverResult.stderr}`);
    const discoverJson = JSON.parse(discoverResult.stdout);
    // Init copies templates/_base/.agent/agents/sample.json (Worker-A-MS001)
    // which also has schema_design capability. So we expect ≥ 1, including our
    // seeded test-agent-001. Verify the seed is in the returned list.
    assert.ok(discoverJson.returned >= 1, `expected ≥1, got ${discoverJson.returned}`);
    const seeded = discoverJson.agents.find((a) => a.agent_id === "test-agent-001");
    assert.ok(seeded, "seeded test-agent-001 must be in the discover results");
    assert.deepEqual(seeded.capabilities, ["schema_design", "json_schema"]);
  } finally {
    rmrf(dir);
  }
});

test("MS-004 E2E: init → agent seed → agent invoke returns plan + writes journal", {
  skip: skipIfMissingBase || skipIfMissingGeneral,
}, () => {
  const dir = mkTmp("m002-ms004-e2e-agent-invoke-");
  try {
    const initResult = runCli(dir, ["init", "--mode", "general"]);
    assert.equal(initResult.status, 0);

    const agentFile = path.join(dir, ".agent", "agents", "codex-bot.json");
    fs.mkdirSync(path.dirname(agentFile), { recursive: true });
    fs.writeFileSync(
      agentFile,
      JSON.stringify({
        schema_version: 1,
        agent_id: "codex-bot",
        role: "external",
        model: "codex-gpt-5",
        started_at: "2026-08-03T10:00:00.000Z",
        status: "running",
        capabilities: ["code_review", "testing"],
        external: {
          adapter_type: "codex",
          config_ref: "configs/codex.yaml",
          credential_ref: "secret://openai",
        },
      }),
    );

    const invokeResult = runCli(dir, [
      "agent", "invoke", "codex-bot", "review my PR",
      "--project", dir,
      "--capability", "code_review",
      "--output", "json",
    ]);
    assert.equal(invokeResult.status, 0, `invoke exit=${invokeResult.status}\nstderr=${invokeResult.stderr}`);
    const invokeJson = JSON.parse(invokeResult.stdout);
    assert.equal(invokeJson.status, "planned");
    assert.equal(invokeJson.plan.kind, "external_dispatch");
    assert.equal(invokeJson.plan.entry_point.adapter_type, "codex");

    // Verify run journal
    const resultFile = path.join(dir, ".agent", "runs", invokeJson.run_id, "result.json");
    const rollbackFile = path.join(dir, ".agent", "runs", invokeJson.run_id, "rollback.json");
    assert.ok(fs.existsSync(resultFile), `result.json must exist at ${resultFile}`);
    assert.ok(fs.existsSync(rollbackFile), `rollback.json must exist at ${rollbackFile}`);
    const rollback = JSON.parse(fs.readFileSync(rollbackFile, "utf8"));
    assert.equal(rollback.status, "not_applicable");
  } finally {
    rmrf(dir);
  }
});

test("MS-004 E2E: agent invoke with capability mismatch exits 3 + writes error.json", {
  skip: skipIfMissingBase || skipIfMissingGeneral,
}, () => {
  const dir = mkTmp("m002-ms004-e2e-agent-mismatch-");
  try {
    const initResult = runCli(dir, ["init", "--mode", "general"]);
    assert.equal(initResult.status, 0);

    const agentFile = path.join(dir, ".agent", "agents", "limited-agent.json");
    fs.mkdirSync(path.dirname(agentFile), { recursive: true });
    fs.writeFileSync(
      agentFile,
      JSON.stringify({
        schema_version: 1,
        agent_id: "limited-agent",
        role: "implementer",
        model: "MiniMax-M3",
        started_at: "2026-08-03T10:00:00.000Z",
        status: "running",
        capabilities: ["schema_design"],
        external: null,
      }),
    );

    const invokeResult = runCli(dir, [
      "agent", "invoke", "limited-agent", "do X",
      "--project", dir,
      "--capability", "vision",
      "--output", "json",
    ]);
    assert.equal(invokeResult.status, 3);
    const invokeJson = JSON.parse(invokeResult.stdout);
    assert.equal(invokeJson.error.code, "ERR_CAPABILITY_MISMATCH");
    const errorFile = path.join(dir, ".agent", "runs", invokeJson.run_id, "error.json");
    assert.ok(fs.existsSync(errorFile));
  } finally {
    rmrf(dir);
  }
});

// ─── Section 4: full E2E matrix (init → memory → recall → agent discover → agent invoke) ─

test("MS-004 E2E: full matrix — init general, seed memory + agent, verify cross-flow", {
  skip: skipIfMissingBase || skipIfMissingGeneral,
}, () => {
  const dir = mkTmp("m002-ms004-e2e-full-matrix-");
  try {
    // Step 1: init --mode general
    let result = runCli(dir, ["init", "--mode", "general"]);
    assert.equal(result.status, 0, `init: ${result.stderr}`);

    // Step 2: seed memory
    const cands = path.join(dir, "cands.json");
    fs.writeFileSync(cands, JSON.stringify([
      {
        type: "semantic",
        content: "Codex bot has code_review capability and external adapter",
        tags: ["codex", "code_review"],
        confidence: 0.9,
      },
    ]));
    result = runCli(dir, ["memory", "distill", "--project", dir, "--candidates", cands]);
    assert.equal(result.status, 0, `distill: ${result.stderr}`);

    // Step 3: seed agent
    const agentFile = path.join(dir, ".agent", "agents", "codex-bot.json");
    fs.writeFileSync(
      agentFile,
      JSON.stringify({
        schema_version: 1,
        agent_id: "codex-bot",
        role: "external",
        model: "codex-gpt-5",
        started_at: "2026-08-03T10:00:00.000Z",
        status: "running",
        capabilities: ["code_review", "codex"],
        external: { adapter_type: "codex", config_ref: "c", credential_ref: "k" },
      }),
    );

    // Step 4: agent discover finds codex-bot
    result = runCli(dir, [
      "agent", "discover",
      "--project", dir,
      "--capability", "code_review",
      "--output", "json",
    ]);
    assert.equal(result.status, 0);
    const discoverJson = JSON.parse(result.stdout);
    assert.equal(discoverJson.agents.length, 1);
    assert.equal(discoverJson.agents[0].agent_id, "codex-bot");

    // Step 5: agent invoke produces plan
    result = runCli(dir, [
      "agent", "invoke", "codex-bot", "review my PR",
      "--project", dir,
      "--capability", "code_review",
      "--output", "json",
    ]);
    assert.equal(result.status, 0);
    const invokeJson = JSON.parse(result.stdout);
    assert.equal(invokeJson.status, "planned");
    assert.equal(invokeJson.plan.entry_point.adapter_type, "codex");

    // Step 6: memory recall still works (cross-section)
    result = runCli(dir, [
      "memory", "recall", "codex",
      "--project", dir,
      "--output", "json",
    ]);
    assert.equal(result.status, 0);
    const recallJson = JSON.parse(result.stdout);
    assert.ok(recallJson.returned >= 1);
  } finally {
    rmrf(dir);
  }
});
