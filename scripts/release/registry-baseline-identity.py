#!/usr/bin/env python3
"""Capture the public cortex-agent@1.15.4 registry identity without executing it.

Exactly two credential-free HTTPS GETs to a fixed official host/path pair.
No redirects, proxies, npm, extraction, subprocesses, artifact upload, or Host.
Use: env -i PATH=/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 python3 -I <this-file>
A later execution review must pin the recorded integrity and inspect source.
"""
import argparse
import base64
import gzip
import hashlib
import http.client
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import ssl
import tarfile
import tempfile

HOST = "registry.npmjs.org"
METADATA_PATH = "/cortex-agent/1.15.4"
TAR_PATH = "/cortex-agent/-/cortex-agent-1.15.4.tgz"
TAR_URL = "https://" + HOST + TAR_PATH
MAX_METADATA = 2 * 1024 * 1024
MAX_TAR = 16 * 1024 * 1024
MAX_UNPACKED = 64 * 1024 * 1024
MAX_FILE = 4 * 1024 * 1024
MAX_MEMBERS = 5000
LIFECYCLE = {"preinstall", "install", "postinstall", "prepare", "prepack",
             "postpack", "prepublish", "prepublishOnly", "publish", "postpublish"}

def require(ok, message):
    if not ok:
        raise AssertionError(message)

def deadline(_signal, _frame):
    raise TimeoutError("bounded registry identity read exceeded 90 seconds")

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON key")
        result[key] = value
    return result

def parse_json(raw):
    return json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object)

def sha(data, algorithm="sha256"):
    return hashlib.new(algorithm, data).hexdigest()

def parse_integrity(value):
    require(isinstance(value, str) and 0 < len(value) <= 512, "invalid SRI string")
    tokens = value.split(" ")
    require(all(tokens) and len(tokens) <= 3, "invalid SRI token list")
    expected = {}
    lengths = {"sha256": 32, "sha384": 48, "sha512": 64}
    for token in tokens:
        match = re.fullmatch(r"(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})", token)
        require(match is not None, "unknown or malformed SRI algorithm/token")
        algorithm, encoded = match.groups()
        require(algorithm not in expected, "duplicate SRI algorithm")
        decoded = base64.b64decode(encoded, validate=True)
        require(len(decoded) == lengths[algorithm] and
                base64.b64encode(decoded).decode("ascii") == encoded,
                "noncanonical SRI digest")
        expected[algorithm] = decoded
    require("sha512" in expected, "SHA512 SRI is required")
    return expected

