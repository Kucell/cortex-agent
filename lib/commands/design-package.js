"use strict";

// ─── design-package — CLI surface (SamHMI pilot) ─────────────────────────────
//
// cortex-agent design-package <task-id> --from-pixso <dsl.json> [options]
//
// Builds an Open Design-style design resource package:
//   .agent/artifacts/<task-id>/package/
//   ├── <entry>                    runnable single-file HTML (SamHMI shell)
//   ├── brand-spec.md              design spec (canvas/colors/typography/state)
//   ├── <entry>.artifact.json      Open Design v1-style metadata
//   ├── validation-contract.json   acceptance contract
//   └── <entry>.zip                (--zip) zero-dep STORE zip
//
// Hard constraints:
//   - Zero npm deps; no subprocess; no network.
//   - Output stays inside the project (traversal rejected).
//   - Deterministic (zip uses fixed timestamps; HTML has no wall-clock).
//   - Does not modify deck/catalog/design code or unrelated files.
//
// Exit codes: 0 success / 1 generic / 2 user error. The module sets
// process.exitCode itself (matching deck.js / design.js convention) so the
// bin/cli.js wrapper reflects the code.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const spec = require("../design-package/spec");
const tokens = require("../design-package/tokens");
const render = require("../design-package/render");
const artifact = require("../design-package/artifact");
const { buildZip } = require("../design-package/zip");

function fail(code, message) {
  console.error(`[cortex-agent] ✗ ${message}`);
  process.exitCode = code;
  return code;
}

// Deterministic SHA-256 of the DSL content for traceability.
function dslDigest(dsl) {
  return crypto.createHash("sha256").update(JSON.stringify(dsl)).digest("hex").slice(0, 16);
}

// Optional: verify an installed design-system id exists (read-only).
function verifySystem(systemId, cwd) {
  if (!systemId) return null;
  const p = path.join(cwd, ".agent", "design-systems", systemId);
  const manifest = path.join(p, "DESIGN.md");
  if (!fs.existsSync(manifest)) {
    return {
      ok: false,
      message: `design-system "${systemId}" not installed at ${path.relative(cwd, p)}`,
    };
  }
  return { ok: true, id: systemId };
}

function buildBrief(dsl, opts) {
  const root = dsl.roots && dsl.roots[0];
  const rootName = root && root.name ? root.name : "SamHMI 画面编辑器";
  return {
    taskId: opts.taskId,
    title: opts.title || rootName,
    dsl,
    sourceGuid: (root && root.id) || "73:464",
  };
}

