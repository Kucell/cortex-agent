#!/usr/bin/env bash
# Keychain backend: all operations target an explicit (service, account) pair.
set -euo pipefail
if [ "$(uname -s)" != Darwin ]; then
  echo '{"ok":false,"error":"keychain_backend_unsupported_on_platform"}'
  exit 1
fi
node - "${1:-}" <<'NODE'
const { spawnSync } = require('node:child_process');
function fail(error) { console.log(JSON.stringify({ ok: false, error })); process.exit(1); }
let input;
try { input = JSON.parse(process.argv[2]); } catch { fail('invalid_payload'); }
if (!input || typeof input !== 'object') fail('invalid_payload');
const { action, ref, service, account, value } = input;
for (const item of [action, ref, service, account]) {
  if (typeof item !== 'string' || !item || item.includes('\0')) fail('missing_or_invalid_action_ref_service_or_account');
}
if (!['get', 'store', 'rotate', 'delete'].includes(action)) fail('unknown_action');
if (action === 'store' && (typeof value !== 'string' || !value || value.includes('\0'))) fail('missing_or_invalid_value');
let args;
if (action === 'get') args = ['find-generic-password', '-s', service, '-a', account, '-w'];
else if (action === 'store') args = ['add-generic-password', '-U', '-s', service, '-a', account, '-w', value];
else args = ['delete-generic-password', '-s', service, '-a', account];
const result = spawnSync('security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
if (result.error || result.status !== 0) {
  if (result.status === 44) fail('not_found');
  fail(`keychain_${action}_failed`);
}
const output = { ok: true, action, ref };
if (action === 'get') output.value = result.stdout.replace(/\n$/, '');
else output.service = service;
console.log(JSON.stringify(output));
NODE
