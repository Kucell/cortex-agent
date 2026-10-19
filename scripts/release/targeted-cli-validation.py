#!/usr/bin/env python3
"""Run only the reviewed nine release CLI regressions in a disposable snapshot.

Requires a disposable public checkout plus preinstalled Git, Node and Python.
No dependency install, registry request, Host launch, or release write occurs.
Environment/path isolation covers the reviewed cooperative code, not hostile
code or an OS sandbox. Do not run this from a checkout with governance data.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import stat
import subprocess
import tempfile

TEST_BLOBS = {
    "tests/commands/reconcile.test.js": "0184417e8d17fbe233203bf5fd6232324db7afb3",
    "tests/cli/reconcile-entrypoint.test.js": "517259058790010d69220315df524d76697c20a5",
    "tests/cli/cli-contract.test.js": "fe8d027fdfe6fef1b7b12f7d154305e8a201c7a3",
}
GITLINK = "7b17677b1646cdbf54e29bf44cb9a11100c90d34"
EXPECTED_TESTS = 9
# Reviewed aliases outside these nine cases; never follow or recreate them.
OMITTED_LINKS = {
    "agents": "16f9a65697d130e7d3e21753ce43bcfdc66259cc",
    "commands": "75b8b7b6a46d901e2c9caa7aaa37319c37077a90",
    "templates/en/.agent/skills/secrets/secrets": "02594abc6c4295ef791671082d9487ab45e37acb",
    "templates/en/.agent/skills/vcs-pr/vcs-pr": "e5cbe1460ba858dd4c29e9199895c2c9c070a308",
}


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def git_blob(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()


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


def run(argv, cwd, env, timeout=120):
    process = subprocess.Popen([str(x) for x in argv], cwd=cwd, env=env,
                               text=True, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               start_new_session=True)
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired as error:
        terminate_group(process)
        raise AssertionError("command timeout after process-group cleanup") from error
    except BaseException:
        terminate_group(process)
        raise
    require(process.returncode == 0,
            "command failed: " + str(argv) + "\n" + stdout + "\n" + stderr)
    return stdout, stderr


def snapshot(root):
    rows = {}
    def visit(path):
        info = path.lstat()
        relative = path.relative_to(root).as_posix()
        if stat.S_ISDIR(info.st_mode):
            rows[relative] = ("directory", stat.S_IMODE(info.st_mode))
            for entry in sorted(path.iterdir()):
                visit(entry)
        elif stat.S_ISREG(info.st_mode):
            rows[relative] = ("file", stat.S_IMODE(info.st_mode),
                              hashlib.sha256(path.read_bytes()).hexdigest())
        else:
            raise AssertionError("unexpected snapshot file type: " + relative)
    visit(root)
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected-head", required=True)
    parser.add_argument("--node", required=True)
    args = parser.parse_args()
    require(os.name == "posix", "POSIX disposable executor required")
    require(re.fullmatch(r"[0-9a-f]{40}", args.expected_head), "exact commit SHA required")
    require(Path(args.node).is_absolute(), "preinstalled Node absolute path required")
    node = Path(args.node).resolve(strict=True)
    require(node.is_file() and os.access(node, os.X_OK), "Node is not executable")
    source = Path(__file__).resolve().parents[2]
    binding = source / ".agent"
    require(not binding.is_symlink() and
            (not binding.exists() or (binding.is_dir() and not any(binding.iterdir()))),
            "governance checkout must be absent or an empty non-link directory")
    with tempfile.TemporaryDirectory(prefix="cortex-release-cli-", dir="/tmp") as temporary:
        scratch = Path(temporary)
        home, tmp, checkout = (scratch / name for name in ("home", "tmp", "source"))
        for path in (home, tmp, checkout):
            path.mkdir()
        user_config, global_config = scratch / "user.npmrc", scratch / "global.npmrc"
        user_config.write_text("", encoding="utf-8")
        global_config.write_text("", encoding="utf-8")
        env = {
            "PATH": "", "HOME": str(home), "USERPROFILE": str(home),
            "XDG_CONFIG_HOME": str(home / "config"),
            "XDG_CACHE_HOME": str(home / "cache"),
            "XDG_DATA_HOME": str(home / "data"),
            "XDG_STATE_HOME": str(home / "state"),
            "TMPDIR": str(tmp), "TMP": str(tmp), "TEMP": str(tmp),
            "LANG": "C", "LC_ALL": "C", "CI": "true",
            "CORTEX_STATE_SYNC": "off",
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_TERMINAL_PROMPT": "0",
            "NPM_CONFIG_USERCONFIG": str(user_config),
            "NPM_CONFIG_GLOBALCONFIG": str(global_config),
            "NPM_CONFIG_CACHE": str(home / "npm-cache"),
            "NPM_CONFIG_OFFLINE": "true", "NPM_CONFIG_IGNORE_SCRIPTS": "true",
            "NPM_CONFIG_AUDIT": "false", "NPM_CONFIG_FUND": "false",
            "NPM_CONFIG_UPDATE_NOTIFIER": "false",
        }
        # No os.environ spread: credentials, NODE_OPTIONS/NODE_PATH, Host binary
        # overrides, proxy settings and Actions runtime endpoints are absent.
        git_version, _ = run(["/usr/bin/git", "--version"], source, env, timeout=10)
        print(git_version.strip(), flush=True)
        def git(*command):
            return run(["/usr/bin/git", "--no-lazy-fetch", "--no-replace-objects",
                        "-c", "core.fsmonitor=false", *command],
                       source, env, timeout=30)[0]
        require(git("rev-parse", "HEAD").strip() == args.expected_head, "candidate head drift")
        rows = {}
        for record in git("ls-tree", "-rz", "--full-tree", "HEAD").split("\0"):
            if not record:
                continue
            metadata, name = record.split("\t", 1)
            mode, kind, blob = metadata.split()
            relative = PurePosixPath(name)
            require(not relative.is_absolute() and "\\" not in name and
                    name == relative.as_posix() and
                    all(part not in ("", ".", "..", ".git", "node_modules") for part in relative.parts),
                    "unsafe source member: " + name)
            require(name not in rows, "duplicate source member")
            rows[name] = (mode, kind, blob)
        require(rows.get(".agent") == ("160000", "commit", GITLINK), "governance gitlink drift")
        require(not any(name.startswith(".agent/") for name in rows), "embedded governance data")
        for name, blob in TEST_BLOBS.items():
            require(rows.get(name) == ("100644", "blob", blob),
                    "reviewed test changed; re-review its execution closure: " + name)
        require({name: blob for name, (mode, kind, blob) in rows.items() if mode == "120000"}
                == OMITTED_LINKS, "symlink set changed; re-review required")
        omitted = []
        copied = {}
        for name, (mode, kind, blob) in sorted(rows.items()):
            if mode in ("120000", "160000"):
                require((mode == "120000" and kind == "blob") or name == ".agent",
                        "unexpected nested gitlink: " + name)
                if mode == "120000":
                    link = source / name
                    current = source
                    for part in PurePosixPath(name).parts[:-1]:
                        current = current / part
                        require(not current.is_symlink(), "source symlink parent: " + name)
                    require(link.is_symlink() and git_blob(os.readlink(link).encode("utf-8")) == blob,
                            "source link differs from reviewed Git blob: " + name)
                omitted.append({"path": name, "mode": mode, "blob": blob})
                continue
            require(mode in ("100644", "100755") and kind == "blob", "unsupported Git member")
            origin = source / name
            current = source
            for part in PurePosixPath(name).parts:
                current = current / part
                require(not current.is_symlink(), "source symlink traversal: " + name)
            require(stat.S_ISREG(origin.lstat().st_mode), "source is not regular: " + name)
            data = origin.read_bytes()
            require(git_blob(data) == blob, "source bytes differ from exact Git blob: " + name)
            target = checkout / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o755 if mode == "100755" else 0o644)
            copied[name] = blob
        # Required for the real management capability fallback; contains no
        # script/config/data and is never populated from the private submodule.
        (checkout / ".agent").mkdir()
        require(not (checkout / ".git").exists(), "snapshot contains Git credentials/config")
        pkg = json.loads((checkout / "package.json").read_text(encoding="utf-8"))
        for key in ("dependencies", "devDependencies", "optionalDependencies",
                    "peerDependencies", "bundledDependencies", "bundleDependencies", "workspaces"):
            require(not pkg.get(key), "dependency closure requires separate offline review: " + key)
        before = snapshot(scratch)
        version, _ = run([node, "--version"], checkout, env, timeout=10)
        argv = [node, "--test", "--test-reporter=tap", "--test-concurrency=1", *TEST_BLOBS]
        stdout, stderr = run(argv, checkout, env)
        require(snapshot(scratch) == before, "read-only test snapshot/HOME/TMP changed")
        require(not stderr.strip(), "unexpected test runner stderr: " + stderr)
        for key, expected in (("tests", EXPECTED_TESTS), ("pass", EXPECTED_TESTS),
                              ("fail", 0), ("cancelled", 0), ("skipped", 0), ("todo", 0)):
            observed = re.findall(r"^# " + key + r" (\d+)\s*$", stdout, re.MULTILINE)
            require(observed == [str(expected)], "unexpected TAP summary for " + key)
        print(stdout, end="" if stdout.endswith("\n") else "\n")
        print("TARGETED_CLI_EVIDENCE_BEGIN")
        print(json.dumps({
            "status": "PASS", "source_head": args.expected_head,
            "node_version": version.strip(), "git_version": git_version.strip(),
            "test_blobs": TEST_BLOBS,
            "tests": EXPECTED_TESTS, "passed": EXPECTED_TESTS,
            "failed": 0, "skipped": 0, "cancelled": 0, "todo": 0,
            "regular_source_files": len(copied), "omitted_nonregular_members": omitted,
            "source_manifest_sha256": hashlib.sha256(json.dumps(
                copied, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest(),
            "environment_keys": sorted(env), "path": "empty",
            "governance_binding": "fresh empty directory; private gitlink not materialized",
            "snapshot_preserved": True, "snapshot_entries": len(before),
            "snapshot_sha256": hashlib.sha256(json.dumps(
                before, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest(),
            "scope": "nine reviewed source CLI cases; environment/path isolation, not OS sandbox",
            "claims_not_made": ["full suite", "registry install", "real Host", "release authorization"],
        }, indent=2))
        print("TARGETED_CLI_EVIDENCE_END")


if __name__ == "__main__":
    main()
