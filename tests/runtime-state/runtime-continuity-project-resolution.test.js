"use strict";

// ─── session --project path/name resolution (runtime-continuity) ─────────────
//
// `--project` is documented as a project NAME by the session subcommands, but
// the rest of the CLI documents the same flag as a project root PATH
// (`.help/decisions-request.md`: "Project root directory."). The value used to
// be joined onto CONTEXT_HOME verbatim, which produced two silent failures:
//
//   session archive  --project /a/b/myproj  →  ok:true, but it created
//                                              ~/.agent/contexts/a/b/myproj/
//   session status   --project myproj       →  exists:false for a project
//                                              that plainly had archives
//
// These tests pin the fix: both spellings resolve to the same context
// directory, archive stays flat, and an unknown project is self-evident rather
// than an unexplained exists:false.
//
// HOME is redirected into a tmpdir for every spawn so the suite never writes to
// the developer's real ~/.agent/contexts/.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, describe, before, after } = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const TEMPLATES = ["_shared", "zh", "en"];

let home;

function scriptFor(tpl) {
  return path.join(ROOT, "templates", tpl, ".agent", "skills", "runtime-continuity", "scripts", "index.js");
}

function contextHome(tpl) {
  return path.join(home, tpl, ".agent", "contexts");
}

function run(tpl, args) {
  const cwd = path.join(home, tpl);
  const r = spawnSync(process.execPath, [scriptFor(tpl), ...args], {
    cwd,
    env: { ...process.env, HOME: path.join(home, tpl) },
    encoding: "utf8",
  });
  const text = (r.stdout || "") + (r.stderr || "");
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* non-JSON output */ }
  return { ...r, text, json };
}

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-projres-"));
  for (const tpl of TEMPLATES) {
    const ctx = path.join(home, tpl, ".agent", "contexts", "myproj");
    fs.mkdirSync(ctx, { recursive: true });
    const file = path.join(ctx, "ctx_20260101_000000.md");
    fs.writeFileSync(file, "# ctx\n");
    // Fixed mtime keeps age_hours deterministic across runs.
    fs.utimesSync(file, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
  }
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("runtime-continuity --project resolution", () => {
  for (const tpl of TEMPLATES) {
    describe(`template copy: ${tpl}`, () => {
      test("status resolves a project name", () => {
        const { json } = run(tpl, ["status", "--project", "myproj"]);
        assert.equal(json.exists, true);
        assert.equal(json.project, "myproj");
        assert.equal(json.count, 1);
      });

      test("status resolves a project PATH to the same context directory", () => {
        const asPath = path.join(home, tpl, "myproj");
        const { json } = run(tpl, ["status", "--project", asPath]);

        assert.equal(
          json.exists, true,
          "a project path must not report exists:false for a project that has archives",
        );
        assert.equal(json.project, "myproj", "the path must resolve to the context directory name");
        assert.equal(json.requested_project, asPath, "the caller's input must be echoed back");
        assert.equal(json.count, 1);
      });

      test("status always reports an explicit exists field", () => {
        const hit = run(tpl, ["status", "--project", "myproj"]).json;
        const miss = run(tpl, ["status", "--project", "definitely-not-a-project"]).json;
        assert.equal(typeof hit.exists, "boolean");
        assert.equal(typeof miss.exists, "boolean");
        assert.equal(miss.exists, false);
      });

      test("an unknown project lists the known ones instead of a bare exists:false", () => {
        const { json } = run(tpl, ["status", "--project", "definitely-not-a-project"]);
        assert.equal(json.exists, false);
        assert.ok(
          Array.isArray(json.known_projects) && json.known_projects.includes("myproj"),
          `expected known_projects to include myproj, got ${JSON.stringify(json.known_projects)}`,
        );
      });

      test("archive --project PATH writes a flat context directory", () => {
        const asPath = path.join(home, tpl, "myproj");
        const { json } = run(tpl, ["archive", "--project", asPath, "--gate", "user"]);

        assert.equal(json.ok, true);
        const ctxHome = contextHome(tpl);
        const flat = path.join(ctxHome, "myproj");
        assert.ok(
          fs.existsSync(flat),
          "archive must not create a nested directory tree under contexts/",
        );
        // The exact bug: contexts/<absolute path>/ctx_*.md
        const nested = path.join(ctxHome, home.replace(/^\//, "").split(path.sep).join(path.sep));
        assert.equal(
          fs.existsSync(nested),
          false,
          "archive must not mirror the absolute --project path under contexts/",
        );
      });

      test("archive --project PATH and status --project NAME see the same archive", () => {
        const asPath = path.join(home, tpl, "myproj");
        run(tpl, ["archive", "--project", asPath, "--gate", "user"]);

        const { json } = run(tpl, ["status", "--project", "myproj"]);
        assert.equal(json.exists, true);
        assert.ok(json.count >= 1, "status must observe the archive that was just written");
      });

      // path.join(CONTEXT_HOME, ".") collapses to CONTEXT_HOME and ".." escapes
      // to ~/.agent, so an unvalidated value wrote ctx_*.md and latest.md into
      // the contexts root while reporting ok:true.
      for (const bad of [".", ".."]) {
        test(`archive --project ${bad} fails closed instead of writing into contexts/`, () => {
          const { json } = run(tpl, ["archive", "--project", bad, "--gate", "user"]);
          assert.equal(json.ok, false, `--project ${bad} must not report ok:true`);
          assert.equal(json.error, "invalid_project");
        });

        test(`status --project ${bad} fails closed`, () => {
          const { json } = run(tpl, ["status", "--project", bad]);
          assert.equal(json.ok, false, `--project ${bad} must not report ok:true`);
          assert.equal(json.error, "invalid_project");
        });
      }

      test("nothing is written directly into the contexts root", () => {
        const ctxHome = contextHome(tpl);
        for (const bad of [".", ".."]) run(tpl, ["archive", "--project", bad, "--gate", "user"]);
        const loose = fs.readdirSync(ctxHome).filter((n) => !fs.statSync(path.join(ctxHome, n)).isDirectory());
        assert.deepEqual(loose, [], `stray files in contexts root: ${loose.join(", ")}`);
      });

      test("a trailing separator still resolves to the project name", () => {
        const asPath = path.join(home, tpl, "myproj") + path.sep;
        const { json } = run(tpl, ["status", "--project", asPath]);
        assert.equal(json.exists, true);
        assert.equal(json.project, "myproj");
      });
    });
  }

  test("all three template copies resolve --project identically", () => {
    const results = TEMPLATES.map((tpl) => {
      const asPath = path.join(home, tpl, "myproj");
      const { json } = run(tpl, ["status", "--project", asPath]);
      return { tpl, project: json.project, exists: json.exists, count: json.count };
    });
    const reference = JSON.stringify(results[0].project) + results[0].exists;
    for (const r of results) {
      assert.equal(
        JSON.stringify(r.project) + r.exists,
        reference,
        `${r.tpl} diverges from ${results[0].tpl}`,
      );
    }
  });
});
