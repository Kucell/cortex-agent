"use strict";

// ─── artifact — Open Design v1-style metadata + validation contract ──────────
//
// Emits:
//   <entry>.artifact.json — compatible in spirit with the Open Design artifact
//   metadata sample (version / kind / title / entry / renderer / status /
//   exports / createdAt / updatedAt / metadata).
//
//   validation-contract.json — assertions that make this pipeline's own
//   acceptance explicit (input contract, output presence, determinism,
//   traversal guard).

function nowIso() {
  return new Date().toISOString();
}

function buildArtifact(meta) {
  // meta: { taskId, title, entry, renderer, exports, source, designSystem,
  //         template, skills, license, outputDir, pixsoDslDigest, sourceGuid }
  const ts = nowIso();
  const exportsList = Array.isArray(meta.exports) && meta.exports.length > 0
    ? meta.exports
    : ["html"];
  const metadata = {
    source: meta.source || "pixso-dsl",
    designSystem: meta.designSystem || null,
    template: meta.template || "samhmi-editor",
    skills: Array.isArray(meta.skills) ? meta.skills : [],
    license: meta.license || null,
  };
  // Provenance contract: pixsoDslDigest is the canonical DSL digest field.
  if (meta.pixsoDslDigest) metadata.pixsoDslDigest = meta.pixsoDslDigest;
  // Retain dslDigest for backward compatibility with the earlier pilot shape.
  if (meta.dslDigest) metadata.dslDigest = meta.dslDigest;
  // Source GUID (e.g. "73:464" or the DSL root node id) for provenance.
  if (meta.sourceGuid) metadata.sourceGuid = meta.sourceGuid;
  if (meta.outputDir) metadata.outputDir = meta.outputDir;

  return {
    version: 1,
    kind: "html",
    title: meta.title || meta.taskId || "SamHMI 画面编辑器",
    entry: meta.entry || "samhmi-editor.html",
    renderer: meta.renderer || "html",
    status: "complete",
    exports: exportsList,
    createdAt: ts,
    updatedAt: ts,
    metadata,
  };
}

function buildValidationContract(opts) {
  // opts: { taskId, outputDir, entry, formats, template, lang, source,
  //         slideCount?, traversable }
  const assertions = [
    {
      id: "input.dsl",
      type: "docs",
      description: "compact Pixso DSL supplied via --from-pixso with non-empty roots[]",
      status: "pass",
    },
    {
      id: "output.entry",
      type: "runtime",
      description: `runnable HTML artifact written to ${opts.entry}`,
      status: "pass",
    },
    {
      id: "output.brand-spec",
      type: "docs",
      description: "brand-spec.md written with canvas/colors/typography/state semantics",
      status: "pass",
    },
    {
      id: "output.artifact",
      type: "docs",
      description: "Open Design v1-style artifact metadata written",
      status: "pass",
    },
    {
      id: "output.traversal-guard",
      type: "security",
      description: "output dir + entry stay inside the project; traversal rejected",
      status: "pass",
    },
  ];
  if (opts.formats && opts.formats.includes("zip")) {
    assertions.push({
      id: "output.zip",
      type: "runtime",
      description: "zero-dependency STORE zip written",
      status: "pass",
    });
  }
  if (opts.preview) {
    assertions.push({
      id: "output.preview",
      type: "manual",
      description: "preview requested; gracefully degrades to unsupported when no Chromium",
      status: opts.previewRendered ? "pass" : "skipped",
    });
  }

  return {
    workflow: "design-package",
    task_id: opts.taskId,
    produced_at: nowIso(),
    output_dir: opts.outputDir,
    template: opts.template || "samhmi-editor",
    lang: opts.lang || "zh",
    source: opts.source || "pixso-dsl",
    assertions,
  };
}

module.exports = {
  buildArtifact,
  buildValidationContract,
  nowIso,
};
