'use strict';

// Dormant fixed synthetic client. This is deliberately NOT the isolation oracle.
// Only the reviewed supervisor may place it at /client/client.cjs in the measured
// namespace. No caller command, module, hostname, payload or pathname is executed.
const fs = require('node:fs');
const net = require('node:net');
const cp = require('node:child_process');
const CASES = Object.freeze(['allowed', 'race', 'revoked', 'old-fence', 'expired',
  'queued-expiry', 'late-next', 'cached', 'budget', 'crash', 'collision', 'wrong-run',
  'wrong-attempt', 'wrong-channel', 'duplicate', 'malformed', 'escape', 'symlink']);
const ENV = Object.freeze({ LANG: 'C', LC_ALL: 'C', TZ: 'UTC', TMPDIR: '/scratch' });
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
function check(ok, message) { if (!ok) throw new Error(message); }

// Pure construction is exported for source-only tests; it performs no I/O.
function requestFor(name, sequence, fence, binding) {
  check(CASES.includes(name) && Number.isInteger(sequence) && sequence >= 1 && sequence <= 48
    && Number.isInteger(fence) && fence >= 1 && fence <= 8, 'CLOSED_CORPUS');
  check(exact(binding, ['run', 'channel']) && typeof binding.run === 'string' && /^synthetic:[a-f0-9]{64}$/.test(binding.run)
    && ['synthetic:pipe-1', 'synthetic:pipe-2'].includes(binding.channel), 'BINDING');
  const unpublished = ['crash', 'queued-expiry', 'expired', 'revoked', 'late-next', 'old-fence'].includes(name);
  const r = { protocol: 1, project: 'synthetic:linux-sink', run: binding.run, attempt: 1,
    channel: binding.channel, sequence, operation: 'synthetic:' + (name === 'cached' ? 'allowed' : name), fence,
    name: name === 'race' ? 'b.txt' : unpublished ? 'c.txt' : 'a.txt',
    text: name === 'race' || name === 'collision' ? 'beta\n' : unpublished ? 'gamma\n' : 'alpha\n' };
  if (name === 'wrong-run') r.run = 'synthetic:wrong';
  if (name === 'wrong-attempt') r.attempt = 2;
  if (name === 'wrong-channel') r.channel = binding.channel === 'synthetic:pipe-1' ? 'synthetic:pipe-2' : 'synthetic:pipe-1';
  if (name === 'duplicate') r.sequence = sequence - 1;
  if (name === 'escape') r.name = '../sentinel';
  if (name === 'symlink') r.name = '/scratch/link';
  return r;
}

function namespaceEntry() {
  check(process.platform === 'linux' && process.execPath === '/runtime/node'
    && __filename === '/client/client.cjs' && process.cwd() === '/scratch', 'NAMESPACE_ENTRY_ONLY');
  check(Object.keys(process.env).every((key) => Object.hasOwn(ENV, key) || key === 'PWD')
    && Object.entries(ENV).every(([key, value]) => process.env[key] === value)
    && (!process.env.PWD || process.env.PWD === '/scratch'), 'EMPTY_ENVIRONMENT');
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  check(/^NoNewPrivs:\s+1$/m.test(status)
    && ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].every((key) =>
      new RegExp('^' + key + ':\\s+0+$', 'm').test(status)), 'PRIVILEGE_STATE');
}

async function isolationProbe(config) {
  const denied = (fn) => { try { const fd = fn(); if (Number.isInteger(fd)) fs.closeSync(fd); return false; }
    catch (error) { return ['ENOENT', 'EACCES', 'EPERM', 'EROFS', 'ENOTDIR'].includes(error.code); } };
  const scratch = '/scratch/probe.txt';
  fs.writeFileSync(scratch, 'synthetic scratch\n', { flag: 'w', mode: 0o600 });
  const scratchWritable = fs.readFileSync(scratch, 'utf8') === 'synthetic scratch\n';
  const expected = { 'a.txt': 'alpha\n', 'b.txt': 'beta\n', 'c.txt': 'gamma\n' };
  const readonly = Object.entries(expected).every(([name, value]) =>
    fs.readFileSync('/input/' + name, 'utf8') === value
      && denied(() => fs.openSync('/input/' + name, fs.constants.O_WRONLY)))
    && denied(() => fs.openSync('/runtime/node', fs.constants.O_WRONLY));
  const roots = ['/authority', '/sink', '/sentinel', config.private_root,
    config.private_root + '/sink', config.private_root + '/sentinel',
    '/home/runner', '/github', '/run', '/var/run/docker.sock', '/tmp/runner-control'];
  const hidden = roots.every((name) => denied(() => { fs.statSync(name); return null; }))
    && [config.private_root + '/sink/direct.txt', config.private_root + '/sentinel',
      '/authority/synthetic.json', '/sink/direct.txt', '/tmp/runner-control'].every((name) =>
      denied(() => fs.openSync(name, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)));
  const hostHidden = denied(() => fs.openSync('/proc/' + config.parent_pid + '/status', fs.constants.O_RDONLY));
  const routeLines = fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n');
  check(routeLines.length === 1, 'UNEXPECTED_NETWORK_ROUTE');
  const blocked = await new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: config.port });
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; socket.destroy(); resolve(result); } };
    socket.setTimeout(400, () => finish(true));
    socket.once('connect', () => finish(false));
    socket.once('error', (error) => finish(['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EACCES'].includes(error.code)));
  });
  try { fs.symlinkSync(config.private_root + '/sentinel', '/scratch/link'); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const symlink = fs.readlinkSync('/scratch/link') === config.private_root + '/sentinel'
    && denied(() => fs.openSync('/scratch/link', fs.constants.O_WRONLY));
  return { scratch_writable: scratchWritable, readonly_inputs: readonly,
    private_paths_hidden: hidden, host_process_hidden: hostHidden,
    loopback_blocked: blocked, symlink_created: symlink };
}

