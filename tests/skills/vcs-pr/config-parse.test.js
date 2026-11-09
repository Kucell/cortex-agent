/**
 * tests/skills/vcs-pr/config-parse.test.js
 *
 * The merge call must be able to use a dedicated human Maintainer PAT
 * (`merge_token_ref`) while every other command keeps the shared CI token.
 * `parseVcsConfig` is exported so this split can be verified without spawning
 * the secrets CLI.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveTemplatePath } = require('../../helpers/template-layers');
const vcs = require(resolveTemplatePath('skills/vcs-pr/scripts/index.js', 'en'));

test('parseVcsConfig reads merge_token_ref next to the shared token_ref', () => {
  const cfg = vcs.parseVcsConfig([
    'backend: gitlab',
    'host: "https://gitlab.example.com"',
    'token_ref: gitlab-pr',
    'merge_token_ref: gitlab-merge',
    'default:',
    '  org: Kucell',
    '  repo: cortex-agent',
    '  base_branch: main',
  ].join('\n'));
  assert.equal(cfg.backend, 'gitlab');
  assert.equal(cfg.host, 'https://gitlab.example.com');
  assert.equal(cfg.token_ref, 'gitlab-pr');
  assert.equal(cfg.merge_token_ref, 'gitlab-merge');
  assert.deepEqual(cfg.default, { org: 'Kucell', repo: 'cortex-agent', base_branch: 'main' });
});

test('parseVcsConfig keeps merge_token_ref null when it is not configured', () => {
  const cfg = vcs.parseVcsConfig(['backend: gitlab', 'token_ref: gitlab-pr'].join('\n'));
  assert.equal(cfg.merge_token_ref, null);
  assert.equal(cfg.token_ref, 'gitlab-pr');
});

test('parseVcsConfig tolerates comments, quotes and blank lines', () => {
  const cfg = vcs.parseVcsConfig([
    '# shared config',
    '',
    "backend: 'gitea'",
    'host: "https://gitea.example.com"  # trailing comment',
    'merge_token_ref: "human-pat"',
  ].join('\n'));
  assert.equal(cfg.backend, 'gitea');
  assert.equal(cfg.host, 'https://gitea.example.com');
  assert.equal(cfg.merge_token_ref, 'human-pat');
});
