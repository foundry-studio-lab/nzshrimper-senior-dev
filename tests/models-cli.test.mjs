import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readSkillsConfig, writeSkillsConfig } from '../scripts/lib/state.mjs';

const CLI = new URL('../scripts/state-cli.mjs', import.meta.url).pathname;
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-models-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}
function cli(repo, args) {
  try { return { status: 0, out: execFileSync('node', [CLI, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, SENIOR_DEV_OFFLINE: '1' } }) }; }
  catch (e) { return { status: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}

test('models --lane prints defaults with via for a fresh repo', () => {
  const repo = makeRepo();
  const r = cli(repo, ['skills-config', 'models', '--lane', 'feature']);
  assert.equal(r.status, 0);
  assert.ok(r.out.includes('# resolved models - lane: feature'));
  assert.ok(r.out.includes('review: claude=sonnet (default) codex=medium (default)'));
  assert.ok(r.out.includes('finish: claude=opus (default) codex=high (default)'));
  assert.ok(r.out.includes('adjudicate: claude=fable (default)'));
  assert.ok(r.out.includes('plan: (controller inline)'));
  assert.ok(!r.out.includes('debug:'));                 // not in the feature chain
});

test('models without --lane uses the active session lane, else the steps view', () => {
  const repo = makeRepo();
  assert.ok(cli(repo, ['skills-config', 'models']).out.includes('steps view'));
  cli(repo, ['init', '--task', 't', '--type', 'bug-fix']);
  const r = cli(repo, ['skills-config', 'models']);
  assert.ok(r.out.includes('lane: bug-fix'));
  assert.ok(r.out.includes('debug: claude=opus (default)'));
});

test('set-models writes steps, merges per field, bumps to v3, preserves other fields', () => {
  const repo = makeRepo();
  writeSkillsConfig(repo, { version: 2, source: 'combo', shared: false, guard: 'declined', steps: { plan: 'x:y' } });
  let r = cli(repo, ['skills-config', 'set-models', '--steps', 'implement=opus,review=/high,finish=fable/xhigh']);
  assert.equal(r.status, 0, r.out);
  let c = readSkillsConfig(repo);
  assert.equal(c.version, 3);
  assert.equal(c.source, 'combo');
  assert.equal(c.guard, 'declined');
  assert.equal(c.steps.plan, 'x:y');
  assert.deepEqual(c.models.steps, { implement: { claude: 'opus' }, review: { codex: 'high' }, finish: { claude: 'fable', codex: 'xhigh' } });
  r = cli(repo, ['skills-config', 'set-models', '--steps', 'review=haiku']);
  assert.equal(r.status, 0, r.out);
  c = readSkillsConfig(repo);
  assert.deepEqual(c.models.steps.review, { claude: 'haiku', codex: 'high' });   // per-field merge
  assert.ok(cli(repo, ['skills-config', 'models', '--lane', 'quick-fix']).out.includes('review: claude=haiku (steps) codex=high (steps)'));
});

test('set-models --lane writes the lane map and only lane phases are allowed', () => {
  const repo = makeRepo();
  let r = cli(repo, ['skills-config', 'set-models', '--lane', 'feature', '--steps', 'finish=/xhigh,adjudicate=opus']);
  assert.equal(r.status, 0, r.out);
  const c = readSkillsConfig(repo);
  assert.equal(c.version, 3);
  assert.deepEqual(c.models.lanes.feature, { finish: { codex: 'xhigh' }, adjudicate: { claude: 'opus' } });
  assert.ok(cli(repo, ['skills-config', 'models', '--lane', 'feature']).out.includes('finish: claude=opus (default) codex=xhigh (lane)'));
  assert.equal(cli(repo, ['skills-config', 'set-models', '--lane', 'feature', '--steps', 'debug=opus']).status, 1);
});

test('set-models rejects bad lanes, phases, tiers, efforts and empty entries', () => {
  const repo = makeRepo();
  for (const args of [
    ['--lane', 'nonsense', '--steps', 'implement=opus'],
    ['--steps', 'notaphase=opus'],
    ['--steps', 'implement=gpt'],
    ['--steps', 'review=/max'],
    ['--steps', 'implement='],
    ['--steps', 'implement'],
    ['--steps'],
  ]) {
    const r = cli(repo, ['skills-config', 'set-models', ...args]);
    assert.equal(r.status, 1, args.join(' '));
  }
  assert.equal(readSkillsConfig(repo), null);   // nothing written
});
