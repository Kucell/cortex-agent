#!/usr/bin/env python3
"""Pinned official 1.15.4 or 1.15.6 tar -> exact candidate tar, then synthetic project apply.

Two fixed registry GETs precede offline installs. No old CLI/init, Host, publish,
full suite, or arbitrary user project. Reuses reviewed helpers by exact Git blob.
All package and fixture writes are under one new disposable temporary root.
"""
import argparse
from contextlib import contextmanager
import base64
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import stat
import tempfile

BASELINE_VERSION = "1.15.4"
BASELINE_HEAD = "ea360b6697ecac9a37090e7b40df14b8a3585d8f"
BASELINE_TREE = "c7660c720e501d2c5435c93b372b8714e468ab89"
BASELINE_SRI = "sha512-Yz2TSshSzXRUbInmBzb3Hpav0GfVa8ivUAgIV9MI2f8FzIrTcyqVo9OInxj3G3lb9+PwHv6HE9RfDujCxQbbPg=="
BASELINE_SHA256 = "5d63b33f2e8a0415070f04d571d43e24b5ae64d4eb9485643cbc5f7b24ea8285"
BASELINE_BYTES = 1943765
GETTER_BLOB = "d6dfc3d5a15f8a8499f4aae44f174f0698635fb0"
PACK_HELPER_BLOB = "ff3f2667886577e9c3ea06c3303a926a3d73625c"
BOUNDARY_BLOB = "277c936eca2a399a000bd45eb05460b3e5a7174a"
CORE_PINS = {
    "bin/cli.js": "d1ffec235d4f1702166569b38960c026703c2c18",
    "lib/commands/upgrade.js": "8cf1eedc5ff765f9ed07546892172b161f566afd",
    "lib/commands/update/verify.js": "f0423aeb0a1619036cf9c64e8b41e13a7900db71",
    "lib/commands/update/report.js": "396e5fc62b875da21b7eaf28f53fd26c3ccbd6a5",
    "lib/commands/update/runtime-layout-migration.js": "8566bc4d4028262853b99237a89586088f410f6d",
    "lib/setup/index.js": "36dd66e77410728b5b149b5bbc4e8eaa0c6f899c",
    "lib/commands/patches.js": "9ff6e4514a552732d1f8f255e3839dffe0997827",
    "lib/script/manifest.js": "4f885384085e47bee7bcd5258a7028d9634a9f27",
    "lib/platform/index.js": "e89a99db8d980c08bacbe74fc4750fdb2deb80bf",
    "lib/management/client.js": "ee1daa7fff8a3a1171d82237864e7e2f9d87ef3f"
}
HELPER_PINS = {
    "old": {
        "templates/_shared/.agent/skills/runtime-continuity/scripts/index.js": "39c4ae9cb03e5621db578f7e510a4c091e10f351",
        "templates/_shared/.agent/skills/management-api/scripts/index.js": "f548fdc6c5481250511a58af1ace91a2679f2602",
        "templates/_shared/.agent/skills/management-api/scripts/normalize-token-usage.js": "c8fde0357763f7b852e81e7ad50802c24e6e7d5f",
        "templates/_shared/.agent/skills/management-api/scripts/query-activity.js": "7f9973a3cf1886d075642803f00918bffce41150",
        "templates/_shared/.agent/skills/management-api/scripts/query-dispatch-state.js": "6bd07fc83011e397be70a6c3026966dbb9297b2e",
        "templates/_shared/.agent/skills/management-api/scripts/query-coordination.js": "2409714b2ce56d89d8bb62530a7178afb6add9b4",
        "templates/_shared/.agent/skills/management-api/scripts/query-governed-attempt.js": "fc0c1701c459abe08c40afe0af4a865fbf885343",
        "templates/en/.agent/skills/runtime-continuity/scripts/index.js": "27af3873ae2a3a77e7555c56d031ac58ed805863",
        "templates/en/.agent/skills/management-api/scripts/index.js": "75891f0299048b016f941c7e5b237877a99d7ea3",
        "templates/en/.agent/skills/management-api/scripts/normalize-token-usage.js": "c8fde0357763f7b852e81e7ad50802c24e6e7d5f",
        "templates/en/.agent/skills/management-api/scripts/query-activity.js": "7f9973a3cf1886d075642803f00918bffce41150",
        "templates/en/.agent/skills/management-api/scripts/query-dispatch-state.js": "6bd07fc83011e397be70a6c3026966dbb9297b2e",
        "templates/en/.agent/skills/management-api/scripts/query-coordination.js": "2409714b2ce56d89d8bb62530a7178afb6add9b4",
        "templates/en/.agent/skills/management-api/scripts/query-governed-attempt.js": "fc0c1701c459abe08c40afe0af4a865fbf885343",
        "templates/zh/.agent/skills/runtime-continuity/scripts/index.js": "27af3873ae2a3a77e7555c56d031ac58ed805863",
        "templates/zh/.agent/skills/management-api/scripts/index.js": "75891f0299048b016f941c7e5b237877a99d7ea3",
        "templates/zh/.agent/skills/management-api/scripts/normalize-token-usage.js": "c8fde0357763f7b852e81e7ad50802c24e6e7d5f",
        "templates/zh/.agent/skills/management-api/scripts/query-activity.js": "7f9973a3cf1886d075642803f00918bffce41150",
        "templates/zh/.agent/skills/management-api/scripts/query-dispatch-state.js": "6bd07fc83011e397be70a6c3026966dbb9297b2e",
        "templates/zh/.agent/skills/management-api/scripts/query-coordination.js": "2409714b2ce56d89d8bb62530a7178afb6add9b4",
        "templates/zh/.agent/skills/management-api/scripts/query-governed-attempt.js": "fc0c1701c459abe08c40afe0af4a865fbf885343",
        "templates/_shared/.agent/tasks/scripts/task-state.js": "88f6236a415d12f95ebad70441deb592d4d040b3"
    },
    "candidate": {
        "templates/_shared/.agent/skills/runtime-continuity/scripts/index.js": "27dc7d6dc4398add6a98fba05ef63bde0b6a7abe",
        "templates/_shared/.agent/skills/management-api/scripts/index.js": "919634dd5cf5baaa6fb7fd1ef619d11cc8ee881c",
        "templates/_shared/.agent/skills/management-api/scripts/normalize-token-usage.js": "c8fde0357763f7b852e81e7ad50802c24e6e7d5f",
        "templates/_shared/.agent/skills/management-api/scripts/query-activity.js": "7f9973a3cf1886d075642803f00918bffce41150",
        "templates/_shared/.agent/skills/management-api/scripts/query-dispatch-state.js": "6bd07fc83011e397be70a6c3026966dbb9297b2e",
        "templates/_shared/.agent/skills/management-api/scripts/query-coordination.js": "2409714b2ce56d89d8bb62530a7178afb6add9b4",
        "templates/_shared/.agent/skills/management-api/scripts/query-governed-attempt.js": "fc0c1701c459abe08c40afe0af4a865fbf885343",
        "templates/en/.agent/skills/runtime-continuity/scripts/index.js": "27dc7d6dc4398add6a98fba05ef63bde0b6a7abe",
        "templates/en/.agent/skills/management-api/scripts/index.js": "919634dd5cf5baaa6fb7fd1ef619d11cc8ee881c",
        "templates/en/.agent/skills/management-api/scripts/normalize-token-usage.js": "c8fde0357763f7b852e81e7ad50802c24e6e7d5f",
        "templates/en/.agent/skills/management-api/scripts/query-activity.js": "7f9973a3cf1886d075642803f00918bffce41150",
        "templates/en/.agent/skills/management-api/scripts/query-dispatch-state.js": "6bd07fc83011e397be70a6c3026966dbb9297b2e",
        "templates/en/.agent/skills/management-api/scripts/query-coordination.js": "2409714b2ce56d89d8bb62530a7178afb6add9b4",
        "templates/en/.agent/skills/management-api/scripts/query-governed-attempt.js": "fc0c1701c459abe08c40afe0af4a865fbf885343",
        "templates/zh/.agent/skills/runtime-continuity/scripts/index.js": "27dc7d6dc4398add6a98fba05ef63bde0b6a7abe",
        "templates/zh/.agent/skills/management-api/scripts/index.js": "919634dd5cf5baaa6fb7fd1ef619d11cc8ee881c",
        "templates/zh/.agent/skills/management-api/scripts/normalize-token-usage.js": "c8fde0357763f7b852e81e7ad50802c24e6e7d5f",
        "templates/zh/.agent/skills/management-api/scripts/query-activity.js": "7f9973a3cf1886d075642803f00918bffce41150",
        "templates/zh/.agent/skills/management-api/scripts/query-dispatch-state.js": "6bd07fc83011e397be70a6c3026966dbb9297b2e",
        "templates/zh/.agent/skills/management-api/scripts/query-coordination.js": "2409714b2ce56d89d8bb62530a7178afb6add9b4",
        "templates/zh/.agent/skills/management-api/scripts/query-governed-attempt.js": "fc0c1701c459abe08c40afe0af4a865fbf885343",
        "templates/_shared/.agent/tasks/scripts/task-state.js": "4fc94e64559e31ad4ba898abcff04bd96ec9dd77"
    }
}
# Historical 1.15.4 remains independently pinned; the maintenance release is
# an additional scenario, never a replacement or a version-only substitution.
BASELINES = {
    "1.15.4": {"version": BASELINE_VERSION, "head": BASELINE_HEAD, "tree": BASELINE_TREE,
               "sri": BASELINE_SRI, "sha256": BASELINE_SHA256, "bytes": BASELINE_BYTES,
               "members": 1224, "helper_pins": HELPER_PINS["old"]},
    "1.15.6": {
    "version": "1.15.6",
    "head": "fc594201576f5239801d41b86a8f7e107ea8e7c0",
    "tree": "dc842415070ebf4ebb96c3a59a728627e73793ad",
    "sri": "sha512-LNzzPvzyNMGqUlETIowXWUhZTL+auULI45Y71GG6wuAOlFSOj69nVDluMlksko/MNtgckDTiD82+b2QRL7YkVg==",
    "sha256": "80e0cce514ad9a1cc7806d57091489b13652578c560627b2a3875a95827d68e6",
    "bytes": 2165950,
    "members": 1301,
    "helper_pins": {
        "templates/_shared/.agent/skills/runtime-continuity/scripts/index.js": "47e50fa9262b8a29db46ea145329135229268a56",
        "templates/_shared/.agent/skills/management-api/scripts/index.js": "1f3f01d05f3882c4d1fe4a75cb858badbad1807d",
        "templates/_shared/.agent/skills/management-api/scripts/normalize-token-usage.js": "c8fde0357763f7b852e81e7ad50802c24e6e7d5f",
        "templates/_shared/.agent/skills/management-api/scripts/query-activity.js": "7f9973a3cf1886d075642803f00918bffce41150",
        "templates/_shared/.agent/skills/management-api/scripts/query-dispatch-state.js": "6bd07fc83011e397be70a6c3026966dbb9297b2e",
        "templates/_shared/.agent/skills/management-api/scripts/query-coordination.js": "2409714b2ce56d89d8bb62530a7178afb6add9b4",
        "templates/_shared/.agent/skills/management-api/scripts/query-governed-attempt.js": "fc0c1701c459abe08c40afe0af4a865fbf885343",
        "templates/en/.agent/skills/runtime-continuity/scripts/index.js": "47e50fa9262b8a29db46ea145329135229268a56",
        "templates/en/.agent/skills/management-api/scripts/index.js": "1f3f01d05f3882c4d1fe4a75cb858badbad1807d",
        "templates/en/.agent/skills/management-api/scripts/normalize-token-usage.js": "c8fde0357763f7b852e81e7ad50802c24e6e7d5f",
        "templates/en/.agent/skills/management-api/scripts/query-activity.js": "7f9973a3cf1886d075642803f00918bffce41150",
        "templates/en/.agent/skills/management-api/scripts/query-dispatch-state.js": "6bd07fc83011e397be70a6c3026966dbb9297b2e",
        "templates/en/.agent/skills/management-api/scripts/query-coordination.js": "2409714b2ce56d89d8bb62530a7178afb6add9b4",
        "templates/en/.agent/skills/management-api/scripts/query-governed-attempt.js": "fc0c1701c459abe08c40afe0af4a865fbf885343",
        "templates/zh/.agent/skills/runtime-continuity/scripts/index.js": "47e50fa9262b8a29db46ea145329135229268a56",
        "templates/zh/.agent/skills/management-api/scripts/index.js": "1f3f01d05f3882c4d1fe4a75cb858badbad1807d",
        "templates/zh/.agent/skills/management-api/scripts/normalize-token-usage.js": "c8fde0357763f7b852e81e7ad50802c24e6e7d5f",
        "templates/zh/.agent/skills/management-api/scripts/query-activity.js": "7f9973a3cf1886d075642803f00918bffce41150",
        "templates/zh/.agent/skills/management-api/scripts/query-dispatch-state.js": "6bd07fc83011e397be70a6c3026966dbb9297b2e",
        "templates/zh/.agent/skills/management-api/scripts/query-coordination.js": "2409714b2ce56d89d8bb62530a7178afb6add9b4",
        "templates/zh/.agent/skills/management-api/scripts/query-governed-attempt.js": "fc0c1701c459abe08c40afe0af4a865fbf885343",
        "templates/_shared/.agent/tasks/scripts/task-state.js": "4fc94e64559e31ad4ba898abcff04bd96ec9dd77"
    }
}
}

