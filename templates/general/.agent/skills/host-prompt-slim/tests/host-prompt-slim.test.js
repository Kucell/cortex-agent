// ─── host-prompt-slim unit tests (node --test, zero deps) ─────────────────────
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SKILL = path.join(__dirname, "..");
const hp = require(path.join(SKILL, "scripts", "index.js"));
const rules = require(path.join(SKILL, "scripts", "rules.js"));

const OFFICIAL = `You are Codex, an agent based on GPT-5. You and the user share one workspace, and your job is to collaborate with them until their goal is genuinely handled.

# Personality

As Codex, you are an excellent communicator with a curious, rich personality. You match the tone and understanding of the user, making conversation flow easily.

You have tastes, preferences, and your own way of seeing the world. When the user is talking to you, they should feel that they are in contact with another subjectivity.

## Writing style

Avoid over-formatting responses. Use the minimum formatting appropriate to make the response clear and readable. You are a delightful writer.

# Working with the user

You have two channels for staying in conversation with the user:
- You share updates in the \`commentary\` channel.
- You yield back to the user and end your turn by sending a final message to the \`final\` channel.

Messages to users in the commentary channel are only for partial updates. The final answer must always be fully self-contained.

# Using skills

A skill is a set of instructions provided through a \`SKILL.md\` source. The main agent must read its SKILL.md completely before taking task actions.`;

test("tokenize: cjk-heavy and latin text", () => {
  assert.strictEqual(hp.tokenize("hello world"), 3); // 11 chars /4 → 2.75 → 3
  assert.strictEqual(hp.tokenize("你好世界"), 3); // 4 cjk /1.5 → 2.67 → 3
  assert.strictEqual(hp.tokenize(""), 0);
});

test("segment: splits on headings, keeps preamble", () => {
  const segs = hp.segment(OFFICIAL);
  const headings = segs.map((s) => s.heading);
  assert.ok(headings.includes("Personality"));
  assert.ok(headings.includes("Working with the user"));
  assert.ok(headings.includes("Using skills"));
  assert.strictEqual(segs[0].heading, ""); // preamble
  assert.strictEqual(segs[0].preamble, true);
});

test("classifyTitle: drop/keep/trim mapping", () => {
  assert.strictEqual(rules.classifyTitle("Personality"), "drop");
  assert.strictEqual(rules.classifyTitle("Writing style"), "trim");
  assert.strictEqual(rules.classifyTitle("Working with the user"), "keep");
  assert.strictEqual(rules.classifyTitle("Using skills"), "keep");
  assert.strictEqual(rules.classifyTitle("Engineering judgment"), "keep");
  assert.strictEqual(rules.classifyTitle("Editing constraints"), "keep");
  assert.strictEqual(rules.classifyTitle("Special user requests"), "keep");
  assert.strictEqual(rules.classifyTitle("Intermediary updates"), "keep");
  assert.strictEqual(rules.classifyTitle("Design instructions"), "trim");
  assert.strictEqual(rules.classifyTitle("Frontend guidance"), "trim");
  assert.strictEqual(rules.classifyTitle("Unknown future section"), "keep"); // conservative
});

test("isRuleSentence: rule verbs kept, fluff dropped", () => {
  assert.strictEqual(rules.isRuleSentence("Avoid over-formatting responses."), true);
  assert.strictEqual(rules.isRuleSentence("You are a delightful writer."), false);
  assert.strictEqual(rules.isRuleSentence("Backticks and `$()` will still execute."), true);
});

test("slimPrompt: persona dropped, protocols kept, savings material", () => {
  const before = hp.tokenize(OFFICIAL);
  const { text, report } = hp.slimPrompt(OFFICIAL);
  const after = hp.tokenize(text);
  assert.ok(after < before, `expected savings, got ${before} -> ${after}`);
  assert.ok(text.includes("You are Codex"), "identity preamble must survive");
  assert.ok(text.includes("commentary"), "runtime protocol must survive");
  assert.ok(text.includes("SKILL.md"), "skills protocol must survive");
  assert.ok(!text.includes("curious, rich personality"), "persona must be dropped");
  assert.ok(!text.includes("another subjectivity"), "persona must be dropped");
  const actions = report.map((r) => r.action);
  assert.ok(actions.includes("drop"));
  assert.ok(actions.includes("keep"));
});

test("enumerateModels: array, models-key, object-map, nested", () => {
  assert.strictEqual(hp.enumerateModels([{ slug: "a" }, { slug: "b" }]).length, 2);
  assert.strictEqual(hp.enumerateModels({ models: [{ slug: "a" }] }).length, 1);
  assert.strictEqual(hp.enumerateModels({ a: { slug: "a" } }).length, 1);
  assert.strictEqual(hp.enumerateModels({ provider: { models: [{ slug: "x" }] } }).length, 1);
});

test("detectPromptFields: nested + length filter", () => {
  const entry = {
    base_instructions: "x".repeat(200),
    model_messages: { instructions_template: "y".repeat(100) },
    prompt: "short", // < 50 chars → skipped
  };
  const fields = hp.detectPromptFields(entry);
  assert.ok(fields.includes("base_instructions"));
  assert.ok(fields.includes("model_messages.instructions_template"));
  assert.ok(!fields.includes("prompt"));
});

test("backup + atomicWrite + verifyJson + rollback round trip", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hps-"));
  const cat = path.join(dir, "catalog.json");
  const original = JSON.stringify({ models: [{ slug: "m", base_instructions: OFFICIAL }] }, null, 2);
  fs.writeFileSync(cat, original);

  // verify
  assert.ok(hp.verifyJson(cat).models.length === 1);

  // backup + apply slimming via cmdSlim --yes
  hp.cmdSlim(cat, "m", null, true);
  const applied = JSON.parse(fs.readFileSync(cat, "utf8"));
  assert.ok(hp.tokenize(applied.models[0].base_instructions) < hp.tokenize(OFFICIAL));
  assert.strictEqual(applied.models[0].slug, "m");

  // rollback restores original bytes
  const rb = hp.rollback(cat);
  assert.strictEqual(rb.ok, true);
  assert.strictEqual(fs.readFileSync(cat, "utf8"), original);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("cmdSlim --yes leaves non-target models byte-identical", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hps-"));
  const cat = path.join(dir, "catalog.json");
  const other = JSON.stringify({ slug: "luna", base_instructions: "L".repeat(300) });
  const original = JSON.stringify({ models: [{ slug: "terra", base_instructions: OFFICIAL }, JSON.parse(other)] }, null, 2);
  fs.writeFileSync(cat, original);

  hp.cmdSlim(cat, "terra", null, true);
  const after = JSON.parse(fs.readFileSync(cat, "utf8"));
  assert.strictEqual(after.models[0].slug, "terra");
  assert.strictEqual(after.models[1].slug, "luna");
  assert.strictEqual(after.models[1].base_instructions, "L".repeat(300)); // untouched
  // slugs/count intact
  assert.strictEqual(after.models.length, 2);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("dry-run does not write", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hps-"));
  const cat = path.join(dir, "catalog.json");
  fs.writeFileSync(cat, JSON.stringify({ models: [{ slug: "m", base_instructions: OFFICIAL }] }));
  const before = fs.readFileSync(cat, "utf8");
  const res = hp.cmdSlim(cat, "m", null, false);
  assert.strictEqual(res.dry_run, true);
  assert.strictEqual(fs.readFileSync(cat, "utf8"), before);
  assert.strictEqual(fs.readdirSync(dir).filter((f) => f.includes("bak-slim")).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