def get_fixed(path, limit, accepted_types, *, version="1.15.4"):
    require(version in ("1.15.4", "1.15.6"), "unreviewed registry version")
    allowed = ("/cortex-agent/" + version, "/cortex-agent/-/cortex-agent-" + version + ".tgz")
    require(path in allowed, "unreviewed registry path")
    connection = http.client.HTTPSConnection(
        HOST, port=443, timeout=20, context=ssl.create_default_context())
    try:
        connection.request("GET", path, headers={
            "Accept": "*/*", "Accept-Encoding": "identity",
            "User-Agent": "cortex-release-identity-review/1",
            "Connection": "close",
        })
        response = connection.getresponse()
        require(response.status == 200, "registry HTTP status " + str(response.status))
        require(not response.getheader("Location"), "redirect header is not allowed")
        require(response.getheader("Content-Encoding", "identity") == "identity",
                "unexpected content encoding")
        content_type = response.getheader("Content-Type", "").split(";", 1)[0].strip().lower()
        require(content_type in accepted_types, "unexpected registry content type")
        length = response.getheader("Content-Length")
        if length is not None:
            require(length.isdecimal() and int(length) <= limit, "response size limit")
        chunks = []
        total = 0
        while True:
            chunk = response.read(min(65536, limit + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            require(total <= limit, "response exceeds size limit")
        raw = b"".join(chunks)
        require(raw, "empty response")
        if length is not None:
            require(len(raw) == int(length), "incomplete registry response")
        return raw
    finally:
        connection.close()

def inspect_tar(raw):
    with gzip.GzipFile(fileobj=io.BytesIO(raw), mode="rb") as archive:
        plain = archive.read(MAX_UNPACKED + 1)
    require(len(plain) <= MAX_UNPACKED, "decompressed tar size limit")
    manifest = {}
    members = {}
    package_bytes = None
    with tarfile.open(fileobj=io.BytesIO(plain), mode="r:") as archive:
        for index, member in enumerate(archive):
            require(index < MAX_MEMBERS, "tar member count limit")
            name = member.name
            require(isinstance(name, str) and len(name) <= 1024 and
                    all(ord(char) >= 32 and ord(char) != 127 for char in name),
                    "unsafe tar member name")
            if name in ("package", "package/") and member.isdir():
                continue
            require(name.startswith("package/") and "\\" not in name,
                    "unexpected tar root")
            relative = name[len("package/"):].rstrip("/") if member.isdir() else name[len("package/"):]
            path = PurePosixPath(relative)
            require(relative and not path.is_absolute() and
                    ".." not in path.parts and relative == path.as_posix(),
                    "unsafe or noncanonical tar path")
            require(relative not in members, "duplicate tar member")
            require(".git" not in path.parts and "node_modules" not in path.parts and
                    path.parts[0] != ".agent" and relative != ".npmrc",
                    "forbidden package content")
            require(not member.mode & 0o7000, "special tar permission bits")
            require(member.isdir() or member.isfile(), "tar link or special member")
            require(not getattr(member, "sparse", None), "sparse tar member")
            members[relative] = "directory" if member.isdir() else "file"
            if member.isdir():
                continue
            require(0 <= member.size <= MAX_FILE, "tar file size limit")
            stream = archive.extractfile(member)
            require(stream is not None, "unreadable tar member")
            data = stream.read(MAX_FILE + 1)
            require(len(data) == member.size, "tar member size mismatch")
            blob = sha(b"blob " + str(len(data)).encode("ascii") + b"\0" + data, "sha1")
            manifest[relative] = {"bytes": len(data), "mode": member.mode,
                                  "sha256": sha(data), "git_blob_sha1": blob}
            if relative == "package.json":
                package_bytes = data
    for relative in members:
        for parent in PurePosixPath(relative).parents:
            if parent.as_posix() != ".":
                require(members.get(parent.as_posix()) != "file", "file/directory path conflict")
    require(package_bytes is not None, "missing package.json")
    return manifest, parse_json(package_bytes)

def main():
    require(os.name == "posix", "POSIX runner required")
    require(set(os.environ) <= {"PATH", "LANG", "LC_ALL", "LC_CTYPE"}, "use a cleared launcher environment")
    require(os.environ.get("PATH") == "/usr/bin:/bin", "fixed launcher PATH required")
    require(all(os.environ.get(key, "C.UTF-8") == "C.UTF-8"
                for key in ("LANG", "LC_ALL", "LC_CTYPE")), "fixed UTF-8 locale required")
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected-integrity")
    args = parser.parse_args()
    if args.expected_integrity is not None:
        require(set(parse_integrity(args.expected_integrity)) == {"sha512"},
                "expected integrity must be one canonical SHA512 SRI value")
    signal.signal(signal.SIGALRM, deadline)
    signal.alarm(90)
    try:
        metadata_bytes = get_fixed(METADATA_PATH, MAX_METADATA, {"application/json"})
        metadata = parse_json(metadata_bytes)
        require(isinstance(metadata, dict) and metadata.get("name") == "cortex-agent" and
                metadata.get("version") == "1.15.4", "registry identity mismatch")
        dist = metadata.get("dist")
        require(isinstance(dist, dict) and dist.get("tarball") == TAR_URL,
                "registry tarball URL differs from fixed official path")
        integrity = dist.get("integrity")
        integrity_digests = parse_integrity(integrity)
        pinned_sha512 = "sha512-" + base64.b64encode(integrity_digests["sha512"]).decode("ascii")
        if args.expected_integrity is not None:
            require(pinned_sha512 == args.expected_integrity, "previously pinned integrity changed")
        git_head = metadata.get("gitHead")
        require(isinstance(git_head, str) and re.fullmatch(r"[0-9a-f]{40}", git_head),
                "registry gitHead is missing or malformed")
        with tempfile.TemporaryDirectory(prefix="cortex-registry-identity-", dir="/tmp") as temporary:
            raw = get_fixed(TAR_PATH, MAX_TAR,
                            {"application/octet-stream", "application/gzip", "application/x-gzip"})
            for algorithm, expected_digest in integrity_digests.items():
                require(hashlib.new(algorithm, raw).digest() == expected_digest,
                        "tar integrity mismatch: " + algorithm)
            if dist.get("shasum") is not None:
                require(dist["shasum"] == sha(raw, "sha1"), "tar SHA1 mismatch")
            archive_path = Path(temporary) / "cortex-agent-1.15.4.tgz"
            archive_path.write_bytes(raw)
            require(archive_path.read_bytes() == raw, "temporary tar write mismatch")
            manifest, package = inspect_tar(raw)
            require(isinstance(package, dict) and package.get("name") == "cortex-agent" and
                    package.get("version") == "1.15.4", "tar package identity mismatch")
            dependency_keys = ["dependencies", "devDependencies", "optionalDependencies",
                               "peerDependencies", "bundleDependencies", "bundledDependencies", "workspaces"]
            blockers = [key for key in dependency_keys if package.get(key)]
            scripts = package.get("scripts", {})
            require(isinstance(scripts, dict), "invalid package scripts")
            lifecycle = sorted(LIFECYCLE.intersection(scripts))
            require("bin/cli.js" in manifest and "lib/commands/upgrade.js" in manifest,
                    "required package entrypoints missing")
            evidence = {
                "schema_version": 1,
                "scope": "official-registry-identity-and-tar-structure-only",
                "metadata_url": "https://" + HOST + METADATA_PATH,
                "metadata_sha256": sha(metadata_bytes),
                "package": "cortex-agent", "version": "1.15.4", "gitHead_claim": git_head,
                "gitHead_source_mapping_verified": False,
                "tar": {"url": TAR_URL, "bytes": len(raw), "sha256": sha(raw),
                        "sha512": sha(raw, "sha512"), "sha1": sha(raw, "sha1"),
                        "integrity": integrity, "pinned_sha512_integrity": pinned_sha512,
                        "verified_integrity_algorithms": sorted(integrity_digests)},
                "previously_pinned_integrity_checked": args.expected_integrity is not None,
                "files": manifest,
                "package_bin": package.get("bin"),
                "dependency_fields_requiring_separate_review": blockers,
                "lifecycle_script_names": lifecycle,
                "registry_signatures_present": bool(dist.get("signatures")),
                "registry_attestations_present": bool(dist.get("attestations")),
                "signature_and_provenance_verified": False,
                "network_requests": ["GET " + METADATA_PATH, "GET " + TAR_PATH],
                "claims_not_made": ["package-install", "package-execution", "upgrade-preservation",
                                    "published-candidate", "AI-Host", "Claude-install", "formal-L3"],
            }
        evidence["temporary_tar_removed"] = not archive_path.exists()
        require(evidence["temporary_tar_removed"], "temporary tar cleanup failed")
        print("REGISTRY_BASELINE_IDENTITY_BEGIN")
        print(json.dumps(evidence, sort_keys=True, indent=2))
        print("REGISTRY_BASELINE_IDENTITY_END")
    finally:
        signal.alarm(0)

if __name__ == "__main__":
    main()