async function designPackageCommand(ctx) {
  const cwd = ctx.cwd || process.cwd();
  const opts = spec.parseArgs(ctx.args || [], ctx.lang, cwd);

  if (opts.showHelp) {
    spec.printHelp(opts.lang !== "en");
    if (opts.taskId) return 0;
    process.exitCode = 2;
    return 2;
  }
  if (!opts.taskId) {
    return fail(2, "design-package: <task-id> is required");
  }
  if (!opts.fromPixso) {
    return fail(2, "design-package: --from-pixso <dsl.json> is required");
  }

  try {
    spec.validateEntry(opts.entry);
    spec.validateLang(opts.lang);
    spec.validateTemplate(opts.template);
  } catch (err) {
    return fail(2, err.message);
  }

  // Resolve output dir (traversal guard) before any writes.
  let outputDir;
  try {
    outputDir = spec.resolveOutputDir(opts.outputDir, opts.taskId, cwd);
  } catch (err) {
    return fail(2, err.message);
  }

  // System check (read-only; advisory only).
  if (opts.system) {
    const check = verifySystem(opts.system, cwd);
    if (check && !check.ok) {
      return fail(2, check.message);
    }
  }

  // Load + validate DSL.
  let dsl;
  try {
    dsl = spec.readDslFile(opts.fromPixso);
  } catch (err) {
    return fail(2, err.message);
  }

  // Build everything.
  let html;
  let brandSpec;
  try {
    const brief = buildBrief(dsl, opts);
    const tokensObj = tokens.buildBrandTokens(dsl, { lang: opts.lang });
    html = render.buildHtml(brief, opts);
    brandSpec = tokens.buildBrandSpec(brief, tokensObj, opts);
  } catch (err) {
    return fail(1, `design-package render failed: ${err.message}`);
  }

  // Write artifacts.
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    const entryPath = path.join(outputDir, opts.entry);
    const artifactName = `${opts.entry}.artifact.json`;
    const vcPath = path.join(outputDir, "validation-contract.json");

    fs.writeFileSync(entryPath, html, "utf8");
    fs.writeFileSync(path.join(outputDir, "brand-spec.md"), brandSpec, "utf8");

    const formats = ["html"];
    const exportsList = ["html"];

    if (opts.zip) {
      const zip = buildZip([
        { filename: opts.entry, data: html },
        { filename: "brand-spec.md", data: brandSpec },
      ]);
      fs.writeFileSync(path.join(outputDir, opts.entry.replace(/\.html$/, ".zip")), zip);
      formats.push("zip");
      exportsList.push("zip");
    }

    const root = dsl.roots && dsl.roots[0];
    const meta = {
      taskId: opts.taskId,
      title: opts.title || dsl.roots[0].name || opts.taskId,
      entry: opts.entry,
      renderer: "html",
      exports: exportsList,
      source: "pixso-dsl",
      designSystem: opts.system || null,
      template: opts.template,
      skills: [],
      license: null,
      outputDir,
      // Provenance: canonical pixsoDslDigest + sourceGuid from DSL root id.
      pixsoDslDigest: dslDigest(dsl),
      dslDigest: dslDigest(dsl),
      sourceGuid: (root && root.id) || "73:464",
    };
    const artifactObj = artifact.buildArtifact(meta);
    fs.writeFileSync(path.join(outputDir, artifactName), JSON.stringify(artifactObj, null, 2), "utf8");

    const vc = artifact.buildValidationContract({
      taskId: opts.taskId,
      outputDir,
      entry: opts.entry,
      formats,
      template: opts.template,
      lang: opts.lang,
      source: "pixso-dsl",
      preview: opts.preview,
      previewRendered: false,
    });
    fs.writeFileSync(vcPath, JSON.stringify(vc, null, 2), "utf8");

    // --preview: graceful degrade (no external Chromium launch). In JSON mode
    // the status is surfaced in the summary only — never emit a plain warning
    // that would break machine-readable stdout.
    const previewStatus = opts.preview ? "skipped" : "not-requested";
    if (opts.preview && !opts.json) {
      console.log("[cortex-agent] ⚠ --preview requested; no Chromium launched (graceful skip)");
    }

    const summary = {
      ok: true,
      task_id: opts.taskId,
      output_dir: outputDir,
      entry: opts.entry,
      formats,
      brand_spec: "brand-spec.md",
      artifact: artifactName,
      validation_contract: "validation-contract.json",
      dsl_digest: meta.pixsoDslDigest,
      preview: previewStatus,
    };
    if (opts.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`[cortex-agent] ✓ design-package written to ${path.relative(cwd, outputDir) || outputDir}`);
      console.log(`  · ${opts.entry}  (${html.length} bytes)`);
      console.log(`  · brand-spec.md  (${brandSpec.length} bytes)`);
      console.log(`  · ${artifactName}`);
      console.log(`  · validation-contract.json`);
      if (opts.zip) console.log(`  · ${opts.entry.replace(/\.html$/, ".zip")}`);
    }
    return 0;
  } catch (err) {
    return fail(1, `design-package write failed: ${err.message}`);
  }
}

module.exports = {
  designPackageCommand,
  // exposed for tests
  _internal: {
    buildBrief,
    verifySystem,
    dslDigest,
  },
};
