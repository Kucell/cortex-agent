const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

for (const locale of ['zh', 'en']) {
  test(`${locale} approve workflow persists explicit natural-language choices`, () => {
    const workflow = read(`templates/${locale}/.agent/workflows/approve.md`);
    for (const marker of [
      'interactive-user',
      'rationale',
      'resolved-by',
      'owning workflow',
      'resource',
    ]) {
      assert.ok(workflow.includes(marker), `${locale} approve workflow is missing ${marker}`);
    }
    assert.match(workflow, /Natural-Language Entry|自然语言入口/);
    assert.match(workflow, /multiple candidates|多个候选/);
    assert.match(workflow, /ambiguous|含糊/);
    assert.match(workflow, /silence|沉默/);
  });

  test(`${locale} approval resumes only through the owning workflow`, () => {
    const workflow = read(`templates/${locale}/.agent/workflows/approve.md`);
    assert.match(workflow, /recomputes the resource|重新计算 resource/);
    assert.match(workflow, /releases its own Waitpoint|自行释放 Waitpoint/);
    assert.match(workflow, /new architecture|新的 architecture/);
    assert.match(workflow, /external.side.effect|external-side-effect/);
  });
}
