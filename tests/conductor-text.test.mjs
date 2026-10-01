import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const skill = read('skills/conductor/SKILL.md');
const prompt = read('skills/conductor/references/codex-review-prompt.md');

test('conductor names the v0.4 CLI surface', () => {
  for (const s of ['state-cli test --affected', 'state-cli test --full', 'test --preexisting', 'CONTRADICTION',
    '/senior-dev:ship', 'state-cli reclassify', 'finish --no-change', 'set-tests --none',
    'superpowers:verification-before-completion', 'superpowers:requesting-code-review', 'push / PR creation']) {
    assert.ok(skill.includes(s), `SKILL.md missing: ${s}`);
  }
});

test('conductor drops the fictional and old wording', () => {
  assert.ok(!skill.includes('built-in `verify`'));
  assert.ok(!skill.includes('finish --force-open "escalating'));
});

test('conductor description stays within the 1024 cap and names no fictional skill', () => {
  const m = skill.match(/^description: (.*)$/m);
  assert.ok(m && m[1].length <= 1024, `description length ${m && m[1].length}`);
  assert.ok(!m[1].includes('built-in code-review and verify'));
});

test('codex prompt has the spec axis and placeholder', () => {
  assert.ok(prompt.includes('<SPEC>'));
  assert.ok(prompt.includes('compare the diff to it and report missing requirements, scope beyond it, and behaviour that contradicts it as concerns'));
});

test('fix round 1: manifest wording, degrade flags, test question scope', () => {
  assert.ok(!read('.claude-plugin/plugin.json').includes('built-in reviews'));
  assert.ok(!read('.claude-plugin/marketplace.json').includes('built-in reviews'));
  assert.match(skill, /Skill check[\s\S]*?--wanted[\s\S]*?7\. \*\*Test commands/);
  assert.match(skill, /7\. \*\*Test commands[^]*?never for `docs-only` or `investigation`/);
});

test('M3: gates section says a green test run satisfies the commit gate and integration includes the test rules', () => {
  const gates = skill.slice(skill.indexOf('## Gates and bypass'), skill.indexOf('## 2. The chains')).replace(/\s+/g, ' ');
  assert.match(gates, /green `state-cli test` run/);
  assert.match(gates, /`tests-green` only for repos without a tests config/);
  assert.match(gates, /one full run[^.]*coverage on push\/PR/);
});

test('manifests are 0.4.1', () => {
  const p = JSON.parse(read('.claude-plugin/plugin.json'));
  const m = JSON.parse(read('.claude-plugin/marketplace.json'));
  assert.equal(p.version, '0.4.1');
  assert.equal(m.metadata.version, '0.4.1');
  assert.equal(m.plugins[0].version, '0.4.1');
});

test('0.4.1: the conductor tells agents a "counts as green" run satisfies the commit gate', () => {
  assert.match(read('skills/conductor/SKILL.md'), /prints `counts as green`/);
});