def baseline_profile(version):
    require(version in BASELINES, "unreviewed baseline version")
    return BASELINES[version]

EXECUTABLE_TEMPLATE_PATHS = [
    "templates/" + language + "/.agent/skills/" + skill + "/scripts/" + filename
    for language in ("_shared", "en", "zh")
    for skill, filename in (("evolution-pipeline", "evolve.js"), ("management-api", "index.js"))
]
DEPENDENCY_KEYS = ("dependencies", "devDependencies", "optionalDependencies",
                   "peerDependencies", "bundledDependencies", "bundleDependencies", "workspaces")
LEGACY = [
    (".agent-runtime/coordination/tasks.json", ".agent/runtime/coordination/tasks.json",
     b'{"tasks":[{"id":"synthetic-old-1","state":"in_progress","legacy_extension":{"note":"keep"}}]}\n'),
    (".agent-runtime/dispatch/journal.jsonl", ".agent/runtime/dispatch/journal.jsonl",
     b'{"event":"synthetic-checkpoint","seq":4}\n'),
    (".agent-runtime/cross-project/inbox.json", ".agent/runtime/cross-project/inbox.json",
     b'{"messages":[{"id":"synthetic-old-2"}]}\n'),
    (".agent-runtime/runtime-continuity/state.json", ".agent/runtime/continuity/state.json",
     b'{"cursor":19,"legacy_extension":"keep"}\n'),
    (".agent-runtime/runtime-evidence/nested/archive.bin", ".agent/runtime/evidence/nested/archive.bin",
     bytes([0, 255, 128, 13, 10, 42])),
]
VERIFY_NAMES = {
    "parse .agent/hooks/hooks.json", "parse .claude/settings.json",
    "parse .agent/skills/management-api/scripts/projection-registry.json",
    "layout marker valid", "legacy runtime readable", "no half-activated marker",
    "runtime directory structure", "runtime resume-bundle",
    "query capabilities", "query dashboard-state", "query activity",
}

