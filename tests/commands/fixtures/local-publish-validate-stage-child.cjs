'use strict';

// Loaded only in isolated test subprocesses. No real volta/git/target CLI.
// Opt-in real npm pack is limited to the synthetic runtime fixture, with hooks
// disabled; all builds/tests remain controlled substitutes.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const spawn = cp.spawnSync;
function mutatePackage(cwd, phase, fault) {
  if (!fault || !fault.startsWith(`${phase}-`)) return;
  const file = path.join(cwd, 'package.json'), pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (fault === `${phase}-add-hook`) pkg.scripts.prepack = 'node -e "throw new Error(\'new prepack must not execute\')"';
  else if (fault === `${phase}-name`) pkg.name = '@fixture/changed-name';
  else if (fault === `${phase}-version`) pkg.version = '9.9.9';
  else return;
  fs.writeFileSync(file, JSON.stringify(pkg));
}
cp.spawnSync = (command, args, options = {}) => {
  if (command === process.execPath) return spawn(command, args, options);
  const env = options.env || process.env;
  const event = { command, args, cwd: options.cwd || process.cwd(),
    tmp: env.TMPDIR, cache: env.npm_config_cache };
  if (process.env.LPV_EVENTS) fs.appendFileSync(process.env.LPV_EVENTS, JSON.stringify(event) + '\n');
  const result = { status: 0, signal: null, stdout: '', stderr: '' };
  const fault = process.env.LPV_FAULT;
  if (command === 'git' && args[0] === 'status') return { ...result, stdout: process.env.LPV_DIRTY ? ' M package.json\n' : '' };
  if (command === 'npm' && args[0] === 'run') {
    if (fault === 'build') return { ...result, status: 17 };
    mutatePackage(options.cwd, 'build', fault);
    return result;
  }
  if (command === 'node' && args[0] === 'scripts/test-runner.cjs') {
    if (fault === 'tests') return { ...result, status: 18 };
    mutatePackage(options.cwd, 'tests', fault);
    if (fault === 'remove-target') fs.rmSync(process.env.LPV_TARGET, { recursive: true });
    if (fault === 'side-effects') {
      fs.writeFileSync(path.join(options.cwd, '.agent/version-stamp'), 'trusted test side effect\n');
      fs.writeFileSync(path.join(process.env.LPV_TARGET, '.agent/version-stamp'), 'trusted test target side effect\n');
    }
    return result;
  }
  if (command === 'npm' && args[0] === 'pack') {
    if (process.env.LPV_REAL_PACK === '1') {
      if (!args.includes('--ignore-scripts')) throw Error('Real test pack requires disabled lifecycle scripts');
      return spawn(command, args, { ...options, env: { ...env, NODE_OPTIONS: '', npm_config_update_notifier: 'false' } });
    }
    if (fault === 'pack') return { ...result, status: 19, stderr: 'synthetic pack failure' };
    if (fault === 'signal') return { ...result, status: null, signal: 'SIGTERM' };
    if (fault === 'spawn') return { ...result, status: null, error: Error('synthetic spawn failure') };
    const pkg = JSON.parse(fs.readFileSync(path.join(options.cwd, 'package.json'), 'utf8'));
    const destination = args[args.indexOf('--pack-destination') + 1];
    const filename = 'candidate with spaces.tgz';
    if (fault !== 'missing') fs.writeFileSync(path.join(destination, filename), 'synthetic candidate bytes\n');
    const entry = { name: pkg.name, version: pkg.version, filename };
    if (fault === 'metadata') entry.version = '99.0.0';
    if (fault === 'path') entry.filename = '../outside.tgz';
    return { ...result, stdout: args.includes('--json') ? JSON.stringify([entry]) : filename + '\n' };
  }
  if (command === 'volta' && args[0] === 'install') return result;
  if (command === 'cortex-agent' && ['upgrade', 'update'].includes(args[0])) {
    fs.writeFileSync(path.join(options.cwd, '.agent', 'version-stamp'), `synthetic ${args[0]}\n`);
    return result;
  }
  throw Error(`Unexpected subprocess in isolated test: ${command} ${args.join(' ')}`);
};
