import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readState, readSkillsConfig } from '../scripts/lib/state.mjs';

const CLI = new URL('../scripts/state-cli.mjs', import.meta.url).pathname;

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-scli-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}
function cli(repo, args) {
  try {
    const out = execFileSync('node', [CLI, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, SENIOR_DEV_OFFLINE: '1' } });
    return { status: 0, out };
  } catch (e) {
    return { status: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

test('skills-config set writes source + steps and excludes skills.json by default', () => {
  const repo = makeRepo();
  const r = cli(repo, ['skills-config', 'set', '--source', 'combo', '--steps', 'plan=my-org:planner,review=my-org:reviewer']);
  assert.equal(r.status, 0);
  const cfg = readSkillsConfig(repo);
  assert.equal(cfg.source, 'combo');
  assert.deepEqual(cfg.steps, { plan: 'my-org:planner', review: 'my-org:reviewer' });
  assert.equal(cfg.shared, false);
  assert.ok(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8').includes('.senior-dev/skills.json'));
});

test('skills-config set rejects an invalid source', () => {
  const repo = makeRepo();
  assert.equal(cli(repo, ['skills-config', 'set', '--source', 'bogus']).status, 1);
});

test('skills-config show prints none then the config', () => {
  const repo = makeRepo();
  assert.ok(cli(repo, ['skills-config', 'show']).out.includes('none'));
  cli(repo, ['skills-config', 'set', '--source', 'own']);
  assert.ok(cli(repo, ['skills-config', 'show']).out.includes('own'));
});

test('skills-config share flips the flag and untracks the exclusion', () => {
  const repo = makeRepo();
  cli(repo, ['skills-config', 'set', '--source', 'own']);
  const r = cli(repo, ['skills-config', 'share']);
  assert.equal(r.status, 0);
  assert.equal(readSkillsConfig(repo).shared, true);
  assert.ok(!readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8').split('\n').includes('.senior-dev/skills.json'));
  assert.ok(r.out.includes('git add'));
  cli(repo, ['skills-config', 'unshare']);
  assert.equal(readSkillsConfig(repo).shared, false);
});

test('skill-source records the run choice into state, needs a session', () => {
  const repo = makeRepo();
  assert.equal(cli(repo, ['skill-source', '--source', 'superpowers']).status, 1); // no session
  cli(repo, ['init', '--task', 't', '--type', 'quick-fix']);
  const r = cli(repo, ['skill-source', '--source', 'combo', '--map', '{"plan":"my-org:planner"}']);
  assert.equal(r.status, 0);
  const s = readState(repo);
  assert.equal(s.skillSource.source, 'combo');
  assert.deepEqual(s.skillSource.map, { plan: 'my-org:planner' });
});

test('skill-source rejects invalid source and invalid JSON map', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 't', '--type', 'quick-fix']);
  assert.equal(cli(repo, ['skill-source', '--source', 'nope']).status, 1);
  assert.equal(cli(repo, ['skill-source', '--source', 'own', '--map', '{bad']).status, 1);
});

test('status surfaces the chosen skill source', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 't', '--type', 'quick-fix']);
  cli(repo, ['skill-source', '--source', 'combo']);
  assert.ok(cli(repo, ['status']).out.includes('skill source: combo'));
});
