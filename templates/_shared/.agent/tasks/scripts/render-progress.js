"use strict";

// ─── render-progress.js (T-TS-003 / MS-3) ──────────────────────────────────
//
// Renders `.agent/plans/task-progress.md` from the structured task records
// (`.agent/tasks/*.json` + `.agent/missions/*/mission.json`) while preserving
// every hand-maintained section of the existing view.
//
// The view is a DERIVED VIEW. Its generated regions are marked with
// `<!-- generated:*:start -->` / `<!-- generated:*:end -->` and are owned by
// this renderer. The manual regions (`<!-- manual:*:start -->` /
// `<!-- manual:*:end -->`) belong to the human and are copied verbatim.
//
// Contract (P-001 §7.3 / §7.4):
//   - write path:  change the JSON truth source -> run render-progress -> commit both
//   - check path:  `--check` exits 1 when the view has drifted from the truth source
//
// Usage:
//   node .agent/tasks/scripts/render-progress.js            # write the view
//   node .agent/tasks/scripts/render-progress.js --check    # CI / pre-commit drift check
//   node .agent/tasks/scripts/render-progress.js --json     # machine-readable report

const fs = require("node:fs");
const path = require("node:path");

// The projection lives in task-state.js so the view, the management-api
// projection and every other consumer read the truth source exactly one way.
const { projectTaskRecord, projectMissionRecord, STAGE_PROGRESS } = require("./task-state.js");

const AGENT_REL = ".agent";
const PROGRESS_REL = path.join(AGENT_REL, "plans", "task-progress.md");
const TASKS_REL = path.join(AGENT_REL, "tasks");
const MISSIONS_REL = path.join(AGENT_REL, "missions");
const ARCHIVE_REL = path.join(AGENT_REL, "plans", "task-progress-archive");

const TASK_FILE_RE = /^(T-[A-Za-z0-9][A-Za-z0-9._-]*)\.json$/;
const MISSION_FILE_RE = /^(M-[A-Za-z0-9][A-Za-z0-9._-]*)\.json$/;

const MANUAL_SECTIONS = Object.freeze([
  { key: "roadmap", heading: "🗺️ 路线图", marker: "manual:roadmap" },
  { key: "backlog", heading: "⏳ 未处理事项", marker: "manual:backlog" },
  { key: "resume", heading: "🔌 断点续接", marker: "manual:resume" },
]);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; }
}

function escapeCell(text) {
  return String(text == null ? "" : text).replace(/\|/g, "\\|").trim();
}

function listTaskRecords(tasksDir) {
  let names = [];
  try { names = fs.readdirSync(tasksDir); } catch (_) { return []; }
  const out = [];
  for (const name of names) {
    if (!name.match(TASK_FILE_RE)) continue;
    const data = readJson(path.join(tasksDir, name));
    if (data && data.task_id) out.push(data);
  }
  return out;
}

// Mission records live in a per-mission directory, one directory per mission,
// each holding its `mission.json` — that is the layout mission.schema.json
// mandates. The flat `.agent/missions/M-xxx.json` form is still accepted for
// projects that wrote it before the schema existed.
function listMissionRecords(missionsDir) {
  let names = [];
  try { names = fs.readdirSync(missionsDir); } catch (_) { return []; }
  const out = [];
  for (const name of names) {
    const nested = path.join(missionsDir, name, "mission.json");
    if (fs.existsSync(nested)) {
      const data = readJson(nested);
      if (data && data.mission_id) out.push(data);
      continue;
    }
    if (!name.match(MISSION_FILE_RE)) continue;
    const data = readJson(path.join(missionsDir, name));
    if (data && data.mission_id) out.push(data);
  }
  return out;
}

// ─── Manual region extraction ───────────────────────────────────────────────

// Read the body of a `<!-- manual:<key>:start --> ... <!-- manual:<key>:end -->`
// region. When the region markers are missing (a legacy view), fall back to
// the `## <heading>` section body so an un-migrated project still renders.
function extractManualRegion(source, key, heading) {
  const markerRe = new RegExp(
    "<!--\\s*manual:" + key + ":start\\s*-->([\\s\\S]*?)<!--\\s*manual:" + key + ":end\\s*-->",
  );
  const marked = source.match(markerRe);
  if (marked) {
    return marked[1].replace(/^\s*\n/, "").replace(/\n\s*$/, "");
  }
  const lines = source.split(/\r?\n/);
  // The heading may be written as "## 🗺️ 路线图" or "## 🗺️ 路线图 (Roadmap)".
  const start = lines.findIndex((line) => {
    const trimmed = line.trim();
    if (!/^##\s/.test(trimmed)) return false;
    return trimmed === "## " + heading || trimmed.startsWith("## " + heading + " ");
  });
  if (start === -1) return "";
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index])) { end = index; break; }
  }
  const body = lines.slice(start + 1, end);
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  return body.join("\n");
}

