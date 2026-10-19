#!/usr/bin/python3
"""Dormant, dependency-free Linux synthetic sink supervisor.

This source is NOT approval to execute it. A separately reviewed single-use
workflow must bind its four source hashes, activation identity and UTC window.
Manifest JSON is an assertion by that controller, not a production authenticator.
No default mode, shell, install, sudo, privilege fallback, Host or provider exists.

The first approved run measures portable runtime manifest R. A later separately
approved sink run uses exactly R, never an alternative runtime discovery route.
Portable paths/mounts/bytes/versions/owners/modes are pinned across disposable
runners; device/inode/ctime are separately observed and pinned WITHIN each run.
--disable-userns changes a limit only in a NEW user namespace; host sysctls are
never written. Missing support/permission is CAPABILITY_UNAVAILABLE, not PASS.
"""
import argparse
import errno
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import selectors
import signal
import socket
import stat
import subprocess
import sys
import time

SOURCE_PATHS = (
    'lib/runtime-state/serialized-artifact-gateway.js',
    'tests/runtime-state/serialized-artifact-gateway.test.js',
    'scripts/l3/linux-sink-canary.py',
    'tests/fixtures/l3/linux-sink-client.cjs',
)
TOOLS = ('/usr/bin/bwrap', '/usr/bin/python3', '/usr/bin/readelf')
NODE_CANDIDATES = ('/usr/bin/node', '/opt/hostedtoolcache/node/22.23.3/x64/bin/node')
INTERPRETER = '/lib64/ld-linux-x86-64.so.2'
ENV = {'LANG': 'C', 'LC_ALL': 'C', 'TZ': 'UTC', 'TMPDIR': '/scratch'}
NS = ('mnt', 'pid', 'net', 'user', 'ipc', 'uts')
CORPUS = {'a.txt': b'alpha\n', 'b.txt': b'beta\n', 'c.txt': b'gamma\n'}
HEX = re.compile(r'^[a-f0-9]{64}$')
RUNNER_TEMP = '/home/runner/work/_temp'
MAX_LOG = 3 * 1024 * 1024
MAX_FRAME = 16384
REQUIRED_OPTIONS = ('--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc',
    '--unshare-uts', '--new-session', '--die-with-parent', '--cap-drop', '--clearenv',
    '--disable-userns', '--assert-userns-disabled', '--json-status-fd', '--proc', '--dev',
    '--ro-bind', '--size', '--tmpfs', '--chdir', '--setenv', '--remount-ro')


class Stop(Exception):
    pass


def require(condition, code):
    if not condition:
        raise Stop(code)


def exact(value, keys, code='SCHEMA'):
    require(isinstance(value, dict) and set(value) == set(keys), code)


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def decode_json(data):
    def pairs(values):
        result = {}
        for key, value in values:
            require(key not in result, 'DUPLICATE_JSON_KEY')
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(Stop('JSON_CONSTANT')))


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)


def read_regular(path, limit=262144):
    path = str(path)
    before = os.lstat(path)
    require(stat.S_ISREG(before.st_mode) and before.st_size <= limit, 'REGULAR_FILE_BOUND')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        require(identity(before) == identity(os.fstat(fd)), 'FILE_CHANGED')
        chunks, length = [], 0
        while True:
            block = os.read(fd, min(65536, limit + 1 - length))
            if not block:
                break
            chunks.append(block); length += len(block)
            require(length <= limit, 'FILE_BOUND')
        require(length == before.st_size and identity(before) == identity(os.fstat(fd))
                == identity(os.lstat(path)), 'FILE_CHANGED')
        return b''.join(chunks)
    finally:
        os.close(fd)


def proc_read(path, limit=262144):
    # Used only for this supervisor or descendants reached through owned /children.
    with open(path, 'rb', buffering=0) as stream:
        data = stream.read(limit + 1)
    require(len(data) <= limit, 'PROC_BOUND')
    return data.decode('utf-8', 'strict')


def safe_root_path(path):
    """Resolve each symlink under protected root-owned parents, never its 0777 mode."""
    require(isinstance(path, str) and path.startswith('/') and os.path.normpath(path) == path,
            'RUNTIME_PATH')
    pending, resolved, links = path.split('/')[1:], '/', 0
    root = os.lstat('/')
    require(root.st_uid == 0 and not root.st_mode & 0o022, 'ROOT_OWNER_MODE')
    while pending:
        component = pending.pop(0)
        if component in ('', '.'):
            continue
        if component == '..':
            resolved = os.path.dirname(resolved); continue
        candidate = os.path.join(resolved, component)
        info = os.lstat(candidate)
        require(info.st_uid == 0, 'RUNTIME_OWNER')
        if stat.S_ISLNK(info.st_mode):
            links += 1; require(links <= 16, 'SYMLINK_BOUND')
            target = os.readlink(candidate)
            if target.startswith('/'):
                resolved = '/'
            pending = target.split('/') + pending
        else:
            require(not info.st_mode & 0o022, 'RUNTIME_MODE')
            require(not pending or stat.S_ISDIR(info.st_mode), 'RUNTIME_PARENT_TYPE')
            resolved = candidate
    require(os.path.realpath(path) == resolved, 'RUNTIME_RESOLUTION_CHANGED')
    return resolved


def safe_runtime_file(path, executable=False):
    resolved = safe_root_path(path)
    info = os.stat(resolved)
    require(stat.S_ISREG(info.st_mode) and not info.st_mode & 0o6000
            and (not executable or info.st_mode & 0o111), 'RUNTIME_TYPE_PRIVILEGES')
    try:
        require(not os.getxattr(resolved, 'security.capability'), 'FILE_CAPABILITIES')
    except OSError as error:
        require(error.errno == errno.ENODATA, 'FILE_CAPABILITY_UNOBSERVABLE')
    content = read_regular(resolved, 128 * 1024 * 1024)
    require(content[:6] == b'\x7fELF\x02\x01' and content[18:20] == b'\x3e\x00', 'ELF_X64_REQUIRED')
    portable = {'path': path, 'canonical': resolved, 'uid': info.st_uid, 'gid': info.st_gid,
                'mode': stat.S_IMODE(info.st_mode), 'size': len(content), 'sha256': digest(content)}
    observed = {'canonical': resolved, 'device': str(info.st_dev), 'inode': str(info.st_ino),
                'ctime_ns': str(info.st_ctime_ns), 'mtime_ns': str(info.st_mtime_ns)}
    return portable, observed, identity(info)


