"use strict";

const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "../..");
const sharedIndex = require(path.join(root, "templates/_shared/.agent/skills/secrets/scripts/index.js"));
const englishIndex = require(path.join(root, "templates/en/.agent/skills/secrets/scripts/index.js"));

for (const [name, skill] of [["shared", sharedIndex], ["english", englishIndex]]) {
  test(`${name} secrets template exposes Windows DPAPI without Git Bash`, () => {
    assert.equal(skill.BACKENDS.has("win-dpapi"), true);
    assert.equal(skill.defaultBackend("win32"), "win-dpapi");
    assert.equal(skill.defaultBackend("darwin"), "keychain");
    const unsupported = skill.backendInvocation("win-dpapi", "darwin");
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.error, "backend_platform_unsupported");
    const supported = skill.backendInvocation("win-dpapi", "win32");
    assert.equal(supported.ok, true);
    assert.equal(supported.command, "powershell.exe");
    assert.deepEqual(supported.args.slice(0, 5), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]);
  });
}

test("Windows DPAPI backend reads the payload from stdin", () => {
  for (const template of ["_shared", "en"]) {
    const file = path.join(root, `templates/${template}/.agent/skills/secrets/scripts/backends/win-dpapi.ps1`);
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /\[Console\]::In\.ReadToEnd\(\)/);
    assert.match(source, /ConvertFrom-SecureString/);
    assert.match(source, /ConvertTo-SecureString/);
  }
});
