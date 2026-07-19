const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('github-repo-research skill is complete in both templates', () => {
  const skillPaths = [
    'templates/zh/.agent/skills/github-repo-research/SKILL.md',
    'templates/en/.agent/skills/github-repo-research/SKILL.md',
  ];

  for (const skillPath of skillPaths) {
    const content = read(skillPath);
    assert.match(content, /^---\nname: github-repo-research\ndescription: .+\n---\n/);
    assert.doesNotMatch(content, /TODO/);
    assert.match(content, /DeepWiki/);
    assert.match(content, /commit/i);
  }
});

test('research and architecture workflows invoke github-repo-research', () => {
  const integrationPaths = [
    'templates/zh/.agent/sub-agents/researcher.md',
    'templates/en/.agent/sub-agents/researcher.md',
    'templates/zh/.agent/workflows/arch-design.md',
    'templates/en/.agent/workflows/arch-design.md',
  ];

  for (const integrationPath of integrationPaths) {
    assert.match(read(integrationPath), /github-repo-research/);
  }
});

test('grok-build research records DeepWiki revision and adoption decisions', () => {
  const research = read('docs/architecture/grok-build-research.md');
  assert.match(research, /c1b5909e/);
  assert.match(research, /采纳/);
  assert.match(research, /改造后采纳/);
  assert.match(research, /不采纳/);
  assert.match(research, /DeepWiki 只做导航层|DeepWiki 链接用于导航/);
});
