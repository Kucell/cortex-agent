#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SECTIONS = ["resource", "state_machine", "event_journal", "evidence", "write_gate", "query_projection", "consumer_surface"];
const SIGNALS = ["lifecycle", "persistent", "side_effects", "failure_or_recovery", "queried", "delivery_evidence"];
const EXEMPTIONS = ["synchronous", "side_effect_free", "non_persistent", "no_durable_identity_owner_event_evidence"];
const REQUIRED = {
  resource: ["stable_id", "schema", "owner", "relations"],
  state_machine: ["initial", "legal_transitions", "terminal", "failure", "recovery"],
  event_journal: ["append_only", "actor", "transition", "evidence_relations"],
  evidence: ["references", "redaction", "log_cursors"],
  write_gate: ["workflow", "owner_checks", "decision_gate", "waitpoint_gate"],
  query_projection: ["management_api", "read_only", "legacy_tolerant"],
  consumer_surface: ["consumers", "shared_projection"]
};

function parseArgs(argv) {
  const result = { mode: (argv[0] || "").toLowerCase() };
  for (let index = 1; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    result[argv[index].slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

function die(error, details, code = 2) {
  process.stdout.write(`${JSON.stringify({ ok: false, error, details })}\n`);
  process.exit(code);
}

function readJson(file) {
  if (!file) die("input_required", "Pass --input.");
  try { return JSON.parse(fs.readFileSync(path.resolve(file), "utf8")); }
  catch (error) { return die("invalid_input", error.message); }
}

function writeJson(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (!file) return process.stdout.write(text);
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text);
  fs.renameSync(temporary, target);
}

function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function present(value) { return value !== undefined && value !== null && value !== "" && (!Array.isArray(value) || value.length > 0); }
function unique(values) { return [...new Set(values)].sort(); }

function assess(input) {
  const characteristics = isObject(input.characteristics) ? input.characteristics : {};
  const exemption = isObject(input.exemption) ? input.exemption : {};
  const statefulSignals = SIGNALS.filter((key) => characteristics[key] === true);
  const unknownSignals = SIGNALS.filter((key) => characteristics[key] !== true && characteristics[key] !== false);
  const missingExemptions = EXEMPTIONS.filter((key) => exemption[key] !== true);
  const explicitExempt = statefulSignals.length === 0 && unknownSignals.length === 0 && missingExemptions.length === 0 && present(exemption.reason);
  return {
    type: "runtime_state_assessment",
    feature: input.feature || null,
    classification: explicitExempt ? "exempt" : "stateful",
    stateful_signals: statefulSignals,
    unknown_signals: unknownSignals,
    exemption_gaps: explicitExempt ? [] : unique([...missingExemptions, ...(present(exemption.reason) ? [] : ["reason"])]),
    fail_closed: !explicitExempt && statefulSignals.length === 0
  };
}

function checkContract(input) {
  const classification = input.classification || assess(input).classification;
  const gaps = [];
  if (!["stateful", "exempt"].includes(classification)) gaps.push("classification.invalid");
  if (classification === "exempt") {
    const assessment = assess(input);
    if (assessment.classification !== "exempt") gaps.push(...assessment.exemption_gaps.map((item) => `exemption.${item}`));
  } else {
    for (const section of SECTIONS) {
      const value = input.contract?.[section];
      if (!isObject(value)) { gaps.push(`contract.${section}`); continue; }
      for (const field of REQUIRED[section]) if (!present(value[field])) gaps.push(`contract.${section}.${field}`);
    }
    if (input.contract?.event_journal?.append_only !== true) gaps.push("contract.event_journal.append_only_true");
    if (input.contract?.query_projection?.read_only !== true) gaps.push("contract.query_projection.read_only_true");
    if (input.contract?.query_projection?.legacy_tolerant !== true) gaps.push("contract.query_projection.legacy_tolerant_true");
    if (input.contract?.consumer_surface?.shared_projection !== true) gaps.push("contract.consumer_surface.shared_projection_true");
    if (input.contract?.evidence?.redaction !== true) gaps.push("contract.evidence.redaction_true");
    if (input.contract?.cross_target_time_filtered_logs === true) {
      if (input.contract?.evidence?.target_side_timestamp !== true) gaps.push("contract.evidence.target_side_timestamp_true");
      if (input.contract?.evidence?.cursor_per_producer !== true) gaps.push("contract.evidence.cursor_per_producer_true");
    }
  }
  const blocking = unique(gaps);
  return { type: "runtime_state_contract_check", feature: input.feature || null, classification, status: blocking.length ? "FAIL" : "PASS", blocking_gaps: blocking, covered_sections: classification === "stateful" ? SECTIONS.filter((section) => isObject(input.contract?.[section])) : [] };
}

function create(input) {
  const assessment = assess(input);
  const classification = input.classification || assessment.classification;
  const contract = {};
  for (const section of SECTIONS) contract[section] = isObject(input.contract?.[section]) ? input.contract[section] : {};
  const result = { type: "runtime_state_integration_contract", version: 1, feature: input.feature || null, classification, characteristics: input.characteristics || {}, exemption: input.exemption || {}, contract };
  const checked = checkContract(result);
  return { ...result, status: checked.status, blocking_gaps: checked.blocking_gaps };
}

function summarize(input) {
  const checked = checkContract(input);
  const evidence = Array.isArray(input.contract?.evidence?.references) ? unique(input.contract.evidence.references) : [];
  const consumers = Array.isArray(input.contract?.consumer_surface?.consumers) ? unique(input.contract.consumer_surface.consumers) : [];
  return { type: "runtime_state_integration_summary", feature: input.feature || null, classification: checked.classification, status: checked.status, covered_sections: checked.covered_sections, blocking_gaps: checked.blocking_gaps, evidence_references: evidence, consumers };
}

const args = parseArgs(process.argv.slice(2));
const input = readJson(args.input);
let output;
if (args.mode === "assess") output = assess(input);
else if (args.mode === "create") output = create(input);
else if (args.mode === "check") output = checkContract(input);
else if (args.mode === "summarize") output = summarize(input);
else die("unknown_mode", args.mode || null);
writeJson(args.output, output);
if (args.mode === "check" && output.status === "FAIL") process.exitCode = 1;
