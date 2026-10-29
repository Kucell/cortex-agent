#!/usr/bin/env python3
"""Exact-candidate source pack and offline local-tar fixture acceptance.

No registry publication/install, Host execution, real project, or full-suite
claim is made. Run only in a disposable checkout at the reviewed final head.
Requires preinstalled Node/npm/Git/Python; installs no test dependencies.
"""
import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import stat
import subprocess
import tarfile
import tempfile

def require(condition, message):
    if not condition:
        raise AssertionError(message)

def digest(data, algorithm="sha256"):
    return hashlib.new(algorithm, data).hexdigest()

def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))

def terminate_group(process):
    """Bounded cleanup for the reviewed cooperating POSIX process group."""
    def send(sig):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            pass
    send(signal.SIGTERM)
    try:
        process.communicate(timeout=2)
    except subprocess.TimeoutExpired:
        pass
    finally:
        # Always kill the group, even if its leader exited during the grace.
        send(signal.SIGKILL)
    try:
        process.communicate(timeout=2)
    except subprocess.TimeoutExpired as error:
        for stream in (process.stdout, process.stderr):
            if stream:
                stream.close()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            raise AssertionError("process-group cleanup did not reap leader") from error
        raise AssertionError("process-group cleanup did not close inherited pipes") from error

def run(argv, cwd, env, expected=0, timeout=120):
    require(os.name == "posix", "POSIX disposable executor required")
    process = subprocess.Popen([str(x) for x in argv], cwd=cwd, env=env,
                               text=True, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               start_new_session=True)
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired as error:
        terminate_group(process)
        raise AssertionError("command timeout after process-group cleanup: " + str(argv)) from error
    except BaseException:
        terminate_group(process)
        raise
    require(process.returncode == expected,
            "command failed: " + str(argv) + "\n" + stdout + "\n" + stderr)
    return stdout

def snapshot(root):
    rows = {}
    def visit(path):
        info = path.lstat()
        relative = path.relative_to(root).as_posix()
        row = {"mode": stat.S_IMODE(info.st_mode), "mtime_ns": info.st_mtime_ns}
        if path.is_symlink():
            row["link"] = os.readlink(path)
        elif path.is_dir():
            row["kind"] = "directory"
        elif path.is_file():
            row["sha256"] = digest(path.read_bytes())
        else:
            raise AssertionError("unexpected fixture file type: " + relative)
        rows[relative] = row
        if path.is_dir() and not path.is_symlink():
            for entry in sorted(path.iterdir()):
                visit(entry)
    visit(root)
    return rows

def plugin_components(plugin, names):
    """Validate this package's path-only component contract, not a Host install."""
    names = set(names)
    result = {}
    for kind in ["commands", "agents", "skills"]:
        declared = plugin.get(kind)
        paths = [declared] if isinstance(declared, str) else declared
        require(isinstance(paths, list) and paths, "plugin component paths missing: " + kind)
        files = []
        for value in paths:
            require(isinstance(value, str) and value.startswith("./") and
                    "\\" not in value and "//" not in value,
                    "unsafe plugin component path")
            relative = value[2:].rstrip("/")
            require(relative and ".." not in PurePosixPath(relative).parts and
                    relative == PurePosixPath(relative).as_posix() and
                    not PurePosixPath(relative).is_absolute(), "unsafe plugin component path")
            if kind == "agents":
                matched = [relative] if (relative in names and relative.endswith(".md") and
                                          not value.endswith("/")) else []
            elif kind == "commands":
                if relative in names and relative.endswith(".md"):
                    matched = [relative]
                else:
                    matched = sorted(name for name in names if name.endswith(".md") and
                                     PurePosixPath(name).parent.as_posix() == relative)
            else:
                direct = relative + "/SKILL.md"
                matched = [direct] if direct in names else sorted(
                    name for name in names if PurePosixPath(name).name == "SKILL.md" and
                    PurePosixPath(name).parent.parent.as_posix() == relative)
            require(matched, "plugin component is missing or wrong type: " + kind + ":" + relative)
            files.extend(matched)
        identities = [PurePosixPath(name).parent.name if kind == "skills"
                      else PurePosixPath(name).stem for name in files]
        require(len(set(identities)) == len(identities), "duplicate plugin component: " + kind)
        result[kind] = sorted(files)
    return result

