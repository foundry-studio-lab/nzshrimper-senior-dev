import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readState } from '../scripts/lib/state.mjs';

const CLI = new URL('../scripts/state-cli.mjs', import.meta.url).pathname;
const git = (repo, ...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-nochange-'));
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'a');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}
function cli(repo, args) {
  try { return { status: 0, out: execFileSync('node', [CLI, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, SENIOR_DEV_OFFLINE: '1' } }) }; }
  catch (e) { return { status: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}
const review = (repo, reviewer, verdict, cycle) =>
  cli(repo, ['review', '--phase', 'implement', '--reviewer', reviewer, '--verdict', verdict, '--cycle', String(cycle)]);
const fresh = () => { const r = makeRepo(); cli(r, ['init', '--task', 'nothing', '--type', 'quick-fix']); return r; };
const NC = ['finish', '--no-change', 'investigated, nothing to change'];

test('cycle 4 is accepted only as APPROVED; cycle 4 NEEDS_REVISION and cycle 5 are refused', () => {
  const repo = fresh();
  for (const c of [1, 2, 3]) assert.equal(review(repo, 'codex', 'NEEDS_REVISION', c).status, 0);
  const bad = review(repo, 'codex', 'NEEDS_REVISION', 4);
  assert.equal(bad.status, 1);
  assert.ok(bad.out.includes('cycle cap is 3 - stop iterating and escalate to the operator'), bad.out);
  assert.equal(review(repo, 'codex', 'APPROVED', 5).status, 1);
  assert.equal(review(repo, 'codex', 'APPROVED', 4).status, 0);
  review(repo, 'claude', 'APPROVED', 1);
  assert.ok(!cli(repo, ['status']).out.includes('review:implement='), 'gate cleared');
});

test('no-change closes an untouched session with open gate items, no bypass', () => {
  const repo = fresh();
  const r = cli(repo, NC);
  assert.equal(r.status, 0, r.out);
  assert.ok(r.out.startsWith('session closed (no change) and archived: '), r.out);
  const dir = join(repo, '.senior-dev', 'history');
  const arch = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8'));
  assert.equal(arch.outcome, 'no-change');
  assert.equal(arch.noChangeReason, 'investigated, nothing to change');
  assert.deepEqual(arch.bypasses || [], []);
  assert.ok(arch.closedAt);
});

test('a new branch at baseHead with no commits is accepted', () => {
  const repo = fresh();
  git(repo, 'branch', 'spare');
  assert.equal(cli(repo, NC).status, 0);
});

const refuse = (repo, needle) => {
  const r = cli(repo, NC);
  assert.equal(r.status, 1, r.out);
  assert.ok(r.out.includes('senior-dev: '), r.out);
  assert.ok(r.out.includes(needle), `${needle} not in ${r.out}`);
  assert.ok(readState(repo), 'session stays open');
};

test('no-change refused when HEAD moved', () => {
  const repo = fresh();
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'more');
  refuse(repo, 'HEAD moved: ');
});

test('no-change refused when another branch moved', () => {
  const repo = makeRepo();
  git(repo, 'branch', 'other');
  cli(repo, ['init', '--task', 'nothing', '--type', 'quick-fix']);
  git(repo, 'checkout', '-q', 'other');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'x');
  git(repo, 'checkout', '-q', 'main');
  refuse(repo, 'branch other changed');
});

test('no-change refused for a new branch with a commit', () => {
  const repo = fresh();
  git(repo, 'checkout', '-q', '-b', 'feat');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'x');
  git(repo, 'checkout', '-q', 'main');
  refuse(repo, 'branch feat changed');
});

test('no-change refused for a dirty working tree', () => {
  const repo = fresh();
  writeFileSync(join(repo, 'a.txt'), 'changed');
  refuse(repo, 'working tree not clean');
});

test('no-change refused with an extra worktree', () => {
  const repo = fresh();
  const wt = join(mkdtempSync(join(tmpdir(), 'sd-wt-')), 'wt');
  git(repo, 'worktree', 'add', '-q', '--detach', wt);
  refuse(repo, 'extra worktree: ');
});

test('no-change refused on a pre-0.4 session (no baseHead)', () => {
  const repo = fresh();
  const p = join(repo, '.senior-dev', 'state.json');
  const s = JSON.parse(readFileSync(p, 'utf8'));
  delete s.baseHead;
  writeFileSync(p, JSON.stringify(s));
  refuse(repo, 'use finish or finish --force-open');
});

test('no-change combined with --force-open is refused', () => {
  const repo = fresh();
  const r = cli(repo, [...NC, '--force-open', 'x']);
  assert.equal(r.status, 1);
  assert.ok(r.out.includes('senior-dev: '), r.out);
});

test('skills-config resolve --lane constructor is a clean refusal, not a crash', () => {
  const repo = makeRepo();
  for (const lane of ['constructor', '__proto__']) {
    const r = cli(repo, ['skills-config', 'resolve', '--lane', lane]);
    assert.equal(r.status, 1, r.out);
    assert.ok(r.out.includes('senior-dev: '), r.out);
    assert.ok(!/TypeError|\n\s+at /.test(r.out), r.out);
  }
});
