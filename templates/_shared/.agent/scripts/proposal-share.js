#!/usr/bin/env node
"use strict";

// ─── proposal-share — portable proposal package export / import / verify ─────
//
// Makes the "share a proposal package with another developer / another repo"
// scenario first-class for cortex-agent projects:
//
//   - Proposal packages are self-contained standard directories
//     (.agent/plans/proposals/projects/<slug>/ per
//     .agent/rules/proposal-structure.md), but .agent/ is typically gitignored,
//     so sharing cannot rely on git transport.
//   - Dual-repo joint proposals (backend repo + mobile repo) need BOTH volumes,
//     absolute-path rewriting (cross_project_peers / relations.md / index.md)
//     and symlink rebuilding (mirrored shared decisions).
//
// This script packages proposals + missions + topology + peer volumes into a
// single tar.gz with a MANIFEST.json and a human-readable README, tokenizes
// absolute paths, records symlinks, and can restore everything at the standard
// paths on the receiving side.
//
// Usage:
//   node .agent/scripts/proposal-share.js export --slug <slug> [options]
//   node .agent/scripts/proposal-share.js import --package <tar.gz> [options]
//   node .agent/scripts/proposal-share.js verify --package <tar.gz> [options]
//
// Authoritative workflow: .agent/workflows/proposal-share.md

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = process.cwd();
const PACKAGE_SCHEMA_VERSION = "1.0";
// Backtick helper: keeps the source free of literal backticks so the file can
// be generated/embedded without escaping gymnastics.
const BT = String.fromCharCode(96);

function usage() {
  console.log(
    [
      "Usage:",
      "  node .agent/scripts/proposal-share.js export --slug <slug> [--root <dir>] [--out <dir>]",
      "        [--peers <root,root,...>] [--no-peers] [--missions <M-xxx,M-yyy>]",
      "        [--all-missions] [--handoff <file>] [--with-topology]",
      "",
      "  node .agent/scripts/proposal-share.js import --package <tar.gz> [--root <dir>]",
      "        [--root-map 'repo=/abs/path,repo2=/abs/path'] [--dry-run] [--force]",
      "        [--skip-missions] [--skip-topology] [--keep-tmp]",
      "",
      "  node .agent/scripts/proposal-share.js verify --package <tar.gz> [--root <dir>]",
      "",
      "Options:",
      "  --slug <slug>         Proposal project slug (kebab-case)",
      "  --root <dir>          Project root (default: current directory)",
      "  --out <dir>           Export output dir (default: <root>/.agent/artifacts/proposal-packages)",
      "  --peers <roots>       Comma-separated peer repo roots to include explicitly",
      "  --no-peers            Do not discover/include peer volumes",
      "  --missions <ids>      Comma-separated mission ids to include (M-xxx)",
      "  --all-missions        Include every mission dir under .agent/missions",
      "  --handoff <file>      Include an existing handoff artifact (md or json)",
      "  --with-topology       Include .agent/topology/projects.json (default on)",
      "  --package <tar.gz>    Package file to import / verify",
      "  --root-map <map>      'repo=/abs/path,...' absolute-path token mapping for import",
      "  --dry-run             Import: validate + print plan, write nothing",
      "  --force               Import: overwrite existing target files",
      "  --skip-missions       Import: do not install missions",
      "  --skip-topology       Import: do not install topology",
      "  --keep-tmp            Import/verify: keep temporary extraction dir",
    ].join("\n")
  );
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function fail(message, details) {
  console.error(JSON.stringify({ ok: false, error: message, details: details || {} }, null, 2));
  process.exit(1);
}

function print(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function requireArg(args, key) {
  if (!args[key]) fail("Missing required --" + key);
  return args[key];
}

function resolvePath(p) {
  return path.resolve(root, p);
}

function relFrom(base, p) {
  return path.relative(base, p).split(path.sep).join("/");
}

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

function ts() {
  const d = new Date();
  return (
    d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + "-" +
    pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds())
  );
}

function nowISO() {
  return new Date().toISOString();
}

function isTextFile(name) {
  return /\.(md|json|txt|ya?ml)$/i.test(name);
}

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return;
  } catch (_) {
    /* older node — fall through */
  }
  try {
    fs.rmdirSync(p, { recursive: true });
    return;
  } catch (_) {
    /* fallback below */
  }
  try {
    spawnSync("rm", ["-rf", p]);
  } catch (_) {
    /* ignore */
  }
}

