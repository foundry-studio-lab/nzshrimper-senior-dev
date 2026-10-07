import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('codex manifest carries the spec fields', () => {
  const m = JSON.parse(read('.codex-plugin/plugin.json'));
  assert.equal(m.name, 'senior-dev');
  assert.equal(m.skills, './skills/');
  assert.equal(m.hooks, './hooks/hooks.json');
  assert.equal(m.license, 'MIT');
  assert.equal(m.interface.displayName, 'senior-dev');
  assert.equal(m.interface.category, 'Developer Tools');
  assert.equal(m.interface.developerName, 'Foundry Studio');
  assert.equal(m.interface.privacyPolicyURL, 'https://github.com/foundry-studio-lab/nzshrimper-senior-dev/blob/main/PRIVACY.md');
  assert.deepEqual(m.interface.defaultPrompt, ['Start a senior-dev session for this task', 'Show the senior-dev session status', 'Finish and close this senior-dev session']);
  assert.ok(m.interface.defaultPrompt.every((p) => p.length < 128));
});

test('all three manifests agree on 0.5.0', () => {
  const c = JSON.parse(read('.claude-plugin/plugin.json'));
  const k = JSON.parse(read('.claude-plugin/marketplace.json'));
  const x = JSON.parse(read('.codex-plugin/plugin.json'));
  assert.deepEqual([c.version, k.metadata.version, k.plugins[0].version, x.version], ['0.5.0', '0.5.0', '0.5.0', '0.5.0']);
});