def require(value, message):
    if not value:
        raise AssertionError(message)

def sha(data, algorithm="sha256"):
    return hashlib.new(algorithm, data).hexdigest()

def blob(data):
    return sha(b"blob " + str(len(data)).encode("ascii") + b"\0" + data, "sha1")

def regular(path):
    return stat.S_ISREG(path.lstat().st_mode) and not path.is_symlink()

def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))

def load_reviewed(path, expected):
    require(regular(path) and blob(path.read_bytes()) == expected, "reviewed helper bytes changed: " + str(path))
    spec = importlib.util.spec_from_file_location(path.stem.replace("-", "_"), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def check_package(package, version, identity):
    require(package.get("name") == "cortex-agent" and package.get("version") == version,
            "package identity mismatch")
    require(all(not package.get(key) for key in DEPENDENCY_KEYS), "dependency closure needs review")
    require(not identity.LIFECYCLE.intersection(package.get("scripts", {})), "lifecycle surface needs review")
    require(package.get("bin") == {"cortex-agent": "bin/cli.js", "cortex-claude-hook": "bin/cortex-claude-hook"},
            "package bin contract changed")

def validate_installed(root, manifest):
    require(root.is_dir() and not root.is_symlink(), "installed package is missing")
    found = set()
    for path in root.rglob("*"):
        require(not path.is_symlink(), "installed member link")
        if path.is_file():
            rel = path.relative_to(root).as_posix()
            require(rel in manifest and regular(path), "unexpected installed file")
            require(sha(path.read_bytes()) == manifest[rel]["sha256"], "installed bytes mismatch: " + rel)
            require(bool(path.stat().st_mode & 0o111) == bool(manifest[rel]["mode"] & 0o111),
                    "installed executable mode mismatch")
            found.add(rel)
        else:
            require(path.is_dir(), "installed special member")
    require(found == set(manifest), "installed member set differs")
    require({p.name for p in root.parent.iterdir()} <= {"cortex-agent", ".bin", ".package-lock.json"},
            "unexpected installed dependency")
    for name, relative in {"cortex-agent": "bin/cli.js", "cortex-claude-hook": "bin/cortex-claude-hook"}.items():
        entry = root.parent / ".bin" / name
        require(entry.is_symlink() and entry.resolve() == root / relative, "installed bin mismatch")

def check_helper_pins(manifest, phase, pins=None):
    for relative, expected in (HELPER_PINS[phase] if pins is None else pins).items():
        require(relative in manifest and manifest[relative]["git_blob_sha1"] == expected,
                "helper dependency source changed: " + phase + ":" + relative)

def safe_patch_targets(installed, language, project):
    # Match the product parser and fail closed on ambiguous metadata.
    rows = []
    directory = installed / "templates" / language / ".agent/patches"
    require(directory.is_dir() and not directory.is_symlink(), "patch directory missing")
    for path in sorted(directory.glob("*.patch.md")):
        require(regular(path), "nonregular patch")
        match = re.fullmatch(r"---\n([\s\S]*?)\n---\n([\s\S]*)", path.read_text(encoding="utf-8"))
        require(match is not None, "patch frontmatter requires review")
        fields = {}
        for line in match[1].split("\n"):
            key, sep, value = line.partition(":")
            if sep:
                require(key.strip() not in fields, "duplicate patch field")
                fields[key.strip()] = value.strip().removeprefix('"').removesuffix('"')
        require(all(fields.get(key) for key in ("id", "target", "anchor")), "incomplete patch metadata")
        target = fields["target"]
        require("\\" not in target and not PurePosixPath(target).is_absolute(), "absolute patch target")
        resolved = (project / ".agent" / target).resolve()
        require(resolved.is_relative_to(project) and resolved != project, "patch target escapes fixture")
        rows.append({"patch": path.relative_to(installed).as_posix(),
                     "target": resolved.relative_to(project).as_posix()})
    return rows

def assert_report(report, command, modified):
    require(report["command"] == command and report["mode"] == "apply", "wrong apply report")
    require(report["status"] == ("partial" if modified else "passed"), "unexpected apply status")
    checks = report["verification"]
    require(len(checks) == len(VERIFY_NAMES) and {x["name"] for x in checks} == VERIFY_NAMES,
            "verification closure incomplete or changed")
    require(all(x["status"] == "passed" and x["exit_code"] == 0 for x in checks),
            "verification failed or skipped")
    require(report["summary"]["failed"] == report["summary"]["verification_failed"] ==
            report["summary"]["verification_skipped"] == 0, "apply summary failure")
    require(not report["changes"]["failed"], "script apply failure")

@contextmanager
def acceptance_scratch():
    root = Path(tempfile.mkdtemp(prefix="cortex-registry-upgrade-", dir="/tmp"))
    completion = {"passed": False}
    try:
        yield root, completion
    finally:
        if completion["passed"]:
            shutil.rmtree(root)
        else:
            # Never erase failure material while process cleanup may be unknown.
            # Only this disposable runner retains it; no artifact is uploaded.
            print("REGISTRY_UPGRADE_FAILED_TEMP_RETAINED=" + str(root), flush=True)

def main():
    require(os.name == "posix", "disposable POSIX executor required")
    require(set(os.environ) <= {"PATH", "LANG", "LC_ALL", "LC_CTYPE"}, "launcher must clear environment")
    require(os.environ.get("PATH") == "/usr/bin:/bin", "fixed launcher PATH")
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline-version", choices=sorted(BASELINES), default="1.15.4")
    parser.add_argument("--expected-head", required=True)
    parser.add_argument("--expected-version", required=True)
    parser.add_argument("--expected-gitlink", required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--npm-cli", required=True)
    args = parser.parse_args()
    baseline = baseline_profile(args.baseline_version)
    BASELINE_VERSION, BASELINE_HEAD, BASELINE_TREE = baseline["version"], baseline["head"], baseline["tree"]
    BASELINE_SRI, BASELINE_SHA256, BASELINE_BYTES = baseline["sri"], baseline["sha256"], baseline["bytes"]
    metadata_path = "/cortex-agent/" + BASELINE_VERSION
    tar_path = "/cortex-agent/-/cortex-agent-" + BASELINE_VERSION + ".tgz"
    tar_url = "https://registry.npmjs.org" + tar_path
    require(re.fullmatch(r"[a-f0-9]{40}", args.expected_head), "exact source head required")
    require(re.fullmatch(r"[a-f0-9]{40}", args.expected_gitlink), "exact gitlink required")
    require(re.fullmatch(r"\d+\.\d+\.\d+", args.expected_version), "stable candidate version required")
    node, npm = Path(args.node).resolve(strict=True), Path(args.npm_cli).resolve(strict=True)
    require(node.is_absolute() and regular(node) and os.access(node, os.X_OK), "Node binary required")
    require(npm.is_absolute() and regular(npm) and npm.name == "npm-cli.js", "installed npm CLI required")
    source = Path(__file__).resolve().parents[2]
    binding = source / ".agent"
    require(not binding.is_symlink() and
            (not binding.exists() or (binding.is_dir() and not any(binding.iterdir()))),
            "private gitlink must remain absent or empty")
    identity = load_reviewed(source / "scripts/release/registry-baseline-identity.py", GETTER_BLOB)
    helper = load_reviewed(source / "scripts/release/offline-package-acceptance.py", PACK_HELPER_BLOB)
    guard_source = source / "scripts/release/offline-package-boundary.cjs"
    require(regular(guard_source) and blob(guard_source.read_bytes()) == BOUNDARY_BLOB,
            "reviewed boundary changed")
    evidence = {}
    with acceptance_scratch() as (scratch, completion):
        for name in ("home", "tmp", "cache", "node-only", "pack", "consumer", "control", "fixtures"):
            (scratch / name).mkdir()
        (scratch / "node-only/node").symlink_to(node)
        for name in ("user.npmrc", "global.npmrc"):
            (scratch / name).write_text("", encoding="utf-8")
        env = {
            "PATH": str(scratch / "node-only"), "HOME": str(scratch / "home"),
            "USERPROFILE": str(scratch / "home"), "LANG": "C", "LC_ALL": "C", "TZ": "UTC", "CI": "true",
            "TMPDIR": str(scratch / "tmp"), "TMP": str(scratch / "tmp"), "TEMP": str(scratch / "tmp"),
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
            "NPM_CONFIG_USERCONFIG": str(scratch / "user.npmrc"),
            "NPM_CONFIG_GLOBALCONFIG": str(scratch / "global.npmrc"),
            "NPM_CONFIG_CACHE": str(scratch / "cache"),
            "NPM_CONFIG_UPDATE_NOTIFIER": "false", "NPM_CONFIG_AUDIT": "false", "NPM_CONFIG_FUND": "false",
        }
        def git(*argv):
            return helper.run(["/usr/bin/git", "--no-lazy-fetch", "--no-replace-objects",
                               "-c", "core.fsmonitor=false", *argv], source, env, timeout=30)
        require(git("rev-parse", "HEAD").strip() == args.expected_head, "source head drift")
        require(not git("status", "--porcelain", "--untracked-files=all").strip(), "source is not clean")
        tree = {}
        for record in git("ls-tree", "-rz", "--full-tree", args.expected_head).split("\0"):
            if record:
                metadata, relative = record.split("\t", 1)
                mode, kind, oid = metadata.split()
                require(relative == PurePosixPath(relative).as_posix() and
                        ".." not in PurePosixPath(relative).parts, "unsafe source path")
                tree[relative] = {"mode": mode, "type": kind, "blob": oid}
        require(tree.get(".agent") == {"mode": "160000", "type": "commit", "blob": args.expected_gitlink},
                "governance pin drift")
        for relative, row in tree.items():
            path = source / relative
            if row["mode"] in ("100644", "100755"):
                require(regular(path) and blob(path.read_bytes()) == row["blob"], "source blob mismatch: " + relative)
            elif row["mode"] == "120000":
                require(path.is_symlink() and blob(os.readlink(path).encode()) == row["blob"],
                        "source link mismatch")
            else:
                require(relative == ".agent" and row["mode"] == "160000", "unexpected source special member")
        for relative in EXECUTABLE_TEMPLATE_PATHS:
            require(tree[relative]["mode"] == "100755", "template executable Git mode regression: " + relative)
        for relative, expected in CORE_PINS.items():
            require(tree[relative]["blob"] == expected, "reviewed upgrade core changed: " + relative)
        require(not any(PurePosixPath(p).name == ".npmrc" for p in tree), "source npm config needs review")
        pkg = read_json(source / "package.json")
        check_package(pkg, args.expected_version, identity)
        require(int(helper.run([node, "--version"], scratch, env).strip().lstrip("v").split(".")[0]) >= 18,
                "Node 18 or newer is required")
        lock = read_json(source / "package-lock.json")
        plugin = read_json(source / ".claude-plugin/plugin.json")
        market = read_json(source / ".claude-plugin/marketplace.json")
        market_entries = [p for p in market["plugins"] if p["name"] == "cortex-agent"]
        require(len(market_entries) == 1 and set(lock["packages"]) == {""}, "package metadata ambiguity")
        require(all(v == args.expected_version for v in [lock["version"], lock["packages"][""]["version"],
                plugin["version"], market["metadata"]["version"], market_entries[0]["version"]]),
                "candidate versions differ")
        require("## [" + args.expected_version + "]" in (source / "CHANGELOG.md").read_text(),
                "candidate changelog heading missing")
        source_state = helper.snapshot(source)
        # The only deliberate network phase: fixed official metadata and tar.
        signal.signal(signal.SIGALRM, identity.deadline)
        signal.alarm(90)
        try:
            metadata_bytes = identity.get_fixed(metadata_path, identity.MAX_METADATA, {"application/json"}, version=BASELINE_VERSION)
            metadata = identity.parse_json(metadata_bytes)
            require(metadata.get("name") == "cortex-agent" and metadata.get("version") == BASELINE_VERSION and
                    metadata.get("gitHead") == BASELINE_HEAD, "published baseline metadata drift")
            dist = metadata["dist"]
            require(dist["tarball"] == tar_url, "baseline URL drift")
            digests = identity.parse_integrity(dist["integrity"])
            require("sha512-" + base64.b64encode(digests["sha512"]).decode("ascii") == BASELINE_SRI,
                    "pinned baseline SRI drift")
            old_raw = identity.get_fixed(tar_path, identity.MAX_TAR,
                       {"application/octet-stream", "application/gzip", "application/x-gzip"}, version=BASELINE_VERSION)
            require(len(old_raw) == BASELINE_BYTES and sha(old_raw) == BASELINE_SHA256, "baseline bytes drift")
            for algorithm, expected in digests.items():
                require(hashlib.new(algorithm, old_raw).digest() == expected, "baseline integrity mismatch")
            if dist.get("shasum") is not None:
                require(sha(old_raw, "sha1") == dist["shasum"], "baseline SHA1 mismatch")
            old_manifest, old_pkg = identity.inspect_tar(old_raw)
        finally:
            signal.alarm(0)
        check_package(old_pkg, BASELINE_VERSION, identity)
        require(len(old_manifest) == baseline["members"], "baseline member count drift")
        check_helper_pins(old_manifest, "old", baseline["helper_pins"])
        excluded_global = sorted(p for p in old_manifest if
                                 p.startswith("templates/_shared/.agent/global-shared-skills/"))
        require(len(excluded_global) == 5, "published init exclusion set changed")
        baseline_tar = scratch / ("cortex-agent-" + BASELINE_VERSION + ".tgz")
        baseline_tar.write_bytes(old_raw)
        consumer = scratch / "consumer"
        (consumer / "package.json").write_text('{"name":"registry-upgrade-fixture","private":true}\n')
        install_args = ["--ignore-scripts", "--offline", "--no-audit", "--no-fund",
                        "--no-package-lock", "--workspaces=false"]
        helper.run([node, npm, "install", baseline_tar, *install_args], consumer, env)
        installed = consumer / "node_modules/cortex-agent"
        validate_installed(installed, old_manifest)
        fixtures = []
        target_rel = "skills/evolution-pipeline/scripts/evolve.js"
        for language in ("en", "zh"):
            for modified in (False, True):
                root = scratch / "fixtures" / (language + ("-custom" if modified else "-managed"))
                project, home, temp = root / "project", root / "home", root / "tmp"
                for directory in (project, home, temp):
                    directory.mkdir(parents=True)
                agent = project / ".agent"
                origins = {}
                # Product copyRecursive/additive apply copies shared first and
                # does not overwrite existing files; preserve that actual order.
                for layer in ("_shared", language):
                    prefix = "templates/" + layer + "/.agent/"
                    for relative in sorted(old_manifest):
                        if not relative.startswith(prefix):
                            continue
                        name = relative[len(prefix):]
                        require(name, "empty template member")
                        # Match the old published initSharedExclude exactly.
                        # These five optional global templates stay in the tar
                        # and installed package; no HOME namespace is created.
                        if layer == "_shared" and name.startswith("global-shared-skills/"):
                            continue
                        dest = agent / name
                        if not dest.exists():
                            dest.parent.mkdir(parents=True, exist_ok=True)
                            data = (installed / relative).read_bytes()
                            dest.write_bytes(data)
                            dest.chmod(old_manifest[relative]["mode"] & 0o777)
                            origins[name] = {"source": relative, "sha256": sha(data),
                                             "blob": old_manifest[relative]["git_blob_sha1"]}
                require(not (agent / "skills/self-check/scripts/index.js").exists(), "unexpected old self-check")
                ledger = {name: {"origin_hash": row["sha256"], "sha256": row["sha256"],
                                 "ownership_proof": "template_match"}
                          for name, row in origins.items() if name.endswith(".js")}
                (agent / ".script-manifest.json").write_text(json.dumps({"schema_version": 1, "scripts": ledger}))
                (agent / ".cortex-version").write_text(BASELINE_VERSION + "\n")
                (agent / ".platforms").write_text("[]\n")
                target = agent / target_rel
                require(regular(target), "old evolve template missing")
                if modified:
                    target.write_bytes(target.read_bytes() + b"\n// SYNTHETIC_CUSTOMIZATION_MUST_SURVIVE\n")
                sentinel = agent / "customer-owned.fixture"
                sentinel.write_bytes(b"synthetic user rule: preserve exact bytes\n")
                sentinel.chmod(0o640)
                for old, new, data in LEGACY:
                    path = project / old
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(data)
                    path.chmod(0o640)
                fixtures.append({"language": language, "modified": modified, "root": root,
                                 "project": project, "home": home, "origins": origins,
                                 "target_before": target.read_bytes(), "target_mode": stat.S_IMODE(target.stat().st_mode),
                                 "legacy_before": helper.snapshot(project / ".agent-runtime"),
                                 "sentinel_before": helper.snapshot(sentinel)})
        before_replacement = helper.snapshot(scratch / "fixtures")
        pack_rows = json.loads(helper.run([node, npm, "pack", "--ignore-scripts", "--offline", "--json",
                                 "--pack-destination", scratch / "pack"], source, env))
        require(len(pack_rows) == 1, "expected exactly one candidate tar")
        filename = pack_rows[0]["filename"]
        require(filename == Path(filename).name and filename.endswith(".tgz"), "unsafe candidate filename")
        candidate_tar = scratch / "pack" / filename
        candidate_raw = candidate_tar.read_bytes()
        candidate_manifest, candidate_pkg = identity.inspect_tar(candidate_raw)
        check_package(candidate_pkg, args.expected_version, identity)
        candidate_sri = "sha512-" + base64.b64encode(hashlib.sha512(candidate_raw).digest()).decode("ascii")
        require(candidate_sri == pack_rows[0]["integrity"], "candidate npm integrity mismatch")
        require(set(candidate_manifest) == {r["path"] for r in pack_rows[0]["files"]}, "npm member list mismatch")
        for relative, row in candidate_manifest.items():
            require(relative in tree and tree[relative]["mode"] in ("100644", "100755") and
                    row["git_blob_sha1"] == tree[relative]["blob"] and
                    row["mode"] == (0o755 if tree[relative]["mode"] == "100755" else 0o644),
                    "candidate tar provenance mismatch")
        check_helper_pins(candidate_manifest, "candidate")
        for relative in EXECUTABLE_TEMPLATE_PATHS:
            require(candidate_manifest[relative]["mode"] == 0o755,
                    "template executable tar mode regression: " + relative)
        for language in ("_shared", "en", "zh"):
            require("templates/" + language + "/.agent/skills/self-check/scripts/index.js" not in candidate_manifest,
                    "candidate self-check requires separate execution review")
        require(not any(p == "skills" or p.startswith("skills/") for p in tree), "default skills alias returned")
        require(helper.plugin_components(plugin, candidate_manifest) ==
                helper.plugin_components(plugin, [p for p, row in tree.items() if row["mode"] in ("100644", "100755")]),
                "candidate plugin source/tar mismatch")
        helper.run([node, npm, "install", candidate_tar, *install_args], consumer, env)
        validate_installed(installed, candidate_manifest)
        require(helper.snapshot(scratch / "fixtures") == before_replacement, "npm replacement changed fixtures")
        cli = installed / "bin/cli.js"
        control = scratch / "control"
        guard = control / "boundary.cjs"
        guard.write_bytes(guard_source.read_bytes())
        config = control / "boundary.json"
        audit = control / "audit.jsonl"
        audit.write_text("")
        commands = []
        def invoke(fixture, argv, expected=0, helper_calls=None):
            project, home = fixture["project"], fixture["home"]
            child_env = {
                "PATH": str(scratch / "node-only"), "HOME": str(home), "USERPROFILE": str(home),
                "XDG_CONFIG_HOME": str(home), "LANG": "C", "LC_ALL": "C", "TZ": "UTC",
                "CI": "true", "CORTEX_STATE_SYNC": "off", "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_CONFIG_GLOBAL": "/dev/null",
                "TMPDIR": str(fixture["root"] / "tmp"), "TMP": str(fixture["root"] / "tmp"),
                "TEMP": str(fixture["root"] / "tmp"), "NODE_OPTIONS": "--require=" + str(guard),
                "CORTEX_PACK_BOUNDARY_CONFIG": str(config),
            }
            policy = {"node": str(node), "audit": str(audit), "nodeCalls": helper_calls or [],
                      "cwd": str(project.resolve()), "env": child_env,
                      "gitArgs": [["rev-parse", "--show-toplevel"], ["rev-parse", "--abbrev-ref", "HEAD"],
                                  ["rev-parse", "--short", "HEAD"], ["status", "--short"],
                                  ["log", "--oneline", "-3"], ["diff", "--name-only", "HEAD"]],
                      "shellCommands": ["git worktree list --porcelain", "git status --short --branch"]}
            config.write_text(json.dumps(policy))
            audit_before = len(audit.read_text().splitlines())
            output = helper.run([node, cli, *argv], project, child_env, expected=expected, timeout=90)
            events = [json.loads(line) for line in audit.read_text().splitlines()]
            require(all(row["allowed"] for row in events), "caught subprocess/network denial")
            observed = events[audit_before:]
            node_events = [row for row in observed if row.get("command") == str(node)]
            required_calls = helper_calls or []
            require(len(node_events) == (4 if required_calls else 0), "unexpected helper process count")
            for event in node_events:
                require(any(event["args"] == [rule["file"], *rule["args"]] for rule in required_calls),
                        "unexpected helper invocation")
            if required_calls:
                require(len({json.dumps(row["args"]) for row in node_events}) == 4,
                        "duplicate helper substituted for required verification")
            git_attempts = [row for row in observed if row.get("command") == "git" or
                            str(row.get("command", "")).startswith("git ")]
            commands.append({"fixture": fixture["root"].name, "argv": argv, "exit_code": expected,
                             "helper_processes": len(node_events), "read_only_git_attempts": len(git_attempts),
                             "git_available_in_child_path": False})
            return output
        def assert_project_helpers(fixture, phase):
            agent = fixture["project"] / ".agent"
            language = fixture["language"]
            relative_names = {p.split("/.agent/", 1)[1] for p in baseline["helper_pins"]}
            rows = {}
            for relative in sorted(relative_names):
                if phase == "old":
                    expected = fixture["origins"][relative]["blob"]
                else:
                    local = "templates/" + language + "/.agent/" + relative
                    shared = "templates/_shared/.agent/" + relative
                    selected = local if local in candidate_manifest else shared
                    expected = candidate_manifest[selected]["git_blob_sha1"]
                path = agent / relative
                require(regular(path) and blob(path.read_bytes()) == expected,
                        "project helper dependency bytes changed: " + relative)
                rows[relative] = expected
            return rows
        fixture_results = []
        for fixture in fixtures:
            language, modified = fixture["language"], fixture["modified"]
            root, project, home = fixture["root"], fixture["project"], fixture["home"]
            agent = project / ".agent"
            target = agent / target_rel
            patches = safe_patch_targets(installed, language, project)
            old_helper_sources = assert_project_helpers(fixture, "old")
            before = helper.snapshot(root)
            require(invoke(fixture, ["--version"]).strip() == args.expected_version, "installed candidate version")
            invoke(fixture, ["upgrade", "--lang", language, "--track", "--dry-run"])
            require(helper.snapshot(root) == before, "version/dry-run changed fixture")
            home_before = helper.snapshot(home)
            calls = []
            today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
            # The deadline is < 90 seconds; permit today's exact args only.
            for relative, tails in [
                ("skills/runtime-continuity/scripts/index.js", [["resume-bundle", "--project", "project"]]),
                ("skills/management-api/scripts/index.js", [["query", "capabilities"],
                     ["query", "dashboard-state"], ["query", "activity", "--since", today]]),
            ]:
                expected_hashes = [fixture["origins"][relative]["sha256"]]
                for layer in ("_shared", language):
                    candidate_path = "templates/" + layer + "/.agent/" + relative
                    expected_hashes.append(candidate_manifest[candidate_path]["sha256"])
                for tail in tails:
                    calls.append({"file": str(agent / relative), "args": tail, "sha256": sorted(set(expected_hashes))})
            invoke(fixture, ["upgrade", "--lang", language, "--track"], helper_calls=calls)
            additive = read_json(agent / "updates/latest.json")
            assert_report(additive, "upgrade", modified)
            require(target.read_bytes() == fixture["target_before"], "additive upgrade overwrote existing script")
            additive_mode = stat.S_IMODE(target.stat().st_mode)
            require(additive_mode == fixture["target_mode"], "additive upgrade changed existing script mode")
            require(helper.snapshot(agent / "customer-owned.fixture") == fixture["sentinel_before"] and
                    helper.snapshot(project / ".agent-runtime") == fixture["legacy_before"] and
                    helper.snapshot(home) == home_before, "additive upgrade changed protected state")
            for old, new, data in LEGACY:
                path = project / new
                require(regular(path) and path.read_bytes() == data and stat.S_IMODE(path.stat().st_mode) == 0o640,
                        "additive migration changed historical bytes/mode")
            require(assert_project_helpers(fixture, "old") == old_helper_sources,
                    "additive upgrade changed the published helper closure")
            invoke(fixture, ["update", "--lang", language, "--track"],
                   expected=2 if modified else 0, helper_calls=calls)
            updated = read_json(agent / "updates/latest.json")
            assert_report(updated, "update", modified)
            candidate_helper_sources = assert_project_helpers(fixture, "candidate")
            if modified:
                require(target.read_bytes() == fixture["target_before"] and
                        (agent / ".cortex-version").read_text() == BASELINE_VERSION + "\n",
                        "customized script/version was not preserved")
                require(any(row["path"] == ".agent/" + target_rel and row["reason"] == "user_modified"
                            for row in updated["changes"]["protected"]), "customization not reported")
            else:
                require(target.read_bytes() == (installed / "templates" / language / ".agent" / target_rel).read_bytes(),
                        "managed update did not install candidate script")
                require((agent / ".cortex-version").read_text() == args.expected_version + "\n",
                        "managed version not advanced")
                require(not updated["changes"]["protected"], "unexplained protected managed scripts")
            candidate_mode = candidate_manifest["templates/" + language + "/.agent/" + target_rel]["mode"]
            observed_mode = stat.S_IMODE(target.stat().st_mode)
            require(fixture["target_mode"] == candidate_mode == 0o755, "old/candidate executable modes differ")
            require(stat.S_IMODE(target.stat().st_mode) == fixture["target_mode"], "script mode changed")
            require(helper.snapshot(agent / "customer-owned.fixture") == fixture["sentinel_before"],
                    "user rule bytes/mode/mtime changed")
            require(helper.snapshot(project / ".agent-runtime") == fixture["legacy_before"],
                    "legacy source history changed")
            for old, new, data in LEGACY:
                path = project / new
                require(regular(path) and path.read_bytes() == data and stat.S_IMODE(path.stat().st_mode) == 0o640,
                        "migrated historical bytes/mode changed")
            require(helper.snapshot(home) == home_before, "upgrade changed fresh HOME")
            require(not (project / ".git").exists() and not (agent / ".git").exists(), "unexpected Git state")
            for path in project.rglob("*"):
                require(not path.is_symlink(), "unexpected fixture link")
            stable = helper.snapshot(root)
            invoke(fixture, ["upgrade", "--lang", language, "--track", "--dry-run"])
            require(helper.snapshot(root) == stable, "final dry-run changed fixture")
            fixture_results.append({"fixture": root.name, "language": language, "customized": modified,
                "seed_source": "actual installed pinned registry tar; shared-first additive copy",
                "seed_member_sources": fixture["origins"], "patch_targets": patches,
                "published_init_excluded_global_members": excluded_global,
                "additive_status": additive["status"], "update_status": updated["status"],
                "old_helper_sources": old_helper_sources, "candidate_helper_sources": candidate_helper_sources,
                "script_modes": {"old": oct(fixture["target_mode"]), "candidate": oct(candidate_mode),
                                 "after_additive": oct(additive_mode), "after_update": oct(observed_mode)},
                "additive_verification": additive["verification"],
                "verification": updated["verification"], "legacy_files_preserved_after_each_apply": len(LEGACY),
                "dry_run_unchanged": True, "custom_rule_unchanged": True, "home_unchanged": True})
        require(git("rev-parse", "HEAD").strip() == args.expected_head and
                not git("status", "--porcelain", "--untracked-files=all").strip(), "source head/worktree changed")
        # .git/index may be refreshed by Git status; compare tracked source bytes
        # and all non-.git paths, rather than claiming Git's internal cache is immutable.
        after_source = helper.snapshot(source)
        comparable = lambda rows: {p: r for p, r in rows.items() if p != ".git" and not p.startswith(".git/")}
        require(comparable(after_source) == comparable(source_state), "public source snapshot changed")
        evidence = {
            "schema_version": 1, "status": "passed",
            "scope": "pinned-published-baseline-install-to-source-candidate-and-synthetic-project-upgrade",
            "source_head": args.expected_head, "source_tree": git("rev-parse", "HEAD^{tree}").strip(),
            "governance_gitlink": args.expected_gitlink, "candidate_version": args.expected_version,
            "node": helper.run([node, "--version"], scratch, env).strip(),
            "npm": helper.run([node, npm, "--version"], scratch, env).strip(),
            "git": helper.run(["/usr/bin/git", "--version"], scratch, env).strip(),
            "baseline": {"version": BASELINE_VERSION, "gitHead": BASELINE_HEAD, "source_tree": BASELINE_TREE,
                "tar_bytes": len(old_raw), "sha256": sha(old_raw), "integrity": BASELINE_SRI,
                "source_mapping": str(baseline["members"]) + "/" + str(baseline["members"]) + " pinned tar members mapped to the baseline source tree in identity review",
                "signature_and_provenance_verified": False, "files": old_manifest},
            "candidate_executable_template_modes": {p: oct(candidate_manifest[p]["mode"])
                                                     for p in EXECUTABLE_TEMPLATE_PATHS},
            "candidate": {"tar_bytes": len(candidate_raw), "sha256": sha(candidate_raw),
                "sha512": sha(candidate_raw, "sha512"), "integrity": candidate_sri, "files": candidate_manifest},
            "commands": commands, "fixtures": fixture_results,
            "version_transition": {"baseline": BASELINE_VERSION, "candidate": args.expected_version,
                                   "distinct_versions": BASELINE_VERSION != args.expected_version},
            "helper_processes_observed": sum(row["helper_processes"] for row in commands),
            "read_only_git_attempts": sum(row["read_only_git_attempts"] for row in commands),
            "boundary": {"denied": 0, "audit_entries": len(audit.read_text().splitlines()),
                "scope": "reviewed network/subprocess instrumentation; not an OS filesystem sandbox"},
            "network_requests": ["GET https://" + identity.HOST + metadata_path,
                                 "GET " + tar_url],
            "claims_not_made": ["candidate-published-on-registry", "arbitrary-user-project-upgrade",
                "old-init-execution", "AI-Host", "Claude-install", "formal-AUTH-L3",
                "SelfEvolution28", "full-suite", "hostile-process-sandbox"],
        }
        completion["passed"] = True
    require(not scratch.exists(), "temporary acceptance tree was not removed")
    evidence["temporary_tree_removed"] = True
    print("REGISTRY_UPGRADE_EVIDENCE_BEGIN")
    print(json.dumps(evidence, sort_keys=True, indent=2))
    print("REGISTRY_UPGRADE_EVIDENCE_END")

if __name__ == "__main__":
    main()
