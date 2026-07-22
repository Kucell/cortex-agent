#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function fail(error, details, code = 1) {
  process.stdout.write(`${JSON.stringify({ ok: false, error, details })}\n`);
  process.exit(code);
}

function options(argv) {
  const result = { command: argv[0] };
  for (let index = 1; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    result[argv[index].slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

function readInput(file) {
  if (!file) fail("input_required", "Pass --input.", 2);
  try {
    return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  } catch (error) {
    fail("invalid_input", error.message, 2);
  }
}

function required(value, fields, context) {
  const missing = fields.filter((field) => value[field] === undefined || value[field] === null || value[field] === "");
  if (missing.length) fail("missing_fields", { context, fields: missing }, 2);
}

function strings(values) {
  return Array.from(new Set(values || [])).sort();
}

function guidedReview(input) {
  required(input, ["artifact_id", "task_id", "run_id", "session_id", "workspace_ids", "base_revision", "head_revision", "groups", "generated_at"], "review");
  if (!Array.isArray(input.groups) || !input.groups.length) fail("groups_required", "At least one group is required.", 2);
  const groups = input.groups.map((group) => {
    required(group, ["group_id", "title", "intent", "files", "summary", "impact", "risk", "validation_refs", "follow_ups"], "review_group");
    if (!Array.isArray(group.files) || !group.files.length) fail("files_required", group.group_id, 2);
    return { ...group, files: strings(group.files), validation_refs: strings(group.validation_refs), follow_ups: strings(group.follow_ups) };
  }).sort((left, right) => left.group_id.localeCompare(right.group_id));
  const riskCounts = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const group of groups) {
    if (!(group.risk in riskCounts)) fail("invalid_risk", group.risk, 2);
    riskCounts[group.risk] += 1;
  }
  return {
    type: "guided_review",
    artifact_id: input.artifact_id,
    task_id: input.task_id,
    run_id: input.run_id,
    session_id: input.session_id,
    workspace_ids: strings(input.workspace_ids),
    base_revision: input.base_revision,
    head_revision: input.head_revision,
    groups,
    summary: {
      group_count: groups.length,
      file_count: new Set(groups.flatMap((group) => group.files)).size,
      risk_counts: riskCounts,
      validation_ref_count: new Set(groups.flatMap((group) => group.validation_refs)).size,
      follow_up_count: new Set(groups.flatMap((group) => group.follow_ups)).size
    },
    generated_at: input.generated_at
  };
}

function benchmark(input) {
  required(input, ["dataset_id", "dataset_version", "generated_at", "cases"], "benchmark");
  if (!Array.isArray(input.cases) || !input.cases.length) fail("cases_required", "At least one case is required.", 2);
  const totals = new Map();
  const cases = [...input.cases].sort((left, right) => left.case_id.localeCompare(right.case_id));
  for (const item of cases) {
    required(item, ["case_id", "weight", "runs"], "benchmark_case");
    if (!Number.isInteger(item.weight) || item.weight < 1) fail("invalid_weight", item.case_id, 2);
    for (const run of [...item.runs].sort((left, right) => left.candidate_id.localeCompare(right.candidate_id))) {
      required(run, ["candidate_id", "passed_assertions", "total_assertions", "cost_microunits", "duration_ms", "evidence_refs"], "benchmark_run");
      if (![run.passed_assertions, run.total_assertions, run.cost_microunits, run.duration_ms].every(Number.isInteger)) fail("integer_metrics_required", run.candidate_id, 2);
      if (run.total_assertions < 1 || run.passed_assertions < 0 || run.passed_assertions > run.total_assertions) fail("invalid_assertions", run.candidate_id, 2);
      if (run.cost_microunits < 0 || run.duration_ms < 0) fail("invalid_metric", run.candidate_id, 2);
      const current = totals.get(run.candidate_id) || { candidate_id: run.candidate_id, weightedPassed: 0, weightedTotal: 0, passed: 0, total: 0, cost: 0, duration: 0, results: [], refs: [] };
      current.weightedPassed += run.passed_assertions * item.weight;
      current.weightedTotal += run.total_assertions * item.weight;
      current.passed += run.passed_assertions;
      current.total += run.total_assertions;
      current.cost += run.cost_microunits;
      current.duration += run.duration_ms;
      current.results.push({ case_id: item.case_id, weight: item.weight, passed_assertions: run.passed_assertions, total_assertions: run.total_assertions });
      current.refs.push(...run.evidence_refs);
      totals.set(run.candidate_id, current);
    }
  }
  const candidates = [...totals.values()].sort((left, right) => left.candidate_id.localeCompare(right.candidate_id)).map((item) => ({
    candidate_id: item.candidate_id,
    quality_basis_points: Math.floor((item.weightedPassed * 10000) / item.weightedTotal),
    passed_assertions: item.passed,
    total_assertions: item.total,
    cost_microunits: item.cost,
    duration_ms: item.duration,
    case_results: item.results,
    evidence_refs: strings(item.refs)
  }));
  return { type: "agent_benchmark_summary", dataset_id: input.dataset_id, dataset_version: input.dataset_version, generated_at: input.generated_at, case_count: cases.length, candidates };
}

function writeOutput(file, value) {
  if (!file) fail("output_required", "Pass --output.", 2);
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, target);
}

function main() {
  const args = options(process.argv.slice(2));
  const input = readInput(args.input);
  const output = args.command === "review" ? guidedReview(input) : args.command === "benchmark" ? benchmark(input) : fail("unknown_command", args.command, 2);
  writeOutput(args.output, output);
  process.stdout.write(`${JSON.stringify({ ok: true, output: path.resolve(args.output), type: output.type })}\n`);
}

main();
