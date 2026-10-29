"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
function python(body) {
  const prefix = `import importlib.util\nfrom pathlib import Path\ndef load(name, file):\n s=importlib.util.spec_from_file_location(name,file); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); return m\nu=load('upgrade', 'scripts/release/registry-upgrade-acceptance.py')\ni=load('identity', 'scripts/release/registry-baseline-identity.py')\n`;
  const r = spawnSync("python3", ["-B", "-c", prefix + body], { cwd: root, encoding: "utf8", timeout: 10000 });
  assert.ifError(r.error); assert.equal(r.signal, null); assert.equal(r.status, 0, r.stderr);
}
test("historical baseline and helper pins remain independently selected", () => python(`p=u.baseline_profile('1.15.4')
assert p['head']=='ea360b6697ecac9a37090e7b40df14b8a3585d8f'
assert p['sha256']=='5d63b33f2e8a0415070f04d571d43e24b5ae64d4eb9485643cbc5f7b24ea8285'
assert p['members']==1224 and p['bytes']==1943765
assert p['helper_pins']==u.HELPER_PINS['old']
`));
test("maintenance baseline has its own verified identity and helper closure", () => python(`p=u.baseline_profile('1.15.6')
assert p['head']=='fc594201576f5239801d41b86a8f7e107ea8e7c0'
assert p['tree']=='dc842415070ebf4ebb96c3a59a728627e73793ad'
assert p['sha256']=='80e0cce514ad9a1cc7806d57091489b13652578c560627b2a3875a95827d68e6'
assert p['members']==1301 and p['bytes']==2165950
assert set(p['helper_pins'])==set(u.HELPER_PINS['old'])
assert p['helper_pins']!=u.HELPER_PINS['old']
`));
test("unknown baseline and crossed/arbitrary registry paths fail before network", () => python(`def forbidden(*args, **kwargs):
 raise RuntimeError('network called')
i.http.client.HTTPSConnection=forbidden
for v in ['1.16.0','latest','../1.15.6']:
 try: u.baseline_profile(v)
 except AssertionError: pass
 else: raise AssertionError('unknown baseline accepted')
for v,p in [('1.15.6','/cortex-agent/1.15.4'),('1.15.4','/cortex-agent/-/cortex-agent-1.15.6.tgz'),('1.15.6','https://example.invalid/x'),('latest','/cortex-agent/latest')]:
 try: i.get_fixed(p,1,{'application/json'},version=v)
 except AssertionError: pass
 else: raise AssertionError('path accepted')
`));
test("both fixed official paths reach the unchanged HTTPS transport", () => python(`class TransportReached(Exception): pass
def transport(host, **kwargs):
 assert host=='registry.npmjs.org' and kwargs['port']==443
 raise TransportReached()
i.http.client.HTTPSConnection=transport
for v in ['1.15.4','1.15.6']:
 for p in ['/cortex-agent/'+v,'/cortex-agent/-/cortex-agent-'+v+'.tgz']:
  try: i.get_fixed(p,1,{'application/json'},version=v)
  except TransportReached: pass
  else: raise AssertionError('transport not reached')
`));
