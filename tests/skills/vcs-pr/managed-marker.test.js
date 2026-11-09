/**
 * tests/skills/vcs-pr/managed-marker.test.js
 *
 * M-013: the managed-creation marker must survive caller-supplied bodies and
 * accept the alias spellings used by MR governance checks.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveTemplatePath } = require('../../helpers/template-layers');
const vcs = require(resolveTemplatePath('skills/vcs-pr/scripts/index.js', 'en'));

test('canonical marker is not duplicated', () => {
  const body = '## 受管创建\n- 创建入口：vcs-pr\n\n## 提交范围\n- x';
  assert.equal(vcs.ensureManagedCreationMarker(body), body);
});

test('alias marker is recognized and kept in place', () => {
  const body = '## MR 创建入口\n- 创建入口：vcs-pr\n\n正文';
  const out = vcs.ensureManagedCreationMarker(body);
  assert.equal(out.split('创建入口：vcs-pr').length, 2);
  assert.ok(out.includes('## MR 创建入口'));
  assert.ok(!out.startsWith('## 受管创建'));
});

test('body without marker gets the canonical heading prepended', () => {
  const out = vcs.ensureManagedCreationMarker('只有正文');
  assert.equal(out, '## 受管创建\n- 创建入口：vcs-pr\n\n只有正文');
});

test('update bodies are normalized through the same marker rule', () => {
  assert.equal(vcs.applyUpdateBody(null), null);
  assert.equal(
    vcs.applyUpdateBody('## 受管创建\n- 创建入口：vcs-pr\n\nbody'),
    '## 受管创建\n- 创建入口：vcs-pr\n\nbody',
  );
  assert.ok(vcs.applyUpdateBody('## managed creation\n- 创建入口：vcs-pr\n\nbody')
    .startsWith('## managed creation'));
});
