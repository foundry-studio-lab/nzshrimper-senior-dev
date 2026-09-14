import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readState, writeSkillsConfig } from '../scripts/lib/state.mjs';

const CLI = new URL('../scripts/state-cli.mjs', import.meta.url).pathname;
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-overrule-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}
function cli(repo, args) {
  try { return { status: 0, out: execFileSync('node', [CLI, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, SENIOR_DEV_OFFLINE: '1' } }) }; }
  catch (e) { return { status: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}
const review = (repo, reviewer, verdict, cycle = 1, phase = 'implement') =>
  cli(repo, ['review', '--phase', phase, '--reviewer', reviewer, '--verdict', verdict, '--cycle', String(cycle)]);
const OVER = ['review', '--phase', 'implement', '--reviewer', 'codex', '--cycle', '1', '--overrule', '--reason', 'concern targets a file outside the diff'];

test('overrule records an adjudication, clears the gate, defaults --by to the adjudicate tier', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 't', '--type', 'quick-fix']);
  review(repo, 'codex', 'NEEDS_REVISION');
  review(repo, 'claude', 'APPROVED');
  assert.ok(cli(repo, ['status']).out.includes('review:implement=NEEDS_REVISION'));
  const r = cli(repo, OVER);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.out.trim(), 'adjudication recorded: implement cycle 1 codex overruled (by fable)');
  const a = readState(repo).adjudications;
  assert.equal(a.length, 1);
  assert.deepEqual({ ...a[0], at: undefined }, { phase: 'implement', cycle: 1, reviewer: 'codex', decision: 'overruled', by: 'fable', reason: 'concern targets a file outside the diff', at: undefined });
  assert.ok(a[0].at);
  const s = cli(repo, ['status']).out;
  assert.ok(!s.includes('review:implement=NEEDS_REVISION'), s);
  assert.ok(s.includes('adjudications: 1 overruled, 0 upheld'), s);
});

test('--by is validated and honours a configured adjudicate tier', () => {
  const repo = makeRepo();
  writeSkillsConfig(repo, { version: 3, source: 'superpowers', shared: false, models: { steps: { adjudicate: { claude: 'opus' } } } });
  cli(repo, ['init', '--task', 't', '--type', 'quick-fix']);
  review(repo, 'codex', 'NEEDS_REVISION');
  review(repo, 'claude', 'APPROVED');
  assert.ok(cli(repo, OVER).out.includes('(by opus)'));
  cli(repo, ['review', '--phase', 'implement', '--reviewer', 'codex', '--verdict', 'NEEDS_REVISION', '--cycle', '2']);
  assert.equal(cli(repo, [...OVER.slice(0, 6), '2', '--overrule', '--reason', 'x', '--by', 'gpt']).status, 1);
});

test('overrule preconditions: latest rejection at that cycle, other reviewer approved, a reason', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 't', '--type', 'quick-fix']);
  assert.equal(cli(repo, OVER).status, 1);                       // no reviews at all
  review(repo, 'codex', 'NEEDS_REVISION');
  assert.equal(cli(repo, OVER).status, 1);                       // claude has no verdict
  review(repo, 'claude', 'NEEDS_REVISION');
  assert.equal(cli(repo, OVER).status, 1);                       // both rejected: nothing to adjudicate
  review(repo, 'claude', 'APPROVED', 2);
  assert.equal(cli(repo, [...OVER.slice(0, -2)]).status, 1);     // missing --reason
  assert.equal(cli(repo, [...OVER, '--uphold']).status, 1);      // not both
  review(repo, 'codex', 'NEEDS_REVISION', 2);
  assert.equal(cli(repo, OVER).status, 1);                       // cycle 1 is no longer codex's latest
  assert.equal(cli(repo, [...OVER.slice(0, 6), '2', '--overrule', '--reason', 'ok']).status, 0);
  assert.equal(readState(repo).adjudications.length, 1);
});

test('uphold needs only the latest rejection and never clears the gate', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 't', '--type', 'quick-fix']);
  review(repo, 'codex', 'NEEDS_REVISION');
  const r = cli(repo, ['review', '--phase', 'implement', '--reviewer', 'codex', '--cycle', '1', '--uphold', '--reason', 'valid: missing null guard']);
  assert.equal(r.status, 0, r.out);
  assert.equal(readState(repo).adjudications[0].decision, 'upheld');
  const s = cli(repo, ['status']).out;
  assert.ok(s.includes('review:implement=NEEDS_REVISION'));
  assert.ok(s.includes('adjudications: 0 overruled, 1 upheld'));
});

test('a second verdict at an already-recorded cycle is refused, so a rejection cannot be re-recorded away', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 't', '--type', 'quick-fix']);
  review(repo, 'codex', 'NEEDS_REVISION');
  const r = review(repo, 'codex', 'APPROVED');            // same cycle 1
  assert.equal(r.status, 1);
  assert.ok(r.out.includes('already recorded'));
  assert.equal(readState(repo).reviews.length, 1);
  assert.equal(review(repo, 'codex', 'APPROVED', 2).status, 0);   // next cycle is the way
  // an overruled cycle cannot receive a fresh rejection that would inherit the overrule
  review(repo, 'claude', 'NEEDS_REVISION', 3);
  review(repo, 'codex', 'APPROVED', 3);
  assert.equal(cli(repo, ['review', '--phase', 'implement', '--reviewer', 'claude', '--cycle', '3', '--overrule', '--reason', 'outside the diff']).status, 0);
  assert.equal(review(repo, 'claude', 'NEEDS_REVISION', 3).status, 1);
});

test('--overrule and --uphold refuse a --verdict, so a verdict is never dropped silently', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 't', '--type', 'quick-fix']);
  review(repo, 'codex', 'NEEDS_REVISION');
  review(repo, 'claude', 'APPROVED');
  for (const flag of ['--overrule', '--uphold']) {
    const r = cli(repo, ['review', '--phase', 'implement', '--reviewer', 'codex', '--cycle', '1', flag, '--verdict', 'APPROVED', '--reason', 'r']);
    assert.equal(r.status, 1, r.out);
    assert.ok(r.out.includes('--verdict'), r.out);
  }
  assert.deepEqual(readState(repo).adjudications, []);
  assert.equal(readState(repo).reviews.length, 2);
});