def mount_template(runtime, source, inputs, status_fd, mode):
    require(mode in ('capability-probe', 'sink-client'), 'CLIENT_MODE')
    argv = ['/usr/bin/bwrap', '--unshare-user', '--unshare-pid', '--unshare-net',
        '--unshare-ipc', '--unshare-uts', '--new-session', '--die-with-parent',
        '--cap-drop', 'ALL', '--clearenv', '--disable-userns', '--assert-userns-disabled',
        '--json-status-fd', str(status_fd), '--proc', '/proc', '--remount-ro', '/proc',
        '--dev', '/dev', '--remount-ro', '/dev']
    for item in runtime['mounts']:
        argv += ['--ro-bind', item['source'], item['target']]
    argv += ['--ro-bind', str(source / SOURCE_PATHS[3]), '/client/client.cjs']
    for name in CORPUS:
        argv += ['--ro-bind', str(inputs / name), '/input/' + name]
    argv += ['--size', '16777216', '--tmpfs', '/scratch', '--chdir', '/scratch']
    for name, value in ENV.items():
        argv += ['--setenv', name, value]
    argv += ['--remount-ro', '/', '--', '/runtime/node', '/client/client.cjs', mode]
    return argv


def parse_mountinfo(data):
    rows = []
    for line in data.splitlines():
        left, right = line.split(' - ', 1)
        fields, after = left.split(), right.split()
        require(len(fields) >= 6 and len(after) >= 3 and '\\' not in fields[4], 'MOUNT_FORMAT')
        rows.append({'target': fields[4], 'options': fields[5].split(','),
                     'fstype': after[0], 'source': after[1], 'super': after[2].split(',')})
    require(len(rows) <= 96, 'MOUNT_COUNT')
    return rows