async function main(mode) {
  check(['capability-probe', 'sink-client', 'descendant'].includes(mode), 'EXPLICIT_MODE_REQUIRED');
  namespaceEntry();
  // The only descendant is this exact reviewed program and fixed wait mode.
  if (mode === 'descendant') {
    setTimeout(() => process.exit(0), 14000);
    return;
  }
  let config = null, binding = null, emits = 0, commands = 0, probes = 0, orphaned = false, buffer = '', bytes = 0;
  let chain = Promise.resolve();
  const watchdog = setTimeout(() => process.exit(72), 14500);
  const output = (value, raw = false) => {
    const line = (raw ? value : JSON.stringify(value)) + '\n';
    bytes += Buffer.byteLength(line); check(bytes <= 65536, 'OUTPUT_BOUND');
    process.stdout.write(line);
  };
  async function command(value) {
    check(++commands <= 60 && value && typeof value === 'object' && !Array.isArray(value), 'COMMAND_BOUND');
    if (!config) {
      check(exact(value, ['op', 'port', 'parent_pid', 'private_root']) && value.op === 'isolation'
        && Number.isInteger(value.port) && value.port >= 1024 && value.port <= 65535
        && Number.isInteger(value.parent_pid) && value.parent_pid > 2
        && typeof value.private_root === 'string'
        && /^\/home\/runner\/work\/_temp\/cortex-linux-sink-[0-9]+-1$/.test(value.private_root), 'ISOLATION_CONFIG');
      config = Object.freeze(value);
      output({ type: 'isolation', ...await isolationProbe(config) });
      return;
    }
    if (value.op === 'exit') {
      check(exact(value, ['op']), 'EXIT_SCHEMA'); clearTimeout(watchdog);
      process.stdin.pause(); process.stdout.end(() => process.exit(0)); return;
    }
    check(mode === 'sink-client', 'CAPABILITY_NO_SINK_MESSAGES');
    if (value.op === 'bind') {
      check(!binding && exact(value, ['op', 'run', 'channel']), 'BIND_ONCE');
      const candidate = { run: value.run, channel: value.channel };
      requestFor('allowed', 1, 1, candidate); binding = Object.freeze(candidate);
      output({ type: 'bound' }); return;
    }
    check(binding, 'BIND_REQUIRED');
    if (value.op === 'emit') {
      check(exact(value, ['op', 'case', 'seq', 'fence']) && ++emits <= 48, 'EMIT_SCHEMA');
      const request = requestFor(value.case, value.seq, value.fence, binding);
      output(value.case === 'malformed' ? '{' : request, value.case === 'malformed'); return;
    }
    if (value.op === 'probe') {
      check(exact(value, ['op']) && ++probes <= 1, 'PROBE_BOUND');
      output({ type: 'probe', ...await isolationProbe(config) }); return;
    }
    if (value.op === 'orphan') {
      check(exact(value, ['op']) && !orphaned, 'ORPHAN_SCHEMA'); orphaned = true;
      const child = cp.spawn('/runtime/node', ['/client/client.cjs', 'descendant'],
        { stdio: 'ignore', env: { ...ENV }, cwd: '/scratch', shell: false });
      child.once('error', () => process.exit(73));
      child.once('spawn', () => {
        output({ type: 'orphan', pid: child.pid });
        // The driver waits for independent descendant observation, then sends exit.
      }); return;
    }
    throw new Error('CLOSED_COMMAND');
  }
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk; check(Buffer.byteLength(buffer) <= 16384, 'INPUT_BOUND');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      check(Buffer.byteLength(line) <= 4096, 'FRAME_BOUND');
      chain = chain.then(() => command(JSON.parse(line))).catch(() => process.exit(74));
    }
  });
  process.stdin.on('end', () => { clearTimeout(watchdog); process.exit(buffer ? 75 : 0); });
}

module.exports = Object.freeze({ requestFor, CASES });
if (require.main === module) {
  if (process.argv.length !== 3) { process.stderr.write('EXPLICIT_NAMESPACE_MODE_REQUIRED\n'); process.exitCode = 64; }
  else main(process.argv[2]).catch(() => { process.stderr.write('CLIENT_REFUSED\n'); process.exitCode = 70; });
}
