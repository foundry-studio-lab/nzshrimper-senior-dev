import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readState, writeSkillsConfig } from '../scripts/lib/state.mjs';

const CLI = new URL('../scripts/state-cli.mjs', import.meta.url).pathname;
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-dispatch-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}
function cli(repo, args) {
  try { return { status: 0, out: execFileSync('node', [CLI, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, SENIOR_DEV_OFFLINE: '1' } }) }; }
  catch (e) { return { status: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}

test('init creates empty dispatches and adjudications arrays', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 't', '--type', 'feature']);
  const s = readState(repo);
  assert.deepEqual(s.dispatches, []);
  assert.deepEqual(s.adjudications, []);
});

test('models --phase needs a session and prints the resolved pair', () => {
  const repo = makeRepo();
  assert.equal(cli(repo, ['models', '--phase', 'review']).status, 1);
  cli(repo, ['init', '--task', 't', '--type', 'quick-fix']);
  assert.equal(cli(repo, ['models', '--phase', 'review']).out.trim(), 'claude=sonnet codex=medium');
  assert.equal(cli(repo, ['models', '--phase', 'plan']).out.trim(), 'claude=none codex=none');
  assert.equal(cli(repo, ['models', '--phase', 'adjudicate']).out.trim(), 'claude=fable codex=none');
  assert.deepEqual(JSON.parse(cli(repo, ['models', '--phase', 'review', '--json']).out).via, { claude: 'default', codex: 'default' });
  assert.equal(cli(repo, ['models', '--phase', 'nope']).status, 1);
  assert.equal(cli(repo, ['models']).status, 1);
});

test('dispatch records the floor, requires a reason to raise, refuses to lower', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 't', '--type', 'feature']);
  let r = cli(repo, ['dispatch', '--phase', 'implement']);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.out.trim(), 'claude=sonnet codex=none');
  r = cli(repo, ['dispatch', '--phase', 'implement', '--claude', 'opus']);
  assert.equal(r.status, 1);
  assert.ok(r.out.includes('--reason'));
  r = cli(repo, ['dispatch', '--phase', 'implement', '--claude', 'opus', '--reason', 'multi-file integration']);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.out.trim(), 'claude=opus codex=none (raised from sonnet: multi-file integration)');
  r = cli(repo, ['dispatch', '--phase', 'implement', '--claude', 'haiku', '--reason', 'cheap']);
  assert.equal(r.status, 1);
  assert.ok(r.out.includes('never lowers'));
  r = cli(repo, ['dispatch', '--phase', 'implement', '--claude', 'sonnet']);   // at the floor: no reason needed
  assert.equal(r.status, 0, r.out);
  assert.equal(cli(repo, ['dispatch', '--phase', 'plan']).status, 1);        // inline phase: nothing to dispatch
  assert.equal(cli(repo, ['dispatch', '--phase', 'implement', '--claude', 'gpt', '--reason', 'x']).status, 1);
  const d = readState(repo).dispatches;
  assert.equal(d.length, 3);
  assert.deepEqual(d.map((x) => x.claude), ['sonnet', 'opus', 'sonnet']);
  assert.equal(d[1].floor, 'sonnet');
  assert.equal(d[1].reason, 'multi-file integration');
  assert.equal(d[0].reason, null);
  assert.ok(d[0].at);
});

test('dispatch honours a configured floor and status reports models used', () => {
  const repo = makeRepo();
  writeSkillsConfig(repo, { version: 3, source: 'superpowers', shared: false, models: { steps: { implement: { claude: 'opus' } } } });
  cli(repo, ['init', '--task', 't', '--type', 'feature']);
  assert.equal(cli(repo, ['dispatch', '--phase', 'implement', '--claude', 'sonnet']).status, 1);
  cli(repo, ['dispatch', '--phase', 'implement']);
  cli(repo, ['dispatch', '--phase', 'review']);
  cli(repo, ['dispatch', '--phase', 'review', '--claude', 'fable', '--reason', 'subtle concurrency diff']);
  const s = cli(repo, ['status']).out;
  assert.ok(s.includes('models used: opus×1, sonnet×1, fable×1 (raised: review "subtle concurrency diff")'), s);
});