// Preserve every marker block this renderer does not own. Only `generated:*`
// regions are rewritten; anything else (progress-reconcile drift blocks and
// any future tool's markers) is copied verbatim.
function extractForeignMarkers(source) {
  const out = [];
  const re = /<!--\s*([a-z0-9-]+:[a-z0-9-]+)\s*-->([\s\S]*?)<!--\s*\/\1\s*-->/gi;
  let match;
  while ((match = re.exec(source)) !== null) {
    if (match[1].startsWith("generated:") || match[1].startsWith("manual:")) continue;
    out.push(match[0].trim());
  }
  return out;
}

// ─── Archive index ──────────────────────────────────────────────────────────

function listArchives(archiveDir) {
  let names = [];
  try { names = fs.readdirSync(archiveDir); } catch (_) { return []; }
  const out = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".md")) continue;
    if (name.startsWith("_")) continue;
    const full = path.join(archiveDir, name);
    let items = null;
    let dateRange = null;
    try {
      const head = fs.readFileSync(full, "utf8").split(/\r?\n/).slice(0, 12).join("\n");
      const rangeMatch = head.match(/date_range:\s*\[\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\]/);
      if (rangeMatch) dateRange = [rangeMatch[1], rangeMatch[2]];
      const itemsMatch = head.match(/^items:\s*(\d+)/m);
      if (itemsMatch) items = Number(itemsMatch[1]);
    } catch (_) { /* unreadable archive is listed without metadata */ }
    out.push({ fileName: name, dateRange, items });
  }
  return out;
}


// Recover the heading text a project already uses for a manual section, so a
// render does not rewrite "## 🗺️ 路线图 (Roadmap)" into "## 🗺️ 路线图".
function findManualHeading(source, key, heading) {
  const lines = source.split(/\r?\n/);
  const marker = "<!-- manual:" + key + ":start -->";
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== marker) continue;
    for (let back = index - 1; back >= 0; back -= 1) {
      const trimmed = lines[back].trim();
      if (!trimmed) continue;
      if (!/^##\s/.test(trimmed)) return null;
      const text = trimmed.replace(/^##\s+/, "");
      return text.startsWith(heading) ? text : null;
    }
    return null;
  }
  return null;
}
// ─── Rendering ──────────────────────────────────────────────────────────────

function renderView({ source, tasks, missions, archives, now }) {
  const date = String(now).slice(0, 10);
  // Tasks and missions share one projection, so the view and the consumers
  // that read the same truth source can never disagree about a record.
  const all = [
    ...tasks.map((task) => projectTaskRecord(task)).filter(Boolean),
    ...missions.map((mission) => projectMissionRecord(mission)).filter(Boolean),
  ];
  const isDone = (item) => item.status === "done" || item.status === "canceled" || item.status === "superseded";
  const done = all.filter(isDone);
  const active = all.filter((item) => !isDone(item));
  const overall = all.length > 0 ? Math.round((done.length / all.length) * 100) : 0;

  const out = [];
  out.push("# 任务进度", "");
  out.push(
    "<!-- generated:task-progress v1; source="
    + TASKS_REL.split(path.sep).join("/") + ",index.json+"
    + MISSIONS_REL.split(path.sep).join("/")
    + "; 请勿手改生成区 -->",
    "",
  );
  out.push("> **总体进度**: " + overall + "%（由真源推导）");
  out.push("> **最后更新时间**: " + date, "");

  for (const section of MANUAL_SECTIONS) {
    const body = extractManualRegion(source, section.key, section.heading);
    out.push("## " + (findManualHeading(source, section.key, section.heading) || section.heading));
    out.push("<!-- manual:" + section.key + ":start -->");
    out.push(body);
    out.push("<!-- manual:" + section.key + ":end -->", "");
  }

  out.push("## 🔥 当前活跃任务", "<!-- generated:active-tasks:start -->");
  out.push("| 任务 ID | 优先级 | 任务说明 | 进度 | 关联计划 |");
  out.push("| :--- | :--- | :--- | :--- | :--- |");
  for (const task of active) {
    const refs = Array.isArray(task.source_refs) && task.source_refs.length
      ? task.source_refs
      : [TASKS_REL.split(path.sep).join("/") + "/" + task.id + ".json"];
    out.push(
      "| " + escapeCell(task.id)
      + " | " + escapeCell(task.priority)
      + " | " + escapeCell(task.title)
      + " | " + escapeCell(task.progress)
      + " | " + escapeCell(refs[0])
      + " |",
    );
  }
  out.push("<!-- generated:active-tasks:end -->", "");

  out.push("## 📚 历史归档", "<!-- generated:archive-index:start -->");
  for (const archive of archives) {
    const range = archive.dateRange ? archive.dateRange.join("--") : archive.fileName.replace(/\.md$/, "");
    const count = archive.items !== null ? "（" + archive.items + " 条收口）" : "";
    out.push("- [" + range + "](task-progress-archive/" + archive.fileName + ")" + count);
  }
  out.push("<!-- generated:archive-index:end -->", "");

  for (const marker of extractForeignMarkers(source)) {
    out.push(marker, "");
  }

  return out.join("\n");
}