class Supervisor:
    def __init__(self, mode, manifest):
        self.mode, self.manifest = mode, manifest
        self.source = Path(__file__).resolve().parents[2]
        self.started = time.monotonic()
        # Reserve two seconds for owned-identity emergency termination.
        self.deadline = self.started + (28 if mode == 'capability-only' else 88)
        self.log_bytes = 0
        self.starts, self.sandboxes, self.owned = [], [], {}
        self.runtime_pins, self.runtime_observed = {}, []
        self.streams, self.buffers, self.eofs = {}, {}, set()
        self.threads_peak = 0
        self.anchor = None
        self.shutdown_done = False
        self.listener = None
        self.network_accepts = 0
        self.evidence = []
        self.diagnostics = []
        self.cleanup_attempted = False
        self.cleanup_complete = False

    def within(self):
        require(time.monotonic() < self.deadline, 'SUPERVISOR_DEADLINE')
        require(time.time() < self.manifest['activation']['expires_at'], 'ACTIVATION_EXPIRED')
        for sandbox in self.sandboxes:
            require(sandbox['process'].poll() is not None or
                    time.monotonic() - sandbox['started'] <= 15, 'CLIENT_DEADLINE')

    def charge(self, length):
        require(self.log_bytes + length <= MAX_LOG - 524288, 'AGGREGATE_LOG_BOUND')
        self.log_bytes += length

    def source_check(self):
        for name in SOURCE_PATHS:
            path = self.source / name
            require(str(path.resolve()) == str(path)
                    and digest(read_regular(path)) == self.manifest['source_manifest'][name], 'SOURCE_CHANGED')

    def attest(self, path, executable=False):
        portable, observed, pinned = safe_runtime_file(path, executable)
        self.runtime_pins[portable['canonical']] = pinned
        self.runtime_observed.append(observed)
        return portable

    def runtime_check(self):
        for path, pinned in self.runtime_pins.items():
            require(identity(os.stat(path)) == pinned, 'RUNTIME_CHANGED_WITHIN_RUN')

    def admit_library(self, target, count, used_bytes):
        self.within()
        require(isinstance(target, str) and os.path.normpath(target) == target
                and any(target.startswith(root + '/') for root in ('/lib', '/lib64', '/usr/lib')),
                'LIBRARY_PATH_POLICY')
        resolved = safe_root_path(target)
        roots = {os.path.realpath(root) for root in ('/lib', '/lib64', '/usr/lib')}
        require(any(resolved.startswith(root + '/') for root in roots), 'LIBRARY_CANONICAL_ROOT')
        size = os.stat(resolved).st_size
        require(count < 32 and used_bytes + size <= 128 * 1024 * 1024, 'R_DISCOVERY_BOUND')
        return size

    def own(self, pid, expected_parent, parent_identity=None):
        if parent_identity is not None and self.exited(parent_identity):
            return None
        try:
            raw = proc_read('/proc/%d/stat' % pid, 4096)
        except FileNotFoundError:
            return None
        fields = raw[raw.rfind(')') + 2:].split()
        if int(fields[1]) != expected_parent:
            return None  # A child disappeared/reparented or its number was reused.
        key = (pid, fields[19])
        if key not in self.owned:
            require(len(self.owned) < 64, 'OBSERVED_PROCESS_BOUND')
            fd = os.pidfd_open(pid, 0)
            second = proc_read('/proc/%d/stat' % pid, 4096)
            again = second[second.rfind(')') + 2:].split()
            require(again[19] == key[1] and int(again[1]) == expected_parent, 'PID_REUSED_OR_REPARENTED')
            if parent_identity is not None and self.exited(parent_identity):
                os.close(fd); return None
            self.owned[key] = {'pid': pid, 'start': key[1], 'pidfd': fd, 'ppid': int(fields[1])}
        return self.owned[key]

    @staticmethod
    def exited(record):
        select = selectors.DefaultSelector()
        try:
            select.register(record['pidfd'], selectors.EVENT_READ)
            return bool(select.select(0))
        finally:
            select.close()

    def tree(self, pid):
        # Never rediscover an exited direct child by its recyclable PID number.
        root = next((item for item in self.owned.values()
                     if item['pid'] == pid and not self.exited(item)), None)
        if root is None:
            return []
        pending, result = [(pid, None)], []
        while pending:
            child, parent = pending.pop()
            record = root if parent is None else self.own(child, parent['pid'], parent)
            if record is None or self.exited(record):
                continue
            if any(item['pid'] == child for item in result):
                continue
            result.append(record)
            require(len(result) <= 64, 'TREE_BOUND')
            try:
                tasks = os.listdir('/proc/%d/task' % child)
                require(len(tasks) <= 128, 'THREAD_BOUND')
                record['threads'] = len(tasks)
                for tid in tasks:
                    children = proc_read('/proc/%d/task/%s/children' % (child, tid), 4096)
                    pending.extend((int(value), record) for value in children.split())
            except FileNotFoundError:
                pass
        self.threads_peak = max(self.threads_peak, sum(x.get('threads', 0) for x in result))
        return result

    def launch(self, argv, *, pass_fds=(), stdin=subprocess.DEVNULL):
        self.within(); self.runtime_check(); self.source_check()
        require(len(self.starts) < 32 and argv[0] in
                ['/usr/bin/bwrap', '/usr/bin/python3', '/usr/bin/readelf',
                 *NODE_CANDIDATES, self.runtime.get('node', {}).get('canonical', ''),
                 os.path.realpath(INTERPRETER)], 'DIRECT_PROCESS_BOUND_OR_EXECUTABLE')
        process = subprocess.Popen(argv, stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=dict(ENV), close_fds=True, pass_fds=tuple(pass_fds), cwd=str(self.anchor or self.source),
            shell=False, start_new_session=True, bufsize=0)
        self.starts.append(process)
        record = self.own(process.pid, os.getpid())
        require(record and record['ppid'] == os.getpid(), 'CHILD_PARENT_IDENTITY')
        return process

    def fixed_tool(self, argv, limit=262144):
        process = self.launch(argv)
        streams = [process.stdout, process.stderr]
        select = selectors.DefaultSelector()
        output = [bytearray(), bytearray()]
        try:
            for index, stream in enumerate(streams):
                os.set_blocking(stream.fileno(), False)
                select.register(stream, selectors.EVENT_READ, index)
            end = min(self.deadline, time.monotonic() + 5)
            while select.get_map():
                self.within(); require(time.monotonic() < end, 'TOOL_TIMEOUT')
                for key, _ in select.select(.05):
                    data = os.read(key.fileobj.fileno(), 8192)
                    if not data:
                        select.unregister(key.fileobj); continue
                    self.charge(len(data)); output[key.data] += data
                    require(sum(map(len, output)) <= limit, 'TOOL_OUTPUT_BOUND')
            require(process.wait(timeout=.1) == 0, 'FIXED_TOOL_FAILED')
            return bytes(output[0]).decode('utf-8', 'strict')
        finally:
            if process.poll() != 0:
                self.diagnostics.append({'tool': argv[0], 'returncode': process.poll(),
                    'stdout': bytes(output[0][:2048]).decode('utf-8', 'replace'),
                    'stderr': bytes(output[1][:4096]).decode('utf-8', 'replace')})
            select.close()
            for stream in streams:
                stream.close()

    def runtime_manifest(self):
        self.runtime = {}
        tool_files = {path: self.attest(path, True) for path in TOOLS}
        require(os.path.realpath(sys.executable) == tool_files['/usr/bin/python3']['canonical'], 'PYTHON_PATH')
        if self.mode == 'sink-canary':
            expected = self.manifest['runtime_manifest']
            exact(expected, ['schema', 'node', 'tools', 'mounts', 'versions', 'template'], 'R_SCHEMA')
            require(type(expected['schema']) is int and expected['schema'] == 1
                    and expected['tools'] == tool_files, 'R_TOOL_CHANGED')
            require(expected['node']['path'] in NODE_CANDIDATES, 'R_NODE_PATH')
            node = self.attest(expected['node']['path'], True)
            require(node == expected['node'], 'R_NODE_CHANGED')
            mounts = expected['mounts']
            require(isinstance(mounts, list) and 2 <= len(mounts) <= 32, 'R_MOUNT_COUNT')
            total = 0
            for index, item in enumerate(mounts):
                self.within()
                exact(item, ['source', 'target', 'file'], 'R_MOUNT')
                if index == 0:
                    require(item['target'] == '/runtime/node' and item['file'] == node, 'R_NODE_MAPPING')
                    size = node['size']
                else:
                    size = self.admit_library(item['file']['path'], index, total)
                    self.admit_library(item['target'], index, total)
                total += size
                require(total <= 128 * 1024 * 1024, 'R_BYTE_BOUND')
                require(item['source'] == item['file']['canonical']
                        and self.attest(item['file']['path']) == item['file'], 'R_FILE_CHANGED')
            self.runtime = expected
        else:
            candidates = [self.attest(path, True) for path in NODE_CANDIDATES if os.path.lexists(path)]
            require(candidates and len({item['sha256'] for item in candidates}) == 1, 'NODE_MISSING_OR_AMBIGUOUS')
            node = candidates[0]
            self.runtime = {'node': node}
            headers = self.fixed_tool(['/usr/bin/readelf', '-lW', '--', node['canonical']])
            interpreters = re.findall(r'Requesting program interpreter:\s*([^\]]+)\]', headers)
            require(interpreters == [INTERPRETER], 'INTERPRETER_POLICY')
            self.admit_library(INTERPRETER, 1, node['size'])
            loader = self.attest(INTERPRETER, True)
            listing = self.fixed_tool([loader['canonical'], '--list', node['canonical']])
            mounts = [{'source': node['canonical'], 'target': '/runtime/node', 'file': node},
                      {'source': loader['canonical'], 'target': INTERPRETER, 'file': loader}]
            for line in listing.splitlines():
                self.within()
                line = line.strip()
                if not line or re.fullmatch(r'linux-vdso\.so\.1 \(0x[a-f0-9]+\)', line):
                    continue
                match = re.fullmatch(r'(?:[^\s]+ => )?(/[^\s]+) \(0x[a-f0-9]+\)', line)
                require(match is not None, 'LOADER_OUTPUT_POLICY')
                target = match.group(1)
                if target == INTERPRETER:
                    continue
                self.admit_library(target, len(mounts), sum(item['file']['size'] for item in mounts))
                info = self.attest(target)
                mounts.append({'source': info['canonical'], 'target': target, 'file': info})
            self.runtime = {'schema': 1, 'node': node, 'tools': tool_files, 'mounts': mounts,
                            'versions': {}, 'template': 'linux-sink-rootless-v1-disable-userns'}
        self.validate_mapping()
        versions = {'bwrap': self.fixed_tool(['/usr/bin/bwrap', '--version']).strip(),
                    'python': self.fixed_tool(['/usr/bin/python3', '--version']).strip(),
                    'readelf': self.fixed_tool(['/usr/bin/readelf', '--version']).splitlines()[0],
                    'node': self.fixed_tool([node['canonical'], '--version']).strip()}
        help_text = self.fixed_tool(['/usr/bin/bwrap', '--help'])
        require(all(option in help_text for option in REQUIRED_OPTIONS), 'BWRAP_OPTIONS_UNAVAILABLE')
        if self.mode == 'sink-canary':
            require(versions == self.runtime['versions'], 'R_VERSION_CHANGED')
        else:
            self.runtime['versions'] = versions

    def validate_mapping(self):
        runtime = self.runtime
        require(runtime['template'] == 'linux-sink-rootless-v1-disable-userns', 'R_TEMPLATE')
        mounts = runtime['mounts']
        require(2 <= len(mounts) <= 32 and len({item['target'] for item in mounts}) == len(mounts), 'R_MAPPING_BOUND')
        require(sum(item['file']['size'] for item in mounts) <= 128 * 1024 * 1024, 'R_BYTE_BOUND')
        require(mounts[0]['target'] == '/runtime/node' and mounts[0]['file'] == runtime['node']
                and mounts[1]['target'] == INTERPRETER, 'R_REQUIRED_MAPPING')
        roots = {os.path.realpath(path) for path in ('/lib', '/lib64', '/usr/lib')}
        for item in mounts[1:]:
            require(any(item['source'].startswith(root + '/') for root in roots), 'LIBRARY_CANONICAL_ROOT')
            require(any(item['target'].startswith(root + '/') for root in ('/lib', '/lib64', '/usr/lib'))
                    and os.path.normpath(item['target']) == item['target'], 'LIBRARY_MOUNT_TARGET')

    def prepare(self):
        require(platform.system() == 'Linux' and platform.machine() == 'x86_64'
                and os.getuid() != 0, 'LINUX_UNPRIVILEGED_X64_REQUIRED')
        require(hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'), 'PIDFD_REQUIRED')
        require(set(os.environ) == set(ENV) | {'RUNNER_TEMP'}
                and all(os.environ[key] == value for key, value in ENV.items()), 'SUPERVISOR_EMPTY_ENVIRONMENT')
        require(os.environ.get('RUNNER_TEMP') == RUNNER_TEMP and os.path.realpath(RUNNER_TEMP) == RUNNER_TEMP,
                'RUNNER_TEMP_REQUIRED')
        os_release_path = safe_root_path('/etc/os-release')
        require(os_release_path in ('/etc/os-release', '/usr/lib/os-release'), 'OS_METADATA_PATH')
        os_release = read_regular(os_release_path, 8192).decode()
        require(re.search(r'^ID=ubuntu$', os_release, re.M)
                and re.search(r'^VERSION_ID="24\.04"$', os_release, re.M), 'UBUNTU24_REQUIRED')
        self.source_check()
        self.self_ns = {name: os.readlink('/proc/self/ns/' + name) for name in NS}
        self.policy_before = {name: proc_read('/proc/sys/' + name, 64).strip() for name in
                              ('user/max_user_namespaces', 'kernel/unprivileged_userns_clone')
                              if os.path.exists('/proc/sys/' + name)}
        self.runtime_manifest()
        activation = self.manifest['activation']
        self.anchor = Path(RUNNER_TEMP) / ('cortex-linux-sink-%s-1' % activation['run_id'])
        os.mkdir(self.anchor, 0o700)  # Exclusive one-invocation marker; never removed.
        self.anchor_identity = identity(os.lstat(self.anchor))[:5]
        self.create(self.anchor / 'invocation.json', canonical_json({'mode': self.mode,
            'source_commit': self.manifest['source_commit'], 'activation': activation}))
        self.inputs = self.anchor / 'inputs'; os.mkdir(self.inputs, 0o700)
        self.sink = self.anchor / 'sink'; os.mkdir(self.sink, 0o700)
        self.sink_identity = identity(os.lstat(self.sink))[:5]
        for name, data in CORPUS.items():
            self.create(self.inputs / name, data)
        self.create(self.anchor / 'sentinel', b'SYNTHETIC OUTSIDE SINK SENTINEL\n')
        self.sentinel = digest(read_regular(self.anchor / 'sentinel'))
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(('127.0.0.1', 0)); self.listener.listen(2); self.listener.setblocking(False)
        require(self.listener.getsockname()[1] >= 1024, 'LOOPBACK_PORT')

    @staticmethod
    def create(path, data):
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            require(os.write(fd, data) == len(data), 'SHORT_WRITE'); os.fsync(fd)
        finally:
            os.close(fd)

    def watch(self, stream, label):
        fd = stream if isinstance(stream, int) else stream.fileno()
        require(fd not in self.streams, 'STREAM_ALIAS')
        os.set_blocking(fd, False)
        self.streams[fd] = label; self.buffers[fd] = bytearray()
        return fd

    def pump(self, timeout=.02):
        self.within()
        select = selectors.DefaultSelector()
        try:
            for fd in self.streams:
                if fd not in self.eofs:
                    select.register(fd, selectors.EVENT_READ)
            if self.listener:
                select.register(self.listener, selectors.EVENT_READ, 'listener')
            for key, _ in select.select(timeout):
                if key.data == 'listener':
                    connection, _ = self.listener.accept(); connection.close()
                    self.network_accepts += 1; raise Stop('HOST_LOOPBACK_REACHABLE')
                fd = key.fd
                block = os.read(fd, 8192)
                if not block:
                    self.eofs.add(fd); continue
                self.charge(len(block)); self.buffers[fd] += block
                require(len(self.buffers[fd]) <= 262144, 'STREAM_BOUND')
        finally:
            select.close()

    def line(self, fd, deadline):
        while b'\n' not in self.buffers[fd]:
            require(len(self.buffers[fd]) <= MAX_FRAME and fd not in self.eofs, 'FRAME_EOF_OR_BOUND')
            require(time.monotonic() < deadline, 'FRAME_TIMEOUT')
            self.pump()
        line, _, rest = self.buffers[fd].partition(b'\n')
        require(len(line) <= MAX_FRAME, 'FRAME_BOUND')
        self.buffers[fd] = bytearray(rest)
        return decode_json(line)

    @staticmethod
    def send(stream, message):
        data = canonical_json(message) + b'\n'
        require(len(data) <= MAX_FRAME, 'OUTGOING_FRAME_BOUND')
        if isinstance(stream, socket.socket):
            stream.sendall(data)
        else:
            require(stream.write(data) == len(data), 'PIPE_SHORT_WRITE')

    def launch_sandbox(self):
        require(len(self.sandboxes) < (1 if self.mode == 'capability-only' else 6), 'SANDBOX_BOUND')
        require(sum(item['process'].poll() is None for item in self.sandboxes) < 2, 'CONCURRENT_CLIENT_BOUND')
        status_read, status_write = os.pipe2(os.O_CLOEXEC)
        mode = 'capability-probe' if self.mode == 'capability-only' else 'sink-client'
        argv = mount_template(self.runtime, self.source, self.inputs, status_write, mode)
        try:
            process = self.launch(argv, pass_fds=(status_write,), stdin=subprocess.PIPE)
        finally:
            os.close(status_write)
        sandbox = {'process': process, 'started': time.monotonic(), 'argv': argv,
            'status_fd': self.watch(status_read, 'bwrap-status'), 'status_events': [],
            'stderr_fd': self.watch(process.stderr, 'client-stderr'), 'namespace_records': [],
            'stdin_inode': os.fstat(process.stdin.fileno()).st_ino,
            'stdout_inode': os.fstat(process.stdout.fileno()).st_ino,
            'stderr_inode': os.fstat(process.stderr.fileno()).st_ino}
        self.sandboxes.append(sandbox)
        status = self.line(sandbox['status_fd'], time.monotonic() + 5)
        require(isinstance(status, dict) and type(status.get('child-pid')) is int
                and status['child-pid'] > 1, 'BWRAP_STATUS_REQUIRED')
        sandbox['status_events'].append(status); sandbox['init_pid'] = status['child-pid']
        tree = self.tree(process.pid)
        require(any(record['pid'] == sandbox['init_pid'] for record in tree), 'STATUS_PID_NOT_OWNED')
        self.send(process.stdin, {'op': 'isolation', 'port': self.listener.getsockname()[1],
            'parent_pid': os.getpid(), 'private_root': str(self.anchor)})
        output_fd = self.watch(process.stdout, 'client-probe')
        probe = self.line(output_fd, time.monotonic() + 3)
        exact(probe, ['type', 'scratch_writable', 'readonly_inputs', 'private_paths_hidden',
                      'host_process_hidden', 'loopback_blocked', 'symlink_created'], 'PROBE_SCHEMA')
        require(probe['type'] == 'isolation' and all(value is True for key, value in probe.items()
                if key != 'type'), 'CLIENT_ISOLATION_FAILURE')
        require(not self.buffers[output_fd], 'UNSOLICITED_CLIENT_OUTPUT')
        del self.streams[output_fd]; del self.buffers[output_fd]
        os.set_blocking(output_fd, True)
        sandbox['probe'] = probe
        self.inspect(sandbox)
        return sandbox

    def inspect(self, sandbox):
        tree = self.tree(sandbox['process'].pid)
        init = next((record for record in tree if record['pid'] == sandbox['init_pid']), None)
        require(init is not None, 'NAMESPACE_INIT_UNOBSERVED')
        namespaces = {name: os.readlink('/proc/%d/ns/%s' % (init['pid'], name)) for name in NS}
        require(all(namespaces[name] != self.self_ns[name] for name in NS), 'NAMESPACE_NOT_DISTINCT')
        if 'namespaces' in sandbox:
            require(namespaces == sandbox['namespaces'], 'NAMESPACE_CHANGED')
        sandbox['namespaces'] = namespaces
        for other in self.sandboxes:
            if other is not sandbox and 'namespaces' in other:
                require(all(namespaces[name] != other['namespaces'][name] for name in NS), 'CLIENT_NAMESPACE_SHARED')
        rows = parse_mountinfo(proc_read('/proc/%d/mountinfo' % init['pid']))
        readonly = {item['target'] for item in self.runtime['mounts']} | {'/client/client.cjs',
                    '/input/a.txt', '/input/b.txt', '/input/c.txt', '/', '/proc', '/dev'}
        devices = {'/dev', '/dev/pts', '/dev/shm', '/dev/null', '/dev/zero', '/dev/full',
                   '/dev/random', '/dev/urandom', '/dev/tty'}
        require({row['target'] for row in rows} <= readonly | devices | {'/scratch'}, 'UNEXPECTED_MOUNT')
        require(readonly <= {row['target'] for row in rows}, 'MISSING_MOUNT')
        for row in rows:
            if row['target'] in readonly:
                require('ro' in row['options'], 'READONLY_MOUNT_WRITABLE')
            if row['target'] == '/dev/shm':
                require('ro' in row['options'], 'UNBOUNDED_DEV_SHM')
            if row['target'] == '/scratch':
                require(row['fstype'] == 'tmpfs' and 'rw' in row['options']
                        and ('size=16384k' in row['super'] or 'size=16777216' in row['super']), 'SCRATCH_BOUND')
        namespace_records, clients, fd_evidence = [], [], []
        for record in tree:
            pid = record['pid']
            try:
                if os.readlink('/proc/%d/ns/pid' % pid) != namespaces['pid']:
                    continue
                namespace_records.append(record)
                status = dict(line.split(':', 1) for line in proc_read('/proc/%d/status' % pid, 8192).splitlines() if ':' in line)
                require(status.get('NoNewPrivs', '').strip() == '1' and all(
                    int(status.get(name, 'f').strip(), 16) == 0 for name in
                    ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb')), 'PRIVILEGE_OBSERVATION')
                require(len(status.get('NSpid', '').split()) >= 2, 'PID_NAMESPACE_STATUS')
                executable = os.stat('/proc/%d/exe' % pid)
                node = os.stat(self.runtime['node']['canonical'])
                if (executable.st_dev, executable.st_ino) != (node.st_dev, node.st_ino):
                    continue  # The measured bwrap namespace init is not a client.
                clients.append(record)
                if 'client_pid' in sandbox and pid != sandbox['client_pid']:
                    require(record['ppid'] == sandbox['client_pid'], 'DESCENDANT_PARENT')
                    record['namespace_pid'] = int(status['NSpid'].split()[-1])
                    sandbox['descendant'] = record
                expected_pipes = {0: sandbox['stdin_inode'], 1: sandbox['stdout_inode'], 2: sandbox['stderr_inode']}
                fds = {}
                for number in os.listdir('/proc/%d/fd' % pid):
                    target = os.readlink('/proc/%d/fd/%s' % (pid, number)); fd = int(number)
                    fds[number] = target
                    if fd in expected_pipes:
                        # A fixed descendant intentionally has stdio=/dev/null.
                        require(target == 'pipe:[%d]' % expected_pipes[fd] or
                                (pid != sandbox.get('client_pid', pid) and target == '/dev/null'), 'STDIO_PIPE_CHANGED')
                    else:
                        require(target in ('anon_inode:[eventpoll]', 'anon_inode:[eventfd]', '/dev/null')
                            or re.fullmatch(r'pipe:\[\d+\]', target) is not None, 'UNEXPECTED_CLIENT_FD')
                # Runtime-internal pipes are permitted, but not supervisor/status
                # descriptors or directory/socket/file capabilities inherited at exec.
                status_inode = os.fstat(sandbox['status_fd']).st_ino
                require('pipe:[%d]' % status_inode not in fds.values(), 'STATUS_FD_LEAK')
                require(len(fds) <= 32 and {'0', '1', '2'} <= set(fds), 'CLIENT_FD_BOUND')
                fd_evidence.append({'pid': pid, 'fds': fds, 'threads': record.get('threads', 0)})
            except FileNotFoundError:
                continue
        require(clients, 'CLIENT_NOT_OBSERVED')
        if 'client_pid' not in sandbox:
            require(len(clients) == 1, 'INITIAL_CLIENT_COUNT')
            sandbox['client_pid'] = clients[0]['pid']
        sandbox['namespace_records'] = list({(record['pid'], record['start']): record
            for record in sandbox['namespace_records'] + namespace_records}.values())
        sandbox['mounts'] = rows
        sandbox['fd_evidence'] = fd_evidence
        return len(clients)

    def sentinels(self):
        require(identity(os.lstat(self.anchor))[:5] == self.anchor_identity
                and identity(os.lstat(self.sink))[:5] == self.sink_identity, 'PRIVATE_ROOT_CHANGED')
        require(digest(read_regular(self.anchor / 'sentinel')) == self.sentinel, 'SENTINEL_CHANGED')
        for name, content in CORPUS.items():
            require(read_regular(self.inputs / name) == content, 'SYNTHETIC_INPUT_CHANGED')
        for name, value in self.policy_before.items():
            require(proc_read('/proc/sys/' + name, 64).strip() == value, 'HOST_POLICY_CHANGED')
        self.source_check(); self.runtime_check()
        require(self.network_accepts == 0, 'HOST_LOOPBACK_REACHABLE')

    def observation(self):
        self.within(); self.sentinels()
        alive = 0
        for sandbox in self.sandboxes:
            init = next((x for x in sandbox['namespace_records'] if x['pid'] == sandbox['init_pid']), None)
            if init and self.exited(init):
                require(all(self.exited(x) for x in sandbox['namespace_records']), 'EXITING_TREE_UNKNOWN')
                continue
            if sandbox['process'].poll() is None:
                alive += self.inspect(sandbox)
        require(alive <= 2, 'LIVE_CLIENT_BOUND')
        descendant = next((x['descendant'] for x in self.sandboxes if 'descendant' in x), None)
        return {'namespaces_verified': True, 'fds_verified': True, 'mounts_verified': True,
            'sentinels_unchanged': True, 'source_unchanged': True, 'processes_observed': len(self.owned),
            'threads_peak': self.threads_peak, 'clients_alive': alive,
            'descendant_observed': descendant is not None,
            'descendant_namespace_pid': descendant['namespace_pid'] if descendant else None,
            'descendant_starttime': descendant['start'] if descendant else None}

    def shutdown(self):
        if self.shutdown_done:
            return True
        # Admission is closed by the fixed driver before this request. EOF and
        # namespace-init pidfd exit, not a group signal or directory removal,
        # are the cleanup oracle. Keep every observed start identity until exit.
        for sandbox in self.sandboxes:
            self.tree(sandbox['process'].pid)
            try:
                if sandbox['process'].poll() is None:
                    self.inspect(sandbox)
            except Stop as error:
                # A normal client can already have exited. Previously captured
                # namespace identity remains necessary; never invent a new one.
                require(str(error) in ('NAMESPACE_INIT_UNOBSERVED', 'CLIENT_NOT_OBSERVED')
                        and 'namespaces' in sandbox, 'SHUTDOWN_EVIDENCE_FAILURE')
            process = sandbox['process']
            process.stdin.close()
            fd = process.stdout.fileno()
            if fd not in self.streams:
                self.watch(process.stdout, 'client-final-eof')
        grace = min(self.deadline - .2, time.monotonic() + 5)
        while time.monotonic() < grace and any(p.poll() is None for p in [x['process'] for x in self.sandboxes]):
            for sandbox in self.sandboxes:
                self.tree(sandbox['process'].pid)
            self.pump(.02)
        for sandbox in self.sandboxes:
            process = sandbox['process']
            if process.poll() is None:
                records = self.tree(process.pid)
                # Kill only the recorded namespace init, which causes the kernel
                # to kill its descendants; verify every captured pidfd afterward.
                init = next((x for x in records if x['pid'] == sandbox['init_pid']), None)
                require(init is not None, 'NAMESPACE_INIT_IDENTITY_LOST')
                signal.pidfd_send_signal(init['pidfd'], signal.SIGKILL)
        end = min(self.deadline - .1, time.monotonic() + 2)
        while time.monotonic() < end:
            self.pump(.02)
            if all(x['process'].poll() is not None for x in self.sandboxes):
                fds = [fd for x in self.sandboxes for fd in
                    (x['status_fd'], x['stderr_fd'], x['process'].stdout.fileno())]
                if all(fd in self.eofs for fd in fds):
                    break
        for sandbox in self.sandboxes:
            require(sandbox['process'].poll() is not None, 'BWRAP_EXIT_UNCONFIRMED')
            require(sandbox['namespace_records'] and all(self.exited(x) for x in sandbox['namespace_records']),
                    'NAMESPACE_TREE_EXIT_UNCONFIRMED')
            status_fd = sandbox['status_fd']
            while b'\n' in self.buffers[status_fd]:
                sandbox['status_events'].append(self.line(status_fd, self.deadline))
            require(not self.buffers[status_fd] and any('exit-code' in x for x in sandbox['status_events']),
                    'BWRAP_EXIT_STATUS_MISSING')
            require(all(fd in self.eofs for fd in (status_fd, sandbox['stderr_fd'],
                    sandbox['process'].stdout.fileno())), 'PIPE_EOF_UNCONFIRMED')
        self.sentinels(); self.shutdown_done = True
        return True

    def driver(self, recovery=None):
        self.source_check(); self.runtime_check()
        if recovery is None:
            # Direct inherited FIFO traffic is independently capped by the
            # pinned driver/client. Reserve its entire bound in aggregate logs.
            self.charge(262144)
        parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        parent.settimeout(1)
        pass_fds = [child.fileno()]
        pipes = []
        if recovery is None:
            for sandbox in self.sandboxes:
                read_fd, write_fd = sandbox['process'].stdout.fileno(), sandbox['process'].stdin.fileno()
                pass_fds += [read_fd, write_fd]
                pipe = {'readFd': read_fd, 'writeFd': write_fd}
                for key, fd in [('readStat', read_fd), ('writeStat', write_fd)]:
                    info = os.fstat(fd); pipe[key] = {'dev': str(info.st_dev), 'ino': str(info.st_ino)}
                pipes.append(pipe)
        require(all(3 <= fd <= 255 for fd in pass_fds), 'CONTROL_FD_BOUND')
        process = self.launch([self.runtime['node']['canonical'], str(self.source / SOURCE_PATHS[1]),
            '--physical-reconcile' if recovery else '--physical-supervised', str(child.fileno())], pass_fds=pass_fds)
        child.close()
        control_fd = self.watch(parent, 'driver-control')
        self.watch(process.stdout, 'driver-stdout'); self.watch(process.stderr, 'driver-stderr')
        hello = {'type': 'hello', 'protocol': 1, 'synthetic': True, 'nonce': self.nonce,
            'root': str(self.sink), 'parent_pid': os.getpid(),
            'source_manifest': self.manifest['source_manifest'], 'pipes': pipes}
        if recovery:
            hello['recovery'] = recovery
        self.send(parent, hello)
        ready = self.line(control_fd, time.monotonic() + 5)
        require(ready == {'type': 'ready', 'protocol': 1, 'synthetic': True}, 'DRIVER_READY')
        last_id, result = 0, None
        while result is None:
            message = self.line(control_fd, self.deadline - 1)
            kind = message.get('type') if isinstance(message, dict) else None
            if kind in ('observe', 'shutdown') and recovery is None:
                exact(message, ['type', 'id'], 'CONTROL_SCHEMA')
                require(type(message['id']) is int and last_id < message['id'] <= 16, 'CONTROL_SEQUENCE')
                last_id = message['id']
                if kind == 'observe':
                    response = {'type': 'observation', 'id': last_id, 'ok': True, 'evidence': self.observation()}
                else:
                    self.shutdown()
                    response = {'type': 'shutdown-result', 'id': last_id, 'ok': True,
                        'namespace_exit_confirmed': True, 'pipes_eof': True, 'sentinels_unchanged': True}
                self.send(parent, response)
            elif kind == 'crash-ready' and recovery is None:
                exact(message, ['type', 'synthetic', 'report', 'recovery'], 'CRASH_SCHEMA')
                require(message['synthetic'] is True and self.shutdown_done, 'CRASH_BEFORE_SHUTDOWN')
                value = message['recovery']
                exact(value, ['name', 'size', 'sha256', 'operation', 'journal_events'], 'RECOVERY_SCHEMA')
                require(value['name'] == 'c.txt' and type(value['size']) is int and value['size'] == 6
                    and value['sha256'] == digest(CORPUS['c.txt']) and value['operation'] == 'synthetic:crash'
                    and type(value['journal_events']) is int and 1 <= value['journal_events'] <= 128, 'RECOVERY_SCOPE')
                result = message
            elif kind == 'result':
                exact(message, ['type', 'status', 'synthetic', 'report'], 'RESULT_SCHEMA')
                require(recovery is not None and message['status'] == 'SINK_CANARY_COMPONENT_PASS'
                        and message['synthetic'] is True, 'DRIVER_FAILED')
                result = message
            else:
                raise Stop('CONTROL_MESSAGE')
        end = min(self.deadline - .1, time.monotonic() + 2)
        while process.poll() is None and time.monotonic() < end:
            self.pump()
        require(process.poll() == (0 if recovery else 86), 'DRIVER_EXIT_UNCONFIRMED')
        while control_fd not in self.eofs and time.monotonic() < end:
            self.pump()
        require(control_fd in self.eofs and not self.buffers[control_fd], 'CONTROL_EOF_REQUIRED')
        del self.streams[control_fd]; del self.buffers[control_fd]; self.eofs.discard(control_fd)
        parent.close()
        self.sentinels()
        return result

    def inventory(self):
        entries, size = [], 0
        for name in sorted(os.listdir(self.sink)):
            require(name in ('.journal', '.prep-1', '.prep-2', '.prep-3', *CORPUS), 'UNEXPECTED_SINK_ENTRY')
            data = read_regular(self.sink / name, 262144)
            size += len(data); require(size <= 524288, 'SINK_SIZE_BOUND')
            entries.append({'name': name, 'size': len(data), 'sha256': digest(data)})
        return entries

    def run(self):
        self.prepare()
        self.nonce = os.urandom(32).hex()
        self.launch_sandbox()
        if self.mode == 'capability-only':
            observation = self.observation()
            require(os.listdir(self.sink) == [], 'CAPABILITY_SINK_NOT_EMPTY')
            self.send(self.sandboxes[0]['process'].stdin, {'op': 'exit'})
            self.shutdown()
            result = {'status': 'CAPABILITY_AVAILABLE', 'observation': observation,
                      'gateway_loaded': False, 'artifact_publications': 0}
        else:
            self.launch_sandbox()
            before_effects = self.observation()
            require(before_effects['clients_alive'] == 2 and os.listdir(self.sink) == [], 'BEFORE_EFFECTS')
            first = self.driver()
            before = self.inventory()
            second = self.driver(first['recovery'])
            after = self.inventory()
            require(before == after, 'RECONCILIATION_MUTATED_FILES')
            require([item['name'] for item in after] == ['.journal', 'a.txt', 'b.txt', 'c.txt'], 'FINAL_COUNT')
            for item in after:
                if item['name'] in CORPUS:
                    require(item['sha256'] == digest(CORPUS[item['name']])
                            and item['size'] == len(CORPUS[item['name']]), 'INDEPENDENT_DIGEST')
            report = first['report']
            require(isinstance(report, dict) and len(report.get('cases', [])) == 16
                    and report.get('counts', {}).get('publications') == 3
                    and report.get('counts', {}).get('requests', 49) <= 48, 'SCENARIO_BOUND')
            result = {'status': 'SYNTHETIC_SINK_CANARY_PASS', 'before_effects': before_effects,
                'component_report': report, 'reconciliation': second['report'],
                'independent_inventory': after, 'formal_acceptance': False,
                'production_authority': False, 'artifact_publications': 3}
        self.sentinels()
        result.update(self.receipt())
        result['remaining_files'] = self.cleanup()
        result['scratch_removed'] = True
        result['invocation_marker_preserved'] = True
        return result

    def receipt(self):
        return {'mode': self.mode, 'synthetic': True, 'source_commit': self.manifest['source_commit'],
            'activation': self.manifest['activation'], 'runtime_manifest': self.runtime,
            'runtime_manifest_sha256': digest(canonical_json(self.runtime)),
            'runtime_observations': self.runtime_observed,
            'kernel': platform.release(), 'namespace_policy_unchanged': True,
            'nested_userns_policy': 'disable-userns+assert-userns-disabled in newly-created namespace only',
            'process_starts': len(self.starts), 'processes_observed': len(self.owned),
            'threads_peak': self.threads_peak, 'log_bytes': self.log_bytes,
            'sandbox_count': len(self.sandboxes), 'elapsed_ms': round((time.monotonic() - self.started) * 1000),
            'sandboxes': [{'argv': item['argv'], 'status': item['status_events'],
                'namespaces': item.get('namespaces'), 'mounts': item.get('mounts'),
                'fds': item.get('fd_evidence'), 'client_probe': item.get('probe'),
                'processes': [{'pid': x['pid'], 'starttime': x['start'], 'exit_confirmed': self.exited(x)}
                    for x in item['namespace_records']]} for item in self.sandboxes],
            'namespace_exit_confirmed': self.shutdown_done}

    def cleanup(self):
        require(self.shutdown_done and all(process.poll() is not None for process in self.starts),
                'CLEANUP_BEFORE_EXIT')
        require(all(self.exited(record) for record in self.owned.values()), 'OWNED_EXIT_UNCONFIRMED')
        self.sentinels()
        self.cleanup_attempted = True
        # No rmtree or global deletion. Remove only bounded known regular leaves
        # under stable private roots, leaving the exclusive per-run marker.
        for item in self.inventory():
            os.unlink(self.sink / item['name'])
        os.rmdir(self.sink)
        for name in CORPUS:
            os.unlink(self.inputs / name)
        os.rmdir(self.inputs)
        os.unlink(self.anchor / 'sentinel')
        require(os.path.realpath(self.anchor) == str(self.anchor)
                and identity(os.lstat(self.anchor))[:5] == self.anchor_identity
                and os.listdir(self.anchor) == ['invocation.json'], 'CLEANUP_REMAINDER')
        marker = read_regular(self.anchor / 'invocation.json', 4096)
        self.cleanup_complete = True
        return [{'name': 'invocation.json', 'size': len(marker), 'sha256': digest(marker)}]

    def emergency_stop(self):
        # Stop first; never clean up on an ambiguous failure. Only pidfd-owned
        # identities are signalled. The disposable VM is the final safety net.
        for process in self.starts:
            try:
                self.tree(process.pid)
            except (OSError, Stop):
                pass
        for record in reversed(list(self.owned.values())):
            try:
                if not self.exited(record):
                    signal.pidfd_send_signal(record['pidfd'], signal.SIGKILL)
            except OSError:
                pass
        end = time.monotonic() + 2
        while time.monotonic() < end and any(process.poll() is None for process in self.starts):
            time.sleep(.02)
        # Retain bounded original diagnostics even after the normal deadline.
        # This is pipe draining only, with no retry or additional execution.
        for fd in self.streams:
            try:
                while len(self.buffers[fd]) < 262144 and self.log_bytes < MAX_LOG - 524288:
                    block = os.read(fd, min(8192, 262144 - len(self.buffers[fd]),
                                           MAX_LOG - 524288 - self.log_bytes))
                    if not block:
                        self.eofs.add(fd); break
                    self.buffers[fd] += block; self.log_bytes += len(block)
            except (BlockingIOError, OSError):
                pass
        return all(self.exited(record) for record in self.owned.values())

    def failure_evidence(self):
        return {'runtime_manifest': getattr(self, 'runtime', None),
            'runtime_observations': self.runtime_observed, 'diagnostics': self.diagnostics,
            'process_starts': len(self.starts), 'processes_observed': len(self.owned),
            'log_bytes': self.log_bytes, 'cleanup_attempted': self.cleanup_attempted,
            'cleanup_complete': self.cleanup_complete,
            'owned_processes': [{'pid': item['pid'], 'starttime': item['start'],
                'exit_confirmed': self.exited(item)} for item in self.owned.values()],
            'streams': [{'label': label, 'eof': fd in self.eofs,
                'captured_prefix': bytes(self.buffers[fd][:4096]).decode('utf-8', 'replace')}
                for fd, label in self.streams.items() if label != 'client-probe'],
            'sandboxes': [{'status': item['status_events'], 'namespaces': item.get('namespaces'),
                'mounts': item.get('mounts'), 'fds': item.get('fd_evidence'),
                'client_probe': item.get('probe')} for item in self.sandboxes]}


def validate_manifest(value, mode, now):
    exact(value, ['schema', 'mode', 'source_commit', 'source_manifest', 'activation',
                  'runtime_manifest', 'capability_receipt_sha256'], 'MANIFEST_SCHEMA')
    require(type(value['schema']) is int and value['schema'] == 1 and value['mode'] == mode
            and isinstance(value['source_commit'], str)
            and re.fullmatch(r'[a-f0-9]{40}', value['source_commit']), 'SOURCE_COMMIT_MODE')
    exact(value['source_manifest'], SOURCE_PATHS, 'SOURCE_MANIFEST')
    require(all(isinstance(item, str) and HEX.fullmatch(item) for item in value['source_manifest'].values()), 'SOURCE_HASH')
    activation = value['activation']
    exact(activation, ['run_id', 'workflow_id', 'run_number', 'run_attempt', 'not_before', 'expires_at'], 'ACTIVATION_SCHEMA')
    require(all(isinstance(activation[key], str) and re.fullmatch(r'[1-9][0-9]{0,19}', activation[key])
                for key in ('run_id', 'workflow_id')), 'ACTIVATION_IDENTITIES')
    require(type(activation['run_number']) is int and activation['run_number'] >= 1
            and type(activation['run_attempt']) is int and activation['run_attempt'] == 1, 'SINGLE_ATTEMPT')
    require(all(type(activation[key]) is int for key in ('not_before', 'expires_at'))
            and activation['not_before'] <= now < activation['expires_at']
            and 0 < activation['expires_at'] - activation['not_before'] <= 900, 'ACTIVATION_WINDOW')
    if mode == 'capability-only':
        require(activation['run_number'] == 1, 'FIRST_CAPABILITY_RUN_ONLY')
        require(value['runtime_manifest'] is None and value['capability_receipt_sha256'] is None,
                'PROBE_MUST_DISCOVER_R')
    else:
        require(activation['run_number'] >= 2, 'LATER_SINK_RUN_REQUIRED')
        require(isinstance(value['runtime_manifest'], dict)
                and isinstance(value['capability_receipt_sha256'], str)
                and HEX.fullmatch(value['capability_receipt_sha256']), 'PINNED_CAPABILITY_REQUIRED')
    return value


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('capability-only', 'sink-canary'))
    parser.add_argument('--manifest', required=True)
    args = parser.parse_args(argv)
    supervisor = None
    try:
        manifest = validate_manifest(decode_json(read_regular(args.manifest, 524288)), args.mode, time.time())
        supervisor = Supervisor(args.mode, manifest)
        result = supervisor.run()
        output = canonical_json(result)
        require(len(output) + 1 <= 524288 and supervisor.log_bytes + len(output) + 1 <= MAX_LOG, 'RECEIPT_BOUND')
        print(output.decode()); return 0
    except (Stop, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        exited = supervisor.emergency_stop() if supervisor else True
        possible_effects = False
        if supervisor and args.mode == 'sink-canary' and supervisor.anchor and hasattr(supervisor, 'sink'):
            try:
                possible_effects = bool(os.listdir(supervisor.sink))
            except OSError:
                possible_effects = True
        status = 'UNKNOWN' if possible_effects or not exited else 'CAPABILITY_UNAVAILABLE'
        result = {'status': status, 'mode': args.mode, 'synthetic': True,
            'code': str(error)[:512], 'physical_canary_pass': False, 'formal_acceptance': False,
            'owned_exit_confirmed': exited,
            'evidence_preserved': bool(supervisor and supervisor.anchor), 'automatic_retry': False}
        if supervisor:
            result['evidence'] = supervisor.failure_evidence()
        output = canonical_json(result)
        if len(output) + 1 > 524288:
            # Never let even failure reporting exceed the reserved receipt
            # budget. Truncation is explicit and cannot produce a PASS.
            evidence = result.pop('evidence', {})
            result['status'] = 'UNKNOWN'
            result['evidence'] = {'truncated': True, 'full_evidence_sha256': digest(canonical_json(evidence)),
                'diagnostics': evidence.get('diagnostics', []),
                'cleanup_attempted': evidence.get('cleanup_attempted', False),
                'cleanup_complete': evidence.get('cleanup_complete', False),
                'owned_processes': evidence.get('owned_processes', [])}
            output = canonical_json(result)
        accounted = supervisor.log_bytes if supervisor else 0
        if len(output) + 1 > 524288 or accounted + len(output) + 1 > MAX_LOG:
            output = canonical_json({'status': 'UNKNOWN', 'mode': args.mode,
                'code': 'FAILURE_RECEIPT_BOUND', 'truncated': True,
                'evidence_sha256': digest(output), 'physical_canary_pass': False})
        print(output.decode()); return 1


if __name__ == '__main__':
    sys.exit(main())
