"use strict";

// Minimal sanity tests for lib/secret-scan.js. Run with:
//   node lib/secret-scan.test.js
// Exits 0 on success, non-zero on first failed assertion.

const assert = require("assert");
const { scanContent, scanFile, isHighSeverity, redact } = require("./secret-scan");

const cases = [
  // Negative cases
  { name: "empty content yields no findings", input: "", expect: 0 },
  { name: "plain prose", input: "hello world\nthis is a doc", expect: 0 },
  // PEM
  { name: "PEM RSA header", input: "-----BEGIN RSA PRIVATE KEY-----", expect: 1, rule: "private_key_header" },
  { name: "PEM OPENSSH header", input: "-----BEGIN OPENSSH PRIVATE KEY-----", expect: 1, rule: "private_key_header" },
  // Token prefixes
  { name: "GitHub PAT", input: "export TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", expect: 1, rule: "github_pat" },
  { name: "OpenAI sk-proj-", input: "sk-proj-Abc123_-abc123_abc12345", expect: 1, rule: "openai_project_key" },
  { name: "Anthropic sk-ant-", input: "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij", expect: 1, rule: "anthropic_key" },
  { name: "Slack xoxb-", input: "xoxb-1234567890-XXXXtestXXXX", expect: 1, rule: "slack_token" },
  { name: "AWS AKIA", input: "AKIAIOSFODNN7EXAMPLE", expect: 1, rule: "aws_access_key" },
  // URL userinfo
  { name: "URL userinfo", input: "fetch(\"https://user:pass@example.com/data\")", expect: 1, rule: "url_userinfo" },
  // Inline token assignment (already covered by env_assignment_token)
  { name: "inline api_key", input: "api_key = \"deadbeefdeadbeefdeadbeef\"", expect: 1, rule: "env_assignment_token" },
  // Local absolute path
  { name: "absolute user path", input: "see /Users/alice/work/notes.md for context", expect: 1, rule: "absolute_machine_path" },
  { name: "absolute home path", input: "wrote to /home/bob/.config/file", expect: 1, rule: "absolute_machine_path" },
  // False-positive guard: examples in docs that LOOK like tokens but aren't
  { name: "documentation example is fine", input: "use sk-XXXXX as a placeholder", expect: 0 },
  { name: "comment assignment is fine", input: "# api_key = \"this is in a comment line\"", expect: 0 },
];

let failures = 0;
for (const c of cases) {
  try {
    const findings = scanContent(c.input);
    if (findings.length !== c.expect) {
      throw new Error(`expected ${c.expect} finding(s), got ${findings.length}: ${JSON.stringify(findings)}`);
    }
    if (c.rule) {
      const ok = findings.some(f => f.rule_id === c.rule);
      if (!ok) throw new Error(`expected rule ${c.rule}, got ${JSON.stringify(findings.map(f=>f.rule_id))}`);
    }
    // Side-channel: never echo the raw matched value in the excerpt.
    for (const f of findings) {
      if (typeof f.excerpt === "string" && c.input.includes(f.excerpt) && f.excerpt.length > 8) {
        throw new Error(`excerpt leaks original value: ${f.excerpt}`);
      }
    }
    console.log(`  ✓ ${c.name}`);
  } catch (error) {
    failures += 1;
    console.error(`  ✗ ${c.name}: ${error.message}`);
  }
}

// Severity helper
assert.strictEqual(isHighSeverity("private_key_header"), true, "private_key_header should be high severity");
assert.strictEqual(isHighSeverity("url_userinfo"), false, "url_userinfo is medium");
assert.strictEqual(isHighSeverity("unknown"), false, "unknown rule id is medium by default");
console.log("  ✓ isHighSeverity sanity");

// redact helper
assert.strictEqual(redact("short"), "***", "short values fully redacted");
assert.strictEqual(redact("a".repeat(40)).length < 40, true, "long values redacted, not echoed");
console.log("  ✓ redact sanity");

if (failures > 0) {
  console.error(`\nFAIL: ${failures} test case(s) failed`);
  process.exit(1);
}
console.log(`\nPASS: ${cases.length + 2} checks`);