// ─── Entry points ───────────────────────────────────────────────────────────

// The render timestamp records when the view was produced, not what it says.
// The gate asserts that the view is a faithful projection of the truth
// source; the date line is metadata about the rendering, not a projection.
// Comparing it would make the gate expire every midnight — the truth source
// unchanged, the view still faithful, yet the date line no longer matching.
const TIMESTAMP_RE = /^> \*\*最后更新时间\*\*: .*$/m;

function stripRenderTimestamp(text) {
  return String(text || "").replace(TIMESTAMP_RE, "");
}

function buildView(projectRoot, now) {
  const progressFile = path.join(projectRoot, PROGRESS_REL);
  const source = fs.existsSync(progressFile) ? fs.readFileSync(progressFile, "utf8") : "";
  const tasks = listTaskRecords(path.join(projectRoot, TASKS_REL));
  const missions = listMissionRecords(path.join(projectRoot, MISSIONS_REL));
  const archives = listArchives(path.join(projectRoot, ARCHIVE_REL));
  const view = renderView({ source, tasks, missions, archives, now });
  return { view, tasks, missions, archives };
}

function main(argv) {
  const args = argv.slice(2);
  const check = args.includes("--check");
  const asJson = args.includes("--json");
  const projectArgIndex = args.findIndex((arg) => arg === "--project");
  const projectRoot = projectArgIndex >= 0 && args[projectArgIndex + 1]
    ? path.resolve(process.cwd(), args[projectArgIndex + 1])
    : process.cwd();
  const now = new Date().toISOString();

  const { view, tasks, missions } = buildView(projectRoot, now);
  const progressFile = path.join(projectRoot, PROGRESS_REL);
  const current = fs.existsSync(progressFile) ? fs.readFileSync(progressFile, "utf8") : "";

  if (check) {
    // The gate can only judge a projection when the truth source is present.
    // A checkout that does not materialise the governance repository — CI
    // checks out the framework repository alone — carries no task or mission
    // record, so there is nothing to project and nothing to assert. That is a
    // skip, not a drift: reporting it as drift would fail every checkout that
    // does not own the records.
    const hasSource = tasks.length > 0 || missions.length > 0;
    if (!hasSource) {
      if (asJson) {
        process.stdout.write(JSON.stringify({
          action: "render-progress --check",
          ok: true,
          drifted: false,
          skipped: true,
          task_count: 0,
          mission_count: 0,
          view_path: PROGRESS_REL.split(path.sep).join("/"),
        }, null, 2) + "\n");
      } else {
        console.log("ok: 真源记录不存在（无任务 / mission 记录），跳过视图一致性校验。");
      }
      return;
    }
    const drifted = stripRenderTimestamp(current).trim() !== stripRenderTimestamp(view).trim();
    if (asJson) {
      process.stdout.write(JSON.stringify({
        action: "render-progress --check",
        ok: !drifted,
        drifted,
        task_count: tasks.length,
        mission_count: missions.length,
        view_path: PROGRESS_REL.split(path.sep).join("/"),
      }, null, 2) + "\n");
    } else if (drifted) {
      console.error("❌ task-progress.md 与真源不一致。请运行 `node .agent/tasks/scripts/render-progress.js` 重新生成。");
    } else {
      console.log("✓ task-progress.md 与真源一致。");
    }
    if (drifted) process.exitCode = 1;
    return;
  }

  fs.mkdirSync(path.dirname(progressFile), { recursive: true });
  fs.writeFileSync(progressFile, view, "utf8");
  if (asJson) {
    process.stdout.write(JSON.stringify({
      action: "render-progress",
      ok: true,
      written: PROGRESS_REL.split(path.sep).join("/"),
      task_count: tasks.length,
      mission_count: missions.length,
    }, null, 2) + "\n");
  } else {
    console.log("✓ 已生成 " + PROGRESS_REL + " (" + tasks.length + " 任务 / " + missions.length + " mission)");
  }
}

if (require.main === module) {
  main(process.argv);
}

module.exports = {
  renderView,
  buildView,
  extractManualRegion,
  extractForeignMarkers,
  listTaskRecords,
  listMissionRecords,
  listArchives,
  stripRenderTimestamp,
  STAGE_PROGRESS,
  PROGRESS_REL,
  TASKS_REL,
  MISSIONS_REL,
  ARCHIVE_REL,
};