def check_plugin_component_oracle():
    names = {"workflows/start.md", "agents/reviewer.md", "skills/review/SKILL.md"}
    valid = {"commands": "./workflows/", "agents": ["./agents/reviewer.md"],
             "skills": "./skills/"}
    require(plugin_components(valid, names) == {
        "commands": ["workflows/start.md"], "agents": ["agents/reviewer.md"],
        "skills": ["skills/review/SKILL.md"]}, "plugin path oracle positive case")
    invalid = [
        {**valid, "commands": "./missing/"},
        {**valid, "commands": "./../workflows/"},
        {**valid, "commands": "./workflows//"},
        {**valid, "agents": "./agents/"},
        {**valid, "agents": "./agents/reviewer.md/"},
        {**valid, "agents": []},
        {**valid, "skills": "./agents/"},
        {**valid, "commands": ["./workflows/", "./workflows/start.md"]},
    ]
    for case in invalid:
        try:
            plugin_components(case, names)
        except AssertionError:
            continue
        raise AssertionError("plugin path oracle accepted a negative case")

def main():
    check_plugin_component_oracle()
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected-head", required=True)
    parser.add_argument("--expected-version", required=True)
    parser.add_argument("--expected-gitlink", required=True)
    args = parser.parse_args()
    require(re.fullmatch(r"[0-9a-f]{40}", args.expected_head), "expected commit SHA required")
    require(re.fullmatch(r"[0-9a-f]{40}", args.expected_gitlink), "expected gitlink SHA required")
    require(re.fullmatch(r"\d+\.\d+\.\d+", args.expected_version), "stable candidate version required")
    source = Path(__file__).resolve().parents[2]
    binding = source / ".agent"
    require(not binding.is_symlink() and
            (not binding.exists() or (binding.is_dir() and not any(binding.iterdir()))),
            "source governance gitlink must remain absent or an empty directory")
    tools = {name: shutil.which(name) for name in ["git", "node", "npm"]}
    require(all(tools.values()), "preinstalled git/node/npm required")
    with tempfile.TemporaryDirectory(prefix="cortex-pack-") as temporary:
        scratch = Path(temporary)
        npm_tmp = scratch / "npm-tmp"
        npm_tmp.mkdir()
        npm_home = scratch / "npm-home"
        npm_home.mkdir()
        cache = scratch / "empty-npm-cache"
        cache.mkdir()
        user_config = scratch / "user.npmrc"
        global_config = scratch / "global.npmrc"
        user_config.write_text("", encoding="utf-8")
        global_config.write_text("", encoding="utf-8")
        npm_path = os.pathsep.join(dict.fromkeys(str(Path(tools[n]).parent) for n in ["npm", "node"]))
        env = {
            "PATH": npm_path, "HOME": str(npm_home), "USERPROFILE": str(npm_home),
            "LANG": "C", "LC_ALL": "C", "CI": "true",
            "TMPDIR": str(npm_tmp), "TMP": str(npm_tmp), "TEMP": str(npm_tmp),
            "GIT_CONFIG_NOSYSTEM": "1",
            "NPM_CONFIG_USERCONFIG": str(user_config), "NPM_CONFIG_GLOBALCONFIG": str(global_config),
            "NPM_CONFIG_CACHE": str(cache), "NPM_CONFIG_UPDATE_NOTIFIER": "false",
            "NPM_CONFIG_AUDIT": "false", "NPM_CONFIG_FUND": "false",
        }
        def git(*command):
            return run([tools["git"], "-c", "core.fsmonitor=false", *command], source, env)
        require(git("rev-parse", "HEAD").strip() == args.expected_head, "candidate head drift")
        require(not git("status", "--porcelain", "--untracked-files=all").strip(), "checkout is not clean")
        require(not list(source.rglob(".npmrc")), "candidate npm config requires separate review")
        tree = {}
        for record in git("ls-tree", "-rz", "--full-tree", "HEAD").split("\0"):
            if not record:
                continue
            metadata, name = record.split("\t", 1)
            mode, kind, oid = metadata.split()
            tree[name] = {"mode": mode, "type": kind, "blob": oid}
        require(tree[".agent"]["mode"] == "160000", "governance must remain a gitlink")
        require(tree[".agent"]["blob"] == args.expected_gitlink, "governance gitlink drift")
        require(not any(name == "skills" or name.startswith("skills/") for name in tree),
                "default root skills would duplicate the explicit plugin skills path")
        pkg = read_json(source / "package.json")
        require(pkg["name"] == "cortex-agent" and pkg["version"] == args.expected_version,
                "candidate package/version mismatch")
        for key in ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies",
                    "bundledDependencies", "bundleDependencies", "workspaces"]:
            require(not pkg.get(key), "root dependency/workspace surface changed: " + key)
        hooks = {"preinstall", "install", "postinstall", "prepare", "prepack", "postpack",
                 "prepublish", "prepublishOnly", "publish", "postpublish"}
        require(not (hooks & set(pkg.get("scripts", {}))), "lifecycle hook requires separate review")
        lock = read_json(source / "package-lock.json")
        plugin = read_json(source / ".claude-plugin/plugin.json")
        market = read_json(source / ".claude-plugin/marketplace.json")
        require(set(lock["packages"]) == {""}, "root lock dependency surface changed")
        versions = [lock["version"], lock["packages"][""]["version"], plugin["version"],
                    market["metadata"]["version"]]
        entries = [x for x in market["plugins"] if x["name"] == pkg["name"]]
        require(len(entries) == 1, "ambiguous plugin metadata")
        versions.append(entries[0]["version"])
        require(all(v == args.expected_version for v in versions), "version metadata differs")
        require(lock["name"] == pkg["name"] and lock["packages"][""]["engines"] == pkg["engines"],
                "root lock metadata mismatch")
        require("## [" + args.expected_version + "]" in (source / "CHANGELOG.md").read_text(),
                "missing current version changelog")
        # The template tree is layered: _shared carries the language-neutral
        # copy, and en/zh only override a path when the language genuinely
        # differs. evolve.js is language-neutral, so it exists once, under
        # _shared. A language overlay that reintroduces its own copy would
        # reintroduce the drift this layering removed.
        evolve_path = "templates/_shared/.agent/skills/evolution-pipeline/scripts/evolve.js"
        evolve_overlays = [
            "templates/" + language + "/.agent/skills/evolution-pipeline/scripts/evolve.js"
            for language in ["en", "zh"]
        ]
        require(evolve_path in tree,
                "final head must include the reviewed shared proposal implementation")
        require(all(p not in tree for p in evolve_overlays),
                "language overlay reintroduces the shared evolve implementation")
        for language in ["_shared", "en", "zh", "_base"]:
            require(not (source / ("templates/" + language +
                    "/.agent/skills/self-check/scripts/index.js")).exists(),
                    "new self-check subprocess needs separate review")
        packs = scratch / "pack"
        packs.mkdir()
        pack = json.loads(run([tools["npm"], "pack", "--ignore-scripts", "--offline", "--json",
                               "--pack-destination", packs], source, env))
        require(len(pack) == 1, "expected one package")
        filename = pack[0]["filename"]
        require(Path(filename).name == filename and filename.endswith(".tgz"), "unexpected tar name")
        archive = packs / filename
        raw = archive.read_bytes()
        sri = "sha512-" + base64.b64encode(hashlib.sha512(raw).digest()).decode()
        require(pack[0]["integrity"] == sri, "npm integrity mismatch")
        manifest = {}
        with tarfile.open(archive, "r:gz") as tar:
            for member in tar.getmembers():
                name = member.name
                if member.isdir() and name in ["package", "package/"]:
                    continue
                require(name.startswith("package/") and "\\" not in name, "unsafe tar member")
                relative = name[len("package/"):]
                require(relative and ".." not in PurePosixPath(relative).parts and
                        not PurePosixPath(relative).is_absolute(), "unsafe tar path")
                require(not member.mode & 0o7000, "special tar permission bits")
                if member.isdir():
                    continue
                require(member.isfile(), "links/special tar members need separate review")
                require(relative not in manifest, "duplicate tar member")
                require(relative in tree and tree[relative]["mode"] in ["100644", "100755"],
                        "untracked or transformed package member: " + relative)
                data = tar.extractfile(member).read()
                blob = digest(b"blob " + str(len(data)).encode() + b"\0" + data, "sha1")
                require(blob == tree[relative]["blob"], "source bytes mismatch: " + relative)
                manifest[relative] = {
                    "size": len(data), "sha256": digest(data), "git_blob_sha1": blob,
                    "git_mode": tree[relative]["mode"], "tar_mode": member.mode,
                }
        require(set(manifest) == {entry["path"] for entry in pack[0]["files"]},
                "npm file list differs from tar")
        source_components = plugin_components(plugin, [name for name, entry in tree.items()
                                    if entry["mode"] in ["100644", "100755"]])
        packed_components = plugin_components(plugin, manifest)
        require(packed_components == source_components, "plugin components omitted from tar")
        require("templates/_shared/.agent/workflows/cortex-setup.md" in packed_components["commands"],
                "advertised cortex-setup command is absent")
        required = [
            "package.json", "bin/cli.js", "bin/cortex-claude-hook",
            "lib/commands/session.js", "lib/commands/init.js", "lib/commands/upgrade.js",
            "lib/commands/reconcile.js", "lib/commands/update/runtime-layout-migration.js",
            "lib/evolution/reasoning-handoff.js", "lib/next-action/index.js",
            "lib/next-action/canonical-task-source.js", "packages/protocol/src/evolution.js",
            ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json",
        ] + [evolve_path]
        for relative in required:
            require(relative in manifest, "required shipped file absent: " + relative)
        require(manifest["bin/cli.js"]["tar_mode"] & 0o111, "CLI tar member is not executable")
        for name, entry in tree.items():
            if entry["mode"] not in ["100644", "100755"]:
                continue
            if any(name.startswith("templates/" + language + "/.agent/skills/" + skill + "/")
                   for language in ["_shared", "en", "zh"]
                   for skill in ["evolution-pipeline", "runtime-continuity"]):
                require(name in manifest, "feature support file absent: " + name)
        prefix = scratch / "consumer"
        prefix.mkdir()
        (prefix / "package.json").write_text('{"name":"offline-fixture","private":true}\n')
        run([tools["npm"], "install", archive, "--ignore-scripts", "--offline", "--no-audit",
             "--no-fund", "--no-package-lock", "--workspaces=false"], prefix, env)
        installed = prefix / "node_modules/cortex-agent"
        require(installed.is_dir() and not installed.is_symlink(), "local tar was not materialized")
        for relative, row in manifest.items():
            file = installed / relative
            require(file.is_file() and not file.is_symlink() and
                    digest(file.read_bytes()) == row["sha256"], "installed bytes mismatch: " + relative)
        extras = {x.name for x in (prefix / "node_modules").iterdir()}
        require(extras <= {"cortex-agent", ".bin", ".package-lock.json"}, "unexpected installed dependency")
        require((prefix / "node_modules/.bin/cortex-agent").resolve() == installed / "bin/cli.js",
                "installed CLI bin link mismatch")
        node = str(Path(tools["node"]).resolve())
        node_only = scratch / "node-only"
        node_only.mkdir()
        (node_only / "node").symlink_to(node)
        control = scratch / "control"
        control.mkdir()
        audit = control / "audit.jsonl"
        audit.write_text("")
        guard = control / "boundary.cjs"
        shutil.copyfile(source / "scripts/release/offline-package-boundary.cjs", guard)
        boundary_config = control / "boundary.json"
        observations = []
        def fixture(name):
            root = scratch / name
            project = root / "project"
            home = root / "home"
            project.mkdir(parents=True)
            home.mkdir()
            (root / "tmp").mkdir()
            return root, project, home
        def invoke(project, home, command, expected=0, node_calls=None, use_node_path=False):
            policy = {
                "node": node, "audit": str(audit), "nodeCalls": node_calls or [],
                "cwd": str(project.resolve()),
                "gitArgs": [
                    ["rev-parse", "--show-toplevel"], ["rev-parse", "--abbrev-ref", "HEAD"],
                    ["rev-parse", "--short", "HEAD"], ["status", "--short"],
                    ["log", "--oneline", "-3"], ["diff", "--name-only", "HEAD"],
                ],
                "shellCommands": ["git worktree list --porcelain", "git status --short --branch"],
            }
            child_env = {
                "HOME": str(home), "USERPROFILE": str(home), "XDG_CONFIG_HOME": str(home),
                "PATH": str(node_only) if use_node_path else "", "LANG": "C", "LC_ALL": "C",
                "TZ": "UTC", "CI": "true", "CORTEX_STATE_SYNC": "off",
                "TMPDIR": str(project.parent / "tmp"), "TMP": str(project.parent / "tmp"),
                "TEMP": str(project.parent / "tmp"), "GIT_CONFIG_NOSYSTEM": "1",
                "NODE_OPTIONS": "--require=" + str(guard),
                "CORTEX_PACK_BOUNDARY_CONFIG": str(boundary_config),
            }
            policy["env"] = child_env
            boundary_config.write_text(json.dumps(policy))
            result = run([node, *command], project, child_env, expected=expected, timeout=90)
            events = [json.loads(line) for line in audit.read_text().splitlines()]
            require(all(row["allowed"] for row in events), "caught boundary denial")
            observations.append({"command": command[1:], "expected_exit": expected, "actual_exit": expected})
            return result
        cli = str(installed / "bin/cli.js")
        root, project, home = fixture("read-only")
        before = snapshot(root)
        require(invoke(project, home, [cli, "--version"]).strip() == args.expected_version,
                "installed CLI version mismatch")
        require("update" in invoke(project, home, [cli, "--help"]), "CLI help missing update")
        invoke(project, home, [cli, "update", "--help"])
        invoke(project, home, [cli, "reconcile"])
        require(snapshot(root) == before, "read-only CLI changed project/HOME")
        continuity = installed / "templates/_shared/.agent/skills/runtime-continuity/scripts/index.js"
        evolve = installed / evolve_paths[0]
        private_marker = "SYNTHETIC_ARCHIVE_TEXT_MUST_NOT_ENTER_PROPOSAL"
        for opt_in in [False, True]:
            root, project, home = fixture("archive-opt-in" if opt_in else "archive-default")
            tail = ["archive", "--project", "fixture", "--gate", "user", "--note-json",
                    json.dumps({"done": [private_marker], "next": [], "blockers": []})]
            if opt_in:
                tail.append("--queue-learning-proposal")
            rule = {"file": str(continuity), "args": tail,
                    "sha256": [digest(continuity.read_bytes())]}
            result = json.loads(invoke(project, home, [cli, "session", *tail], node_calls=[rule]))
            require(result.get("ok") is True, "actual installed session archive failed")
            tasks = project / ".agent/tasks/evolution"
            require(not (project / ".agent/memory").exists() and not (home / ".agent/memory").exists(),
                    "archive created memory")
            if not opt_in:
                require(not tasks.exists() and "learning_proposal" not in result,
                        "default archive silently enabled proposal intake")
                continue
            require(result["learning_proposal"]["status"] == "queued", "proposal intake unavailable")
            require(result["learning_proposal"]["execution_authorized"] is False, "proposal authorized execution")
            queued = list(tasks.glob("*.json"))
            require(len(queued) == 1, "unexpected proposal queue")
            task = read_json(queued[0])
            require(task["kind"] == "archive_learning_proposal" and
                    task["execution_authorized"] is False and task["allowed_effects"] == [],
                    "proposal task authorization changed")
            processed = json.loads(invoke(project, home,
                [str(evolve), "--worker", "--once", "--proposal-only"]))
            require(processed.get("processed") == 1 and processed["task"]["status"] == "proposal_only",
                    "proposal worker did not create proposal-only output")
            proposed = list((tasks / "_proposals").glob("*.json"))
            require(len(proposed) == 1 and private_marker not in proposed[0].read_text() and
                    private_marker not in queued[0].read_text(), "proposal copied private fixture text")
            require(not (project / ".agent/memory").exists() and not (home / ".agent/memory").exists(),
                    "proposal created memory")
            stable = snapshot(root)
            again = json.loads(invoke(project, home,
                [str(evolve), "--worker", "--once", "--proposal-only"]))
            require(again.get("processed") == 0 and snapshot(root) == stable,
                    "second worker changed a completed proposal")
        # This is a synthetic earlier-installed framework fixture, not a
        # downloaded or upgraded older npm registry release.
        for language in ["en", "zh"]:
            shared = installed / "templates/_shared/.agent"
            localized = installed / ("templates/" + language + "/.agent")
            origins = {}
            for template in [localized, shared]:
                for file in template.rglob("*.js"):
                    if file.is_file() and not file.is_symlink():
                        origins[file.relative_to(template).as_posix()] = digest(file.read_bytes())
            target_rel = "skills/evolution-pipeline/scripts/evolve.js"
            for modified in [False, True]:
                root, project, home = fixture("update-" + language + ("-modified" if modified else "-managed"))
                agent = project / ".agent"
                target = agent / target_rel
                target.parent.mkdir(parents=True)
                old = b"// synthetic previous framework fixture\n"
                current = b"// synthetic project customization\n" if modified else old
                target.write_bytes(current)
                ledger = {name: {"origin_hash": value, "sha256": value, "ownership_proof": "template_match"}
                          for name, value in origins.items()}
                ledger[target_rel] = {"origin_hash": digest(old), "sha256": digest(old),
                                      "ownership_proof": "template_match"}
                (agent / ".script-manifest.json").write_text(json.dumps({"schema_version": 1, "scripts": ledger}))
                version_file = agent / ".cortex-version"
                version_file.write_text("synthetic-previous-version\n")
                protected = agent / "customer-owned.fixture"
                protected.write_text("preserve exact synthetic customer content\n")
                sentinel = protected.read_bytes()
                stable = snapshot(root)
                invoke(project, home, [cli, "upgrade", "--lang", language, "--track", "--dry-run"])
                require(snapshot(root) == stable, "upgrade dry-run changed bytes/mode/mtime")
                calls = []
                runtime_rel = "skills/runtime-continuity/scripts/index.js"
                management_rel = "skills/management-api/scripts/index.js"
                today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
                for relative, tails in [
                    (runtime_rel, [["resume-bundle", "--project", "project"]]),
                    (management_rel, [["query", "capabilities"], ["query", "dashboard-state"],
                                      ["query", "activity", "--since", today]]),
                ]:
                    hashes = [digest((template / relative).read_bytes()) for template in [shared, localized]
                              if (template / relative).is_file()]
                    for tail in tails:
                        calls.append({"file": str(agent / relative), "args": tail, "sha256": hashes})
                invoke(project, home, [cli, "upgrade", "--lang", language, "--track"],
                       node_calls=calls, use_node_path=True)
                require(target.read_bytes() == current and protected.read_bytes() == sentinel,
                        "additive upgrade replaced customer content")
                invoke(project, home, [cli, "update", "--lang", language, "--track"],
                       expected=2 if modified else 0, node_calls=calls, use_node_path=True)
                report = read_json(agent / "updates/latest.json")
                require(protected.read_bytes() == sentinel, "safe update modified customer sentinel")
                if modified:
                    require(target.read_bytes() == current and report["status"] == "partial" and
                            version_file.read_text() == "synthetic-previous-version\n",
                            "modified file/version was not preserved")
                    require(any(x["path"] == ".agent/" + target_rel and x["reason"] == "user_modified"
                                for x in report["changes"]["protected"]), "missing protected-script report")
                else:
                    require(target.read_bytes() == (localized / target_rel).read_bytes() and
                            report["status"] == "passed" and
                            version_file.read_text().strip() == args.expected_version,
                            "managed update did not install current bytes/version")
                require(not (project / ".git").exists() and not (agent / ".git").exists(),
                        "fixture unexpectedly created Git state")
        require(git("rev-parse", "HEAD").strip() == args.expected_head and
                not git("status", "--porcelain", "--untracked-files=all").strip(), "source changed during acceptance")
        plugin_paths = {kind: bool(files) for kind, files in packed_components.items()}
        evidence = {
            "schema_version": 1, "status": "passed", "scope": "source-pack-and-offline-local-tar-fixtures",
            "source_head": args.expected_head, "source_tree": git("rev-parse", "HEAD^{tree}").strip(),
            "actual_governance_gitlink": args.expected_gitlink, "package": pkg["name"],
            "version": args.expected_version, "node": run([node, "--version"], source, env).strip(),
            "npm": run([tools["npm"], "--version"], source, env).strip(),
            "tar": {"filename": filename, "bytes": len(raw), "sha256": digest(raw),
                    "sha512": digest(raw, "sha512"), "integrity": sri},
            "files": manifest, "commands": observations,
            "boundary": {"denied": 0, "audit_entries": len(audit.read_text().splitlines()),
                         "scope": "audited network/subprocess instrumentation; not an OS filesystem sandbox"},
            "plugin_entrypoint_paths_present": plugin_paths,
            "plugin_component_files": packed_components,
            "plugin_component_counts": {kind: len(files) for kind, files in packed_components.items()},
            "plugin_validation_scope": "tar path/type/member closure only; not the official Host validator",
            "plugin_path_rules": {
                "reference": "https://code.claude.com/docs/en/plugins-reference#how-each-key-combines-with-its-default-location",
                "commands": "explicit paths replace default",
                "agents": "explicit paths replace default",
                "skills": "explicit paths add to default; root skills absent",
                "legacy_guide_compatibility": "not-validated",
            },
            "claims_not_made": ["npm-registry-published-install", "actual-AI-Host", "formal-AUTH-L3",
                               "SelfEvolution28", "full-suite", "arbitrary-existing-project-upgrade",
                               "Claude-plugin-install"],
        }
        # Only public source hashes and synthetic-fixture results reach CI logs.
        # The tar, installation, HOME, cache, and audit remain in TemporaryDirectory.
        print("OFFLINE_PACKAGE_EVIDENCE_BEGIN")
        print(json.dumps(evidence, indent=2))
        print("OFFLINE_PACKAGE_EVIDENCE_END")
if __name__ == "__main__":
    main()
