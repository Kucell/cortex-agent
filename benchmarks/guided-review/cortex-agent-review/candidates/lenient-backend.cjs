#!/usr/bin/env node
"use strict";

// ---------------------------------------------------------------------------
// benchmarks/guided-review/cortex-agent-review/candidates/lenient-backend.cjs
// ---------------------------------------------------------------------------
// A deliberately unvalidated reviewer backend.
//
// It exists so the dataset can prove it distinguishes a *contract-enforcing*
// backend from one that merely writes whatever it was handed. It performs no
// schema validation, no changeset check and no file-existence check, so every
// malformed finding it receives ends up in the artifact.
//
// A dataset whose assertions never fail would pass just as well against this
// candidate — which is exactly why it is here.
// ---------------------------------------------------------------------------

const fs = require("node:fs");
const path = require("node:path");

const args = {};
for (let index = 2; index < process.argv.length; index += 1) {
  if (!process.argv[index].startsWith("--")) continue;
  const key = process.argv[index].slice(2);
  const value = process.argv[index + 1];
  args[key] = value;
  index += 1;
}

const input = JSON.parse(fs.readFileSync(path.resolve(args.input), "utf8"));
const findings = Array.isArray(input.findings) ? input.findings : [];

const groups = findings.map((finding) => ({
  ...finding,
  files: [...(finding.files || [])].sort(),
  validation_refs: [...(finding.validation_refs || [])].sort(),
  follow_ups: [...(finding.follow_ups || [])].sort(),
}));

const riskCounts = { low: 0, medium: 0, high: 0, critical: 0 };
for (const group of groups) {
  if (group.risk in riskCounts) riskCounts[group.risk] += 1;
}

const artifact = {
  type: "guided_review",
  artifact_id: input.artifact_id || "GR-lenient",
  task_id: input.task_id,
  run_id: input.run_id,
  session_id: input.session_id,
  workspace_ids: input.workspace_ids,
  base_revision: input.base_revision,
  head_revision: input.head_revision,
  groups,
  summary: {
    group_count: groups.length,
    file_count: new Set(groups.flatMap((group) => group.files)).size,
    risk_counts: riskCounts,
    validation_ref_count: new Set(groups.flatMap((group) => group.validation_refs)).size,
    follow_up_count: new Set(groups.flatMap((group) => group.follow_ups)).size,
  },
  generated_at: input.generated_at,
};

fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(artifact, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ok: true, backend: "lenient", findings: groups.length })}\n`);