// Remove empty directories from `dir` upward until stopAt (or a non-empty dir).
function pruneEmptyUp(dir, stopAt) {
  let cur = dir;
  while (cur && cur !== stopAt && cur.length > stopAt.length) {
    try {
      const entries = fs.readdirSync(cur);
      if (entries.length !== 0) break;
      fs.rmdirSync(cur);
      cur = path.dirname(cur);
    } catch (_) {
      break;
    }
  }
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJson(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (_) {
    return null;
  }
}

function writeJson(p, obj) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch (_) {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

// Walk a tree without following symlinks. cb({type, relPath, absPath, target})
function walkTree(dir, cb) {
  const base = dir;
  (function rec(cur) {
    let entries;
    try {
      entries = fs.readdirSync(cur);
    } catch (_) {
      return;
    }
    entries.sort();
    for (const name of entries) {
      if (name === ".DS_Store") continue;
      const abs = path.join(cur, name);
      const rel = relFrom(base, abs);
      let st;
      try {
        st = fs.lstatSync(abs);
      } catch (_) {
        continue;
      }
      if (st.isSymbolicLink()) {
        let target = null;
        try {
          target = fs.readlinkSync(abs);
        } catch (_) {
          target = null;
        }
        cb({ type: "symlink", relPath: rel, absPath: abs, target: target });
      } else if (st.isDirectory()) {
        cb({ type: "dir", relPath: rel, absPath: abs });
        rec(abs);
      } else if (st.isFile()) {
        cb({ type: "file", relPath: rel, absPath: abs });
      }
    }
  })(dir);
}

// Copy a file (dereferencing symlinks).
function copyFileDeref(src, dest) {
  mkdirp(path.dirname(dest));
  try {
    const content = fs.readFileSync(src);
    fs.writeFileSync(dest, content);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Copy a directory tree, dereferencing symlinks.
// Returns { copied, symlinks: [{volume, path, target}] }.
function copyTreeDeref(src, dest, volume) {
  const symlinks = [];
  let copied = 0;
  mkdirp(dest);
  walkTree(src, function (entry) {
    if (entry.type === "dir") {
      mkdirp(path.join(dest, entry.relPath));
    } else if (entry.type === "file") {
      const ok = copyFileDeref(entry.absPath, path.join(dest, entry.relPath));
      if (ok.ok) copied += 1;
    } else if (entry.type === "symlink") {
      symlinks.push({ volume: volume, path: entry.relPath, target: entry.target });
      // Dereference: copy the resolved content so the archive stays self-contained.
      const resolved = path.resolve(path.dirname(entry.absPath), entry.target || ".");
      if (isFile(resolved)) {
        const ok = copyFileDeref(resolved, path.join(dest, entry.relPath));
        if (ok.ok) copied += 1;
      }
    }
  });
  return { copied: copied, symlinks: symlinks };
}

function gitInfo(rootDir) {
  const info = { branch: null, commit: null, gitignored: null };
  function git(args) {
    const r = spawnSync("git", args, { cwd: rootDir, encoding: "utf8" });
    if (r.status === null || r.status !== 0) return null;
    return r.stdout.trim();
  }
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== null) info.branch = branch;
  const commit = git(["rev-parse", "--short", "HEAD"]);
  if (commit !== null) info.commit = commit;
  const gi = git(["check-ignore", "-q", ".agent"]);
  if (gi !== null) info.gitignored = gi === "";
  return info;
}

// ── Mission discovery ────────────────────────────────────────────────────────
// A mission dir is included when it is in --missions, or --all-missions, or any
// .md file inside references projects/<slug> (e.g. mission-plan.md).
function discoverMissions(rootDir, slug, explicit, allFlag) {
  const missionsDir = path.join(rootDir, ".agent", "missions");
  if (!isDir(missionsDir)) return { included: [], missing: explicit.slice() };
  const explicitSet = {};
  explicit.forEach(function (id) {
    explicitSet[id] = true;
  });
  const dirs = fs
    .readdirSync(missionsDir)
    .filter(function (n) {
      return /^M-/.test(n) && isDir(path.join(missionsDir, n));
    })
    .sort();
  const included = [];
  dirs.forEach(function (id) {
    if (allFlag || explicitSet[id]) {
      included.push(id);
      return;
    }
    let refs = false;
    const dir = path.join(missionsDir, id);
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch (_) {
      files = [];
    }
    for (const f of files) {
      if (!/\.(md|json)$/i.test(f)) continue;
      let content = "";
      try {
        content = fs.readFileSync(path.join(dir, f), "utf8");
      } catch (_) {
        content = "";
      }
      if (content.indexOf("projects/" + slug) !== -1) {
        refs = true;
        break;
      }
    }
    if (refs) included.push(id);
  });
  const missing = explicit.filter(function (id) {
    return included.indexOf(id) === -1 && !isDir(path.join(missionsDir, id));
  });
  return { included: included, missing: missing };
}

// ── Root discovery (peer volumes + tokenization roots) ──────────────────────
function discoverRoots(rootDir, pkgDir, slug, opts) {
  const roots = {};
  roots[rootDir] = { source: "primary", note: "primary project root" };

  function addRoot(r, source, note) {
    if (!r || typeof r !== "string") return;
    r = r.replace(/\/+$/, "");
    if (!/^\//.test(r)) return; // absolute only
    if (!roots[r]) roots[r] = { source: source, note: note };
  }

  // 1. topology peers
  const topo = readJson(path.join(rootDir, ".agent", "topology", "projects.json"));
  if (topo && topo.peers && Array.isArray(topo.peers)) {
    topo.peers.forEach(function (p) {
      if (p && p.host_root) addRoot(p.host_root, "topology", "topology peers[].host_root");
    });
  }
  if (topo && topo.self && topo.self.host_root) addRoot(topo.self.host_root, "topology", "topology self.host_root");

  // 2. frontmatter cross_project_peers (inline array and YAML path list)
  walkTree(pkgDir, function (entry) {
    if (entry.type !== "file") return;
    if (!/\.(md|json)$/i.test(entry.relPath)) return;
    let content = "";
    try {
      content = fs.readFileSync(entry.absPath, "utf8");
    } catch (_) {
      content = "";
    }
    const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return;
    const fm = m[1];
    const cm = fm.match(/^cross_project_peers\s*:\s*\[([^\]]*)\]/m);
    if (cm) {
      cm[1].split(",").forEach(function (v) {
        addRoot(v.trim().replace(/^["']|["']$/g, ""), "cross_project_peers", "proposal frontmatter cross_project_peers");
      });
    }
    const ym = fm.match(/^cross_project_peers\s*:\s*$/m);
    if (ym) {
      const rest = fm.slice(ym.index + ym[0].length).split(/\r?\n/);
      for (const line of rest) {
        const lm = line.match(/^\s*-\s+(.+?)\s*$/);
        if (!lm) continue;
        addRoot(lm[1].replace(/["']/g, ""), "cross_project_peers", "proposal frontmatter cross_project_peers");
      }
    }
  });

  // 3. regex scan for repo roots that host the same proposal package
  // Path chars allow spaces and unicode but never newlines/tabs, so a match
  // cannot span lines; the trailing lookahead rejects longer slugs.
  if (opts.scan !== false) {
    const re = new RegExp(
      "((?:/[^\"'{}()\\[\\]\\r\\n\\t]+)+?)/\\.agent/plans/proposals/projects/" + slug + "(?=/|[\\s\"'()\\].,;：；）]|$)",
      "g"
    );
    walkTree(pkgDir, function (entry) {
      if (entry.type !== "file") return;
      if (!isTextFile(entry.relPath)) return;
      let content = "";
      try {
        content = fs.readFileSync(entry.absPath, "utf8");
      } catch (_) {
        content = "";
      }
      let m;
      while ((m = re.exec(content)) !== null) {
        addRoot(m[1], "relations", "absolute path in proposal docs");
      }
    });
  }

  // 4. explicit peers
  (opts.peers || []).forEach(function (p) {
    addRoot(path.resolve(rootDir, p), "explicit", "--peers");
  });

  // Confirm peer volumes: root hosts .agent/plans/proposals/projects/<slug>/index.md
  const peerRoots = [];
  Object.keys(roots).forEach(function (r) {
    if (r === rootDir || roots[r].source === "primary") return;
    if (isFile(path.join(r, ".agent", "plans", "proposals", "projects", slug, "index.md"))) {
      peerRoots.push(r);
    }
  });
  peerRoots.sort();

  return { roots: roots, peerRoots: peerRoots };
}

function tokenKeyForRoot(r) {
  const base = path.basename(r.replace(/\/+$/, ""));
  return "@ROOT:" + base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") + "@";
}

function buildTokenMap(rootDir, roots, peerRoots) {
  const tokenMap = {};
  const used = {};
  const rootsList = Object.keys(roots).sort(function (a, b) {
    return b.length - a.length;
  });
  rootsList.forEach(function (r) {
    const base = tokenKeyForRoot(r);
    let token = base;
    let i = 2;
    while (used[token]) {
      token = base.replace(/@$/, "-" + i + "@");
      i += 1;
    }
    used[token] = true;
    let kind = "other";
    if (roots[r].source === "primary") kind = "primary";
    else if (peerRoots.indexOf(r) !== -1) kind = "peer";
    tokenMap[token] = { source_root: r, note: roots[r].note, kind: kind };
  });
  return tokenMap;
}

// Rewrite absolute roots -> tokens in one text content. Returns { changed, content }.
function tokenizeContent(content, tokenMap) {
  const tokens = Object.keys(tokenMap).sort(function (a, b) {
    return b.length - a.length;
  });
  let out = content;
  let changed = false;
  tokens.forEach(function (token) {
    const rootStr = tokenMap[token].source_root;
    const before = out;
    out = out.split(rootStr).join(token);
    if (out !== before) changed = true;
  });
  return { changed: changed, content: out };
}

// Rewrite tokens back to absolute roots in one text content.
function restoreContent(content, tokenMap) {
  const tokens = Object.keys(tokenMap).sort(function (a, b) {
    return b.length - a.length;
  });
  let out = content;
  tokens.forEach(function (token) {
    const replacement = tokenMap[token].resolved;
    out = out.split(token).join(replacement);
  });
  return out;
}

// Apply tokenization across a staged tree. Appends rewritten relative paths.
function tokenizeTree(dir, tokenMap, rewrittenFiles) {
  walkTree(dir, function (entry) {
    if (entry.type !== "file") return;
    if (!isTextFile(entry.relPath)) return;
    const abs = entry.absPath;
    let content = "";
    try {
      content = fs.readFileSync(abs, "utf8");
    } catch (_) {
      return;
    }
    const res = tokenizeContent(content, tokenMap);
    if (res.changed) {
      fs.writeFileSync(abs, res.content, "utf8");
      rewrittenFiles.push(relFrom(dir, abs));
    }
  });
}
// ── Export ───────────────────────────────────────────────────────────────────
function cmdExport(args) {
  const slug = requireArg(args, "slug");
  const rootDir = resolvePath(args.root || ".");
  const outDir = resolvePath(args.out || path.join(rootDir, ".agent", "artifacts", "proposal-packages"));
  const withPeers = !(args["no-peers"] === true);
  const withTopology = args["with-topology"] !== false;
  const explicitPeers = args.peers ? args.peers.split(",").map(function (s) { return s.trim(); }).filter(Boolean) : [];
  const explicitMissions = args.missions ? args.missions.split(",").map(function (s) { return s.trim(); }).filter(Boolean) : [];
  const allMissions = args["all-missions"] === true;
  const handoffFile = args.handoff ? resolvePath(args.handoff) : null;

  const pkgRel = path.join(".agent", "plans", "proposals", "projects", slug);
  const pkgDir = path.join(rootDir, pkgRel);

  if (!isDir(pkgDir)) {
    fail("Proposal package not found at standard path", {
      expected: relFrom(rootDir, pkgDir),
      hint: "Standard path is .agent/plans/proposals/projects/<slug>/ with index.md entry",
    });
  }
  if (!isFile(path.join(pkgDir, "index.md"))) {
    fail("Proposal package has no index.md entry", { path: relFrom(rootDir, path.join(pkgDir, "index.md")) });
  }

  const warnings = [];

  // Peer / root discovery
  const discovered = discoverRoots(rootDir, pkgDir, slug, { peers: explicitPeers });
  let peerRoots = discovered.peerRoots.slice();
  if (explicitPeers.length > 0) {
    explicitPeers.forEach(function (p) {
      const abs = path.resolve(rootDir, p);
      if (peerRoots.indexOf(abs) === -1) peerRoots.push(abs);
      if (!isFile(path.join(abs, ".agent", "plans", "proposals", "projects", slug, "index.md"))) {
        warnings.push("explicit peer has no " + slug + " package at standard path: " + abs);
      }
    });
    peerRoots.sort();
  }
  if (!withPeers) peerRoots = [];

  const tokenMap = buildTokenMap(rootDir, discovered.roots, peerRoots);

  // Missions
  const missions = discoverMissions(rootDir, slug, explicitMissions, allMissions);
  missions.missing.forEach(function (id) {
    warnings.push("mission not found: " + id);
  });

  // Staging
  const tsStamp = ts();
  const stagingName = "proposal-share-" + slug + "-" + tsStamp;
  const staging = path.join(outDir, stagingName);
  rmrf(staging);
  mkdirp(staging);

  const manifest = {
    schema_version: PACKAGE_SCHEMA_VERSION,
    package_id: stagingName,
    created_at: nowISO(),
    slug: slug,
    origin: Object.assign({ repo: path.basename(rootDir), root: rootDir }, gitInfo(rootDir)),
    volumes: [],
    missions: [],
    topology: null,
    symlinks: [],
    path_rewrites: { tokens: {}, rewritten_files: [] },
    handoff: null,
    warnings: warnings.slice(),
  };

  // 1. primary volume
  const primDest = path.join(staging, "proposals", "projects", slug);
  const primRes = copyTreeDeref(pkgDir, primDest, "primary");
  manifest.volumes.push({
    repo: path.basename(rootDir),
    role: "primary",
    root_token: tokenForPrimary(tokenMap, rootDir),
    package_path: relFrom(staging, primDest),
    source_root: rootDir,
    files: primRes.copied,
  });
  manifest.symlinks = manifest.symlinks.concat(primRes.symlinks);

  // 2. missions (primary repo)
  missions.included.forEach(function (id) {
    const src = path.join(rootDir, ".agent", "missions", id);
    const dest = path.join(staging, "missions", id);
    const res = copyTreeDeref(src, dest, "missions/" + id);
    manifest.missions.push({ id: id, package_path: relFrom(staging, dest), files: res.copied });
    manifest.symlinks = manifest.symlinks.concat(res.symlinks);
  });

  // 3. topology (primary repo)
  if (withTopology) {
    const topoSrc = path.join(rootDir, ".agent", "topology", "projects.json");
    if (isFile(topoSrc)) {
      const topoDest = path.join(staging, "topology", "projects.json");
      copyFileDeref(topoSrc, topoDest);
      manifest.topology = { package_path: relFrom(staging, topoDest) };
    } else {
      manifest.topology = { package_path: null, note: "no .agent/topology/projects.json in primary repo" };
    }
  }

  // 4. peer volumes (dual-repo joint proposals)
  peerRoots.forEach(function (peerRoot) {
    const peerPkgDir = path.join(peerRoot, ".agent", "plans", "proposals", "projects", slug);
    const peerBase = path.join(staging, "peers", path.basename(peerRoot));
    const peerDest = path.join(peerBase, "proposals", "projects", slug);
    const res = copyTreeDeref(peerPkgDir, peerDest, "peers/" + path.basename(peerRoot) + "/proposals/projects/" + slug);
    manifest.volumes.push({
      repo: path.basename(peerRoot),
      role: "peer",
      root_token: tokenForRoot(tokenMap, peerRoot),
      package_path: relFrom(staging, peerDest),
      source_root: peerRoot,
      files: res.copied,
    });
    manifest.symlinks = manifest.symlinks.concat(res.symlinks);

    // peer missions
    const peerMissions = discoverMissions(peerRoot, slug, [], false);
    peerMissions.included.forEach(function (id) {
      const src = path.join(peerRoot, ".agent", "missions", id);
      const dest = path.join(peerBase, "missions", id);
      const mres = copyTreeDeref(src, dest, "peers/" + path.basename(peerRoot) + "/missions/" + id);
      manifest.missions.push({ id: id, repo: path.basename(peerRoot), package_path: relFrom(staging, dest), files: mres.copied });
      manifest.symlinks = manifest.symlinks.concat(mres.symlinks);
    });

    // peer topology
    const peerTopo = path.join(peerRoot, ".agent", "topology", "projects.json");
    if (withTopology && isFile(peerTopo)) {
      const topoDest = path.join(peerBase, "topology", "projects.json");
      copyFileDeref(peerTopo, topoDest);
      manifest.topology = manifest.topology || {};
      if (!manifest.topology.peers) manifest.topology.peers = [];
      manifest.topology.peers.push({ repo: path.basename(peerRoot), package_path: relFrom(staging, topoDest) });
    }
  });

  // 5. handoff artifact (optional)
  if (handoffFile) {
    if (!isFile(handoffFile)) {
      warnings.push("handoff file not found, skipped: " + handoffFile);
    } else {
      const dest = path.join(staging, "handoffs", path.basename(handoffFile));
      copyFileDeref(handoffFile, dest);
      manifest.handoff = { package_path: relFrom(staging, dest), file: path.basename(handoffFile) };
    }
  }

  // 6. tokenize absolute paths across the staged tree
  const rewrittenFiles = [];
  tokenizeTree(staging, tokenMap, rewrittenFiles);
  manifest.path_rewrites.rewritten_files = rewrittenFiles;
  Object.keys(tokenMap).forEach(function (token) {
    manifest.path_rewrites.tokens[token] = {
      source_root: tokenMap[token].source_root,
      kind: tokenMap[token].kind,
      note: tokenMap[token].note,
    };
  });

  // symlink targets also carry tokens (they may point into peer roots)
  manifest.symlinks.forEach(function (s) {
    const res = tokenizeContent(s.target || "", tokenMap);
    s.target = res.content;
  });

  // 7. README (SHARE guide)
  const readme = buildReadme(manifest, tokenMap, peerRoots, rootDir, tsStamp);
  fs.writeFileSync(path.join(staging, "README.md"), readme, "utf8");

  // 8. MANIFEST
  writeJson(path.join(staging, "MANIFEST.json"), manifest);

  // 9. tar.gz
  const archiveName = "proposal-share-" + slug + "-" + tsStamp + ".tar.gz";
  const archivePath = path.join(outDir, archiveName);
  const tarRes = spawnSync("tar", ["-czf", archivePath, "-C", outDir, stagingName], { encoding: "utf8" });
  if (tarRes.status !== 0) {
    fail("tar failed", { stderr: (tarRes.stderr || "").slice(0, 2000) });
  }
  rmrf(staging);

  const stats = fs.statSync(archivePath);
  print({
    ok: true,
    command: "export",
    slug: slug,
    package: archivePath,
    size_bytes: stats.size,
    volumes: manifest.volumes,
    missions: manifest.missions,
    symlinks: manifest.symlinks.length,
    path_rewrites: {
      tokens: Object.keys(manifest.path_rewrites.tokens),
      rewritten_files: rewrittenFiles.length,
    },
    handoff: manifest.handoff,
    warnings: warnings,
    next: "Share the tar.gz (it is self-contained). Receiver runs: node .agent/scripts/proposal-share.js import --package <file> --root <project-root>",
  });
}

function tokenForPrimary(tokenMap, rootDir) {
  for (const token of Object.keys(tokenMap)) {
    if (tokenMap[token].kind === "primary") return token;
  }
  return null;
}

function tokenForRoot(tokenMap, r) {
  for (const token of Object.keys(tokenMap)) {
    if (tokenMap[token].source_root === r) return token;
  }
  return null;
}

function buildReadme(manifest, tokenMap, peerRoots, rootDir, tsStamp) {
  const lines = [];
  lines.push("# Proposal Package — " + manifest.slug);
  lines.push("");
  lines.push("Self-contained portable proposal package created by /proposal-share (cortex-agent).");
  lines.push("It contains the proposal project directory (proposals / decisions / references / relations),");
  lines.push("linked missions, topology, and any dual-repo peer volumes. It does NOT rely on git.");
  lines.push("");
  lines.push("Created: " + manifest.created_at);
  lines.push("Origin repo: " + manifest.origin.repo + " (root " + manifest.origin.root + ")");
  lines.push("");
  lines.push("## What is inside");
  lines.push("");
  lines.push("- " + BT + "proposals/projects/" + manifest.slug + "/" + BT + " — primary proposal volume (standard path).");
  if (manifest.missions.length) lines.push("- " + BT + "missions/" + BT + " — linked mission dirs (M-xxx).");
  if (manifest.topology) lines.push("- " + BT + "topology/projects.json" + BT + " — topology registry.");
  if (peerRoots.length) lines.push("- " + BT + "peers/" + BT + " — dual-repo peer volumes (" + peerRoots.join(", ") + ").");
  if (manifest.handoff) lines.push("- " + BT + "handoffs/" + BT + " — handoff artifact.");
  lines.push("- " + BT + "MANIFEST.json" + BT + " — machine-readable manifest (schema v" + PACKAGE_SCHEMA_VERSION + ").");
  lines.push("");
  lines.push("## Install (receiver)");
  lines.push("");
  lines.push(BT + BT + BT + "bash");
  lines.push("node .agent/scripts/proposal-share.js import --package <this-file>.tar.gz --root <project-root>");
  lines.push(BT + BT + BT);
  lines.push("");
  lines.push("Or dry-run first to see the plan without writing:");
  lines.push(BT + BT + BT + "bash");
  lines.push("node .agent/scripts/proposal-share.js import --package <this-file>.tar.gz --root <project-root> --dry-run");
  lines.push(BT + BT + BT);
  lines.push("");
  lines.push("## Absolute paths were tokenized");
  lines.push("");
  lines.push("All absolute project roots were replaced with tokens so the package is portable:");
  const tokens = Object.keys(tokenMap).sort();
  tokens.forEach(function (t) {
    const info = tokenMap[t];
    lines.push("- " + BT + t + BT + " → " + info.source_root + "  (" + info.kind + ")");
  });
  lines.push("");
  lines.push("On import, the primary token maps to the target project root. Map peer/other roots with:");
  lines.push(BT + BT + BT + "bash");
  lines.push("--root-map '<repo>=/abs/path,<repo2>=/abs/path'");
  lines.push(BT + BT + BT);
  lines.push("");
  if (manifest.symlinks.length) {
    lines.push("## Symlinks to rebuild");
    lines.push("");
    lines.push("These symlinks were dereferenced into the archive and will be recreated on import:");
    manifest.symlinks.forEach(function (s) {
      lines.push("- " + BT + s.volume + "/" + s.path + BT + " → " + BT + s.target + BT);
    });
    lines.push("");
  }
  if (manifest.warnings.length) {
    lines.push("## Warnings from export");
    lines.push("");
    manifest.warnings.forEach(function (w) {
      lines.push("- " + w);
    });
    lines.push("");
  }
  lines.push("## Notes");
  lines.push("");
  lines.push("- Place each volume at its standard path: " + BT + ".agent/plans/proposals/projects/" + manifest.slug + "/" + BT + ".");
  lines.push("- Peer volumes belong to their own repos; if not mapped with --root-map they are staged under");
  lines.push("  " + BT + ".agent/plans/proposals/imports/" + manifest.slug + "/peers/<repo>/" + BT + " for manual placement.");
  lines.push("- For runtime state (locks, branches, unmerged commits, next actions) use the /handoff workflow;");
  lines.push("  this package carries the proposal directories, not runtime state.");
  lines.push("");
  return lines.join("\n");
}

// ── Shared package validation ────────────────────────────────────────────────
function validatePackageTree(tmpDir) {
  const manifestPath = path.join(tmpDir, "MANIFEST.json");
  const manifest = readJson(manifestPath);
  if (!manifest) {
    return { ok: false, errors: ["MANIFEST.json missing or invalid"], warnings: [], manifest: null };
  }
  const errors = [];
  const warnings = [];
  if (manifest.schema_version !== PACKAGE_SCHEMA_VERSION) {
    errors.push("unsupported schema_version: " + manifest.schema_version);
  }
  if (!manifest.slug) errors.push("manifest.slug missing");
  if (!Array.isArray(manifest.volumes) || manifest.volumes.length === 0) {
    errors.push("manifest.volumes empty");
  }
  // primary volume must satisfy the proposal-structure rule
  const slug = manifest.slug;
  if (slug) {
    const primRel = path.join("proposals", "projects", slug);
    const primDir = path.join(tmpDir, primRel);
    if (!isFile(path.join(primDir, "index.md"))) {
      errors.push("primary volume missing index.md at " + primRel);
    }
    if (!isDir(path.join(primDir, "proposals"))) {
      errors.push("primary volume missing proposals/ at " + primRel);
    }
    const dec = path.join(primDir, "decisions");
    const ref = path.join(primDir, "references.md");
    const rel = path.join(primDir, "relations.md");
    if (!isDir(dec) && !isFile(ref) && !isFile(rel)) {
      warnings.push("primary volume has neither decisions/ nor references.md nor relations.md");
    }
  }
  if (Array.isArray(manifest.missions)) {
    manifest.missions.forEach(function (m) {
      if (!m.package_path || !isDir(path.join(tmpDir, m.package_path))) {
        warnings.push("mission dir missing in package: " + (m.id || m.package_path));
      }
    });
  }
  if (manifest.topology && manifest.topology.package_path && !isFile(path.join(tmpDir, manifest.topology.package_path))) {
    warnings.push("topology file missing in package: " + manifest.topology.package_path);
  }
  // token coverage: any @ROOT: token left in the package that is not declared
  const declared = {};
  if (manifest.path_rewrites && manifest.path_rewrites.tokens) {
    Object.keys(manifest.path_rewrites.tokens).forEach(function (t) {
      declared[t] = true;
    });
  }
  let unresolvedTokens = 0;
  walkTree(tmpDir, function (entry) {
    if (entry.type !== "file") return;
    if (entry.relPath === "MANIFEST.json") return;
    if (!isTextFile(entry.relPath)) return;
    let content = "";
    try {
      content = fs.readFileSync(entry.absPath, "utf8");
    } catch (_) {
      return;
    }
    const re = /@ROOT:[A-Za-z0-9_-]+@/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      if (!declared[m[0]]) {
        unresolvedTokens += 1;
        if (unresolvedTokens <= 5) errors.push("undeclared token in " + entry.relPath + ": " + m[0]);
      }
    }
  });
  if (unresolvedTokens > 5) {
    errors.push("undeclared tokens total: " + unresolvedTokens + " (first 5 listed)");
  }
  return { ok: errors.length === 0, errors: errors, warnings: warnings, manifest: manifest };
}

// Extract a package into a fresh temp dir under baseTmp (project-root-scoped).
// Returns { tmpDir, parent } where tmpDir is the single top-level dir inside.
function extractPackage(pkgFile, baseTmp) {
  if (!isFile(pkgFile)) fail("Package file not found", { path: pkgFile });
  const tmpDir = path.join(baseTmp, ".import-" + ts());
  rmrf(tmpDir);
  mkdirp(tmpDir);
  const tarRes = spawnSync("tar", ["-xzf", pkgFile, "-C", tmpDir], { encoding: "utf8" });
  if (tarRes.status !== 0) {
    rmrf(tmpDir);
    fail("tar extraction failed", { stderr: (tarRes.stderr || "").slice(0, 2000) });
  }
  const entries = fs.readdirSync(tmpDir);
  if (entries.length === 1 && isDir(path.join(tmpDir, entries[0]))) {
    return { tmpDir: path.join(tmpDir, entries[0]), parent: tmpDir };
  }
  return { tmpDir: tmpDir, parent: tmpDir };
}

// ── Verify ───────────────────────────────────────────────────────────────────
function cmdVerify(args) {
  const pkgFile = resolvePath(requireArg(args, "package"));
  const rootDir = resolvePath(args.root || ".");
  const baseTmp = path.join(rootDir, ".agent", "plans", "proposals");
  const ex = extractPackage(pkgFile, baseTmp);
  const result = validatePackageTree(ex.tmpDir);
  const manifest = result.manifest || {};
  const summary = {
    ok: result.ok,
    command: "verify",
    slug: manifest.slug || null,
    package: pkgFile,
    errors: result.errors,
    warnings: result.warnings,
    volumes: Array.isArray(manifest.volumes) ? manifest.volumes.length : 0,
    missions: Array.isArray(manifest.missions) ? manifest.missions.length : 0,
    symlinks: Array.isArray(manifest.symlinks) ? manifest.symlinks.length : 0,
  };
  if (args["keep-tmp"] !== true) {
    rmrf(ex.parent);
    pruneEmptyUp(baseTmp, rootDir);
  }
  print(summary);
  if (!result.ok) process.exitCode = 1;
}

// ── Import ───────────────────────────────────────────────────────────────────
function parseRootMap(value) {
  const map = {};
  if (!value) return map;
  value.split(",").forEach(function (pair) {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key && val) map[key] = val;
  });
  return map;
}

function rewriteTokensInFile(abs, tokenMap) {
  if (!isTextFile(path.basename(abs))) return { changed: false, unresolved: [] };
  let content = "";
  try {
    content = fs.readFileSync(abs, "utf8");
  } catch (_) {
    return { changed: false, unresolved: [] };
  }
  let changed = false;
  const unresolved = [];
  Object.keys(tokenMap).forEach(function (token) {
    const map = tokenMap[token];
    if (map.resolved !== undefined) {
      const before = content;
      content = content.split(token).join(map.resolved);
      if (content !== before) changed = true;
    } else if (content.indexOf(token) !== -1) {
      unresolved.push(token);
    }
  });
  if (changed) fs.writeFileSync(abs, content, "utf8");
  return { changed: changed, unresolved: unresolved };
}

function rewriteTokensInTree(dir, tokenMap) {
  const unresolvedAll = [];
  walkTree(dir, function (entry) {
    if (entry.type !== "file") return;
    const res = rewriteTokensInFile(entry.absPath, tokenMap);
    res.unresolved.forEach(function (t) {
      if (unresolvedAll.indexOf(t) === -1) unresolvedAll.push(t);
    });
  });
  return unresolvedAll;
}

function cmdImport(args) {
  const pkgFile = resolvePath(requireArg(args, "package"));
  const rootDir = resolvePath(args.root || ".");
  const dryRun = args["dry-run"] === true;
  const force = args.force === true;
  const skipMissions = args["skip-missions"] === true;
  const skipTopology = args["skip-topology"] === true;
  const rootMap = parseRootMap(args["root-map"]);

  const baseTmp = path.join(rootDir, ".agent", "plans", "proposals");
  const ex = extractPackage(pkgFile, baseTmp);
  const validation = validatePackageTree(ex.tmpDir);
  const manifest = validation.manifest || {};

  const plan = {
    slug: manifest.slug || null,
    primary_install: null,
    missions: [],
    topology: null,
    peers: [],
    symlinks_to_rebuild: Array.isArray(manifest.symlinks) ? manifest.symlinks.length : 0,
    root_map: rootMap,
    unresolved_tokens: [],
    errors: validation.errors,
    warnings: validation.warnings,
  };

  // token resolution
  const tokenMap = {};
  const tokens = (manifest.path_rewrites && manifest.path_rewrites.tokens) || {};
  Object.keys(tokens).forEach(function (token) {
    const info = tokens[token];
    let resolved;
    if (info.kind === "primary") {
      resolved = rootDir;
    } else {
      const repoKey = token.replace(/^@ROOT:/, "").replace(/@$/, "");
      resolved = rootMap[repoKey] || rootMap[info.source_root] || undefined;
    }
    tokenMap[token] = { resolved: resolved, kind: info.kind, repo_hint: info.source_root };
    if (resolved === undefined) {
      plan.unresolved_tokens.push(token);
    }
  });

  // Where each volume goes. installBase keys mirror the volume strings used
  // during export ("primary", "missions/<id>", "peers/<repo>/proposals/projects/<slug>",
  // "peers/<repo>/missions/<id>") so symlinks can be rebuilt at the right place.
  const installBase = {};
  function peerBase(repo) {
    const repoKey = tokenForRepoKey(repo);
    const mapped = rootMap[repoKey] || rootMap[repo] || undefined;
    if (mapped) return { mapped: true, root: mapped };
    const staged = path.join(rootDir, ".agent", "plans", "proposals", "imports", manifest.slug || "", "peers", repo);
    plan.peers.push({ repo: repo, staged: true, target: staged });
    return { mapped: false, root: staged };
  }
  if (manifest.slug) {
    plan.primary_install = path.join(rootDir, ".agent", "plans", "proposals", "projects", manifest.slug);
    installBase["primary"] = plan.primary_install;
  }
  if (Array.isArray(manifest.volumes)) {
    manifest.volumes.forEach(function (v) {
      if (v.role !== "peer") return;
      const pb = peerBase(v.repo);
      installBase["peers/" + v.repo + "/proposals/projects/" + manifest.slug] = pb.mapped
        ? path.join(pb.root, ".agent", "plans", "proposals", "projects", manifest.slug)
        : path.join(pb.root, "proposals", "projects", manifest.slug);
    });
  }
  if (Array.isArray(manifest.missions)) {
    manifest.missions.forEach(function (m) {
      if (m.repo) {
        const pb = peerBase(m.repo);
        installBase["peers/" + m.repo + "/missions/" + m.id] = pb.mapped
          ? path.join(pb.root, ".agent", "missions", m.id)
          : path.join(pb.root, "missions", m.id);
      } else {
        installBase["missions/" + m.id] = path.join(rootDir, ".agent", "missions", m.id);
      }
    });
  }

  if (!dryRun && !validation.ok) {
    rmrf(ex.parent);
    fail("Package validation failed", { errors: validation.errors });
  }

  // ---- dry run report ----
  if (dryRun) {
    plan.ok = validation.ok;
    plan.dry_run = true;
    if (!skipMissions) {
      (manifest.missions || []).forEach(function (m) {
        plan.missions.push(path.join(rootDir, ".agent", "missions", m.id));
      });
    }
    if (!skipTopology && manifest.topology && manifest.topology.package_path) {
      plan.topology = path.join(rootDir, ".agent", "topology", "projects.json");
    }
    if (args["keep-tmp"] !== true) {
      rmrf(ex.parent);
      pruneEmptyUp(baseTmp, rootDir);
    }
    print(plan);
    if (!validation.ok) process.exitCode = 1;
    return;
  }

  // ---- install ----
  const results = { installed: [], skipped: [], merged: [] };

  // primary volume
  if (plan.primary_install) {
    const src = path.join(ex.tmpDir, "proposals", "projects", manifest.slug);
    if (isDir(plan.primary_install) && !force) {
      rmrf(ex.parent);
      fail("Target primary volume already exists; pass --force to overwrite", { path: relFrom(rootDir, plan.primary_install) });
    }
    if (isDir(plan.primary_install)) rmrf(plan.primary_install);
    copyTreeDeref(src, plan.primary_install, "primary");
    results.installed.push(relFrom(rootDir, plan.primary_install));
  }

  // missions
  if (!skipMissions) {
    (manifest.missions || []).forEach(function (m) {
      const src = path.join(ex.tmpDir, m.package_path);
      const dest = path.join(rootDir, ".agent", "missions", m.id);
      if (isDir(dest) && !force) {
        results.skipped.push("mission exists (use --force): " + m.id);
        return;
      }
      if (isDir(dest)) rmrf(dest);
      copyTreeDeref(src, dest, "missions/" + m.id);
      results.installed.push(relFrom(rootDir, dest));
      plan.missions.push(dest);
    });
  }

  // topology (merge)
  if (!skipTopology && manifest.topology && manifest.topology.package_path) {
    const src = path.join(ex.tmpDir, manifest.topology.package_path);
    const dest = path.join(rootDir, ".agent", "topology", "projects.json");
    const incoming = readJson(src) || {};
    const existing = readJson(dest) || {};
    if (Object.keys(existing).length === 0) {
      copyFileDeref(src, dest);
      results.installed.push(relFrom(rootDir, dest));
    } else {
      const merged = mergeTopology(existing, incoming);
      writeJson(dest, merged);
      results.merged.push(relFrom(rootDir, dest));
    }
    plan.topology = dest;
  }

  // peer volumes:
  //   mapped  -> install each section to the peer repo's standard .agent paths
  //              (.agent/plans/proposals/projects/<slug>, .agent/missions/<id>,
  //               .agent/topology/projects.json); existing files are merged,
  //              never deleted.
  //   unmapped -> stage the whole peers/<repo> tree under
  //               .agent/plans/proposals/imports/<slug>/peers/<repo> for manual
  //               placement, with tokens left intact.
  const peerRepos = {};
  (manifest.volumes || []).forEach(function (v) {
    if (v.role === "peer") peerRepos[v.repo] = true;
  });
  Object.keys(peerRepos).forEach(function (repoName) {
    const src = path.join(ex.tmpDir, "peers", repoName);
    if (!isDir(src)) return;
    const pb = peerBase(repoName);
    if (!pb.mapped) {
      const dest = pb.root;
      if (isDir(dest) && !force) {
        results.skipped.push("peer staged dir exists (use --force): " + repoName);
        return;
      }
      if (isDir(dest)) rmrf(dest);
      copyTreeDeref(src, dest, "peers/" + repoName);
      results.installed.push(relFrom(rootDir, dest));
      return;
    }
    // mapped peer: section install to standard paths
    const proposalsSrc = path.join(src, "proposals", "projects", manifest.slug);
    const proposalsDest = installBase["peers/" + repoName + "/proposals/projects/" + manifest.slug];
    if (isDir(proposalsSrc) && proposalsDest) {
      copyTreeDeref(proposalsSrc, proposalsDest, "peers/" + repoName + "/proposals/projects/" + manifest.slug);
      results.installed.push("peer proposals (merged into " + relFrom(rootDir, proposalsDest) + ")");
    }
    (manifest.missions || []).forEach(function (m) {
      if (m.repo !== repoName) return;
      const mSrc = path.join(ex.tmpDir, m.package_path);
      const mDest = installBase["peers/" + repoName + "/missions/" + m.id];
      if (isDir(mSrc) && mDest) {
        copyTreeDeref(mSrc, mDest, "peers/" + repoName + "/missions/" + m.id);
        results.installed.push("peer mission (merged into " + relFrom(rootDir, mDest) + ")");
      }
    });
    const topoSrc = path.join(src, "topology", "projects.json");
    if (isFile(topoSrc)) {
      const topoDest = path.join(pb.root, ".agent", "topology", "projects.json");
      const incoming = readJson(topoSrc) || {};
      const existing = readJson(topoDest) || {};
      if (Object.keys(existing).length === 0) {
        copyFileDeref(topoSrc, topoDest);
      } else {
        writeJson(topoDest, mergeTopology(existing, incoming));
      }
      results.installed.push("peer topology (merged into " + relFrom(rootDir, topoDest) + ")");
    }
  });

  // token rewrite on installed targets
  const rewriteTargets = [];
  if (plan.primary_install) rewriteTargets.push(plan.primary_install);
  plan.missions.forEach(function (d) {
    rewriteTargets.push(d);
  });
  if (plan.topology) rewriteTargets.push(path.dirname(plan.topology));
  Object.keys(installBase).forEach(function (volKey) {
    if (volKey !== "primary") rewriteTargets.push(installBase[volKey]);
  });
  const unresolvedAll = [];
  rewriteTargets.forEach(function (dir) {
    if (!isDir(dir)) return;
    const un = rewriteTokensInTree(dir, tokenMap);
    un.forEach(function (t) {
      if (unresolvedAll.indexOf(t) === -1) unresolvedAll.push(t);
    });
  });
  plan.unresolved_tokens = unresolvedAll;

  // symlink rebuild
  const rebuilt = [];
  const broken = [];
  (manifest.symlinks || []).forEach(function (s) {
    const base = installBase[s.volume];
    if (!base) {
      broken.push({ volume: s.volume, path: s.path, reason: "no install base" });
      return;
    }
    const linkPath = path.join(base, s.path);
    const target = restoreContent(s.target || "", tokenMap);
    mkdirp(path.dirname(linkPath));
    try {
      if (isSymlink(linkPath) || isFile(linkPath)) fs.unlinkSync(linkPath);
      fs.symlinkSync(target, linkPath);
      rebuilt.push({ volume: s.volume, path: s.path, target: target });
    } catch (e) {
      broken.push({ volume: s.volume, path: s.path, reason: e.message });
    }
  });
  results.rebuilt = rebuilt;
  results.broken_symlinks = broken;

  if (args["keep-tmp"] !== true) rmrf(ex.parent);

  print({
    ok: true,
    command: "import",
    slug: manifest.slug,
    root: rootDir,
    installed: results.installed,
    skipped: results.skipped,
    merged: results.merged,
    symlinks_rebuilt: rebuilt.length,
    broken_symlinks: broken,
    unresolved_tokens: unresolvedAll,
    warnings: validation.warnings,
    next: "Verify with: node .agent/scripts/proposal-share.js verify --package " + pkgFile,
  });
}

function tokenForRepoKey(repoName) {
  return "@ROOT:" + repoName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") + "@";
}

function mergeTopology(existing, incoming) {
  const out = JSON.parse(JSON.stringify(existing || {}));
  if (!out.self && incoming.self) out.self = incoming.self;
  if (!out.peers) out.peers = [];
  const known = {};
  out.peers.forEach(function (p) {
    if (p && p.project_id) known[p.project_id] = true;
  });
  (incoming.peers || []).forEach(function (p) {
    if (p && p.project_id && !known[p.project_id]) out.peers.push(p);
  });
  return out;
}

// ── Main ─────────────────────────────────────────────────────────────────────
const cmdIndex = process.argv.slice(2).findIndex(function (a) {
  return !a.startsWith("--");
});
const cmd = cmdIndex === -1 ? null : process.argv.slice(2)[cmdIndex];
const args = parseArgs(process.argv.slice(2));

if (args.help || args.h || cmd === "help" || !cmd) {
  usage();
  process.exit(0);
}

if (cmd === "export") cmdExport(args);
else if (cmd === "import") cmdImport(args);
else if (cmd === "verify") cmdVerify(args);
else fail("Unknown command: " + cmd + " (expected export | import | verify)");