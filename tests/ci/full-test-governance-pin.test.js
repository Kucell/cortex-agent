"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");
const test = require("node:test");

const workflow = fs.readFileSync(path.resolve(__dirname, "../../.github/workflows/full-test.yml"), "utf8");
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

// Execute the actual workflow blocks, so regressions cannot hide in a copied implementation.
function runBlock(name) {
  const step = workflow.split(`      - name: ${name}\n`)[1];
  assert.ok(step, `Missing workflow step: ${name}`);
  const match = step.split(/\n      - /)[0].match(/        run: \|\n((?:          .*\n|\n)+)/);
  assert.ok(match, `Missing shell block: ${name}`);
  return match[1].split("\n").map((line) => line.slice(10)).join("\n");
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "governance-pin-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin");
  const product = path.join(root, "product");
  const bin = path.join(root, "bin");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file" };
  for (const key of Object.keys(env)) {
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(key)) delete env[key];
  }
  function git(cwd, ...args) {
    return execFileSync(realGit, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  }
  for (const dir of [origin, product, bin]) fs.mkdirSync(dir);
  git(origin, "init", "-q", "-b", "main");
  fs.mkdirSync(path.join(origin, "rules"));
  fs.writeFileSync(path.join(origin, "rules/example.md"), "fixture\n");
  git(origin, "add", ".");
  git(origin, "commit", "-qm", "pinned governance");
  const pin = git(origin, "rev-parse", "HEAD");
  git(origin, "commit", "--allow-empty", "-qm", "newer main");
  const main = git(origin, "rev-parse", "HEAD");
  git(product, "init", "-q");
  function setPin(value) {
    git(product, "update-index", "--add", "--cacheinfo", `160000,${value},.agent`);
    git(product, "commit", "-qm", "product governance pin");
  }
  setPin(pin);
  // Only remote routing and the requested fault are intercepted; all Git object operations are real.
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/bash
set -euo pipefail
if [[ "$*" == *"remote add origin"* ]]; then
  exec "$REAL_GIT" -C .agent remote add origin "$FIXTURE_ORIGIN"
fi
if [[ "$*" == *"fetch -q --depth 1 origin"* && "\${FAIL_DIRECT:-}" == 1 ]]; then
  echo direct-fetch-rejected >&2
  exit 1
fi
exec "$REAL_GIT" "$@"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "pnpm"), '#!/bin/bash\nprintf "%s\\n" "$*" > "$TEST_MARKER"\n', { mode: 0o755 });
  const marker = path.join(root, "tests-ran");
  Object.assign(env, { PATH: `${bin}${path.delimiter}${env.PATH}`, REAL_GIT: realGit,
    FIXTURE_ORIGIN: `file://${origin}`, TEST_MARKER: marker, CORTEX_GOVERNANCE_READ_TOKEN: "fixture-only" });
  function run(name, extra = {}) {
    return spawnSync("bash", ["-e", "-o", "pipefail", "-c", runBlock(name)], {
      cwd: product, env: { ...env, ...extra }, encoding: "utf8", timeout: 10000,
    });
  }
  return { product, git, pin, main, marker, setPin, run };
}

const fetchStep = "Fetch .agent governance repo at gitlink pin";
const testStep = "Run full test suite";

for (const failDirect of [false, true]) {
  test(`checks out exact pin when ${failDirect ? "direct fetch fails but main contains it" : "direct fetch succeeds"}`, (t) => {
    const f = fixture(t);
    const result = f.run(fetchStep, { FAIL_DIRECT: failDirect ? "1" : "0" });
    assert.equal(result.status, 0, result.stderr);
    if (failDirect) assert.match(result.stderr, /direct-fetch-rejected/);
    assert.notEqual(f.pin, f.main);
    assert.equal(f.git(path.join(f.product, ".agent"), "rev-parse", "HEAD"), f.pin);
    const tested = f.run(testStep);
    assert.equal(tested.status, 0, tested.stderr);
    assert.equal(fs.readFileSync(f.marker, "utf8"), "test:ci\n");
  });
}

test("missing pin fails even though fallback main is available", (t) => {
  const f = fixture(t);
  f.setPin("a".repeat(40));
  const result = f.run(fetchStep);
  assert.notEqual(result.status, 0);
  const governance = path.join(f.product, ".agent");
  assert.equal(f.git(governance, "rev-parse", "FETCH_HEAD"), f.main);
  assert.equal(fs.existsSync(f.marker), false);
  // Even an accidentally continued test step must fail closed.
  assert.notEqual(f.run(testStep).status, 0);
  assert.equal(fs.existsSync(f.marker), false);
});

test("governance HEAD changed after checkout prevents test execution", (t) => {
  const f = fixture(t);
  assert.equal(f.run(fetchStep, { FAIL_DIRECT: "1" }).status, 0);
  f.git(path.join(f.product, ".agent"), "checkout", "-q", "--detach", f.main);
  const result = f.run(testStep);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /does not match gitlink pin/);
  assert.equal(fs.existsSync(f.marker), false);
});
