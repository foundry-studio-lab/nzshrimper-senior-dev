import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  integrationBlockers, writeState, CHAINS, DOCS_GATE, writeSkillsConfig, readSkillsConfig, headTree,
} from '../scripts/lib/state.mjs';

const CLI = new URL('../scripts/state-cli.mjs', import.meta.url).pathname;
const GATE = new URL('../scripts/commit-gate.mjs', import.meta.url).pathname;
const TESTS = { full: 'npm test' };
const T = 'tree-now';

// A session whose non-test gates are all clear.
function clearState(overrides = {}) {
  return {
    version: 1, task: 't', type: 'quick-fix', startedAt: 'x',
    chain: CHAINS['quick-fix'], phases: { implement: { status: 'done' }, verify: { status: 'done' } },
    reviews: [{ phase: 'implement', reviewer: 'codex', verdict: 'APPROVED', cycle: 1 }],
    docsGate: { handover: true, affectedDocs: true }, degradations: [], bypasses: [],
    scratchFiles: [], waits: [], stopGate: { lastSnapshotHash: null }, ...overrides,
  };
}
const full = (id, o = {}) => ({ id, kind: 'full', exit: 0, failures: [], tree: T, sinceFull: null, ...o });
const aff = (id, o = {}) => ({ id, kind: 'affected', exit: 0, failures: [], tree: T, sinceFull: 1, ...o });
const pre = (id, t, proven = true) => ({ id, kind: 'preexisting', test: t, proven, exit: 1, tree: T, sinceFull: 1 });
const ctx = { tree: T, tests: TESTS };
const SHIP = { reason: 'known flaky', at: 'x', fullRun: 1 };

test('no tests config or tests.none: blockers identical to 0.3.1', () => {
  const s = clearState({ reviews: [], docsGate: { handover: false } });
  const base = integrationBlockers(s);
  assert.ok(base.length >= 2);
  assert.deepEqual(integrationBlockers(s, {}), base);
  assert.deepEqual(integrationBlockers(s, { tree: T }), base);
  assert.deepEqual(integrationBlockers(s, { tree: T, tests: { none: true } }), base);
  assert.deepEqual(integrationBlockers(s, { tree: T, tests: 'x' }), base);
});

test('no full run recorded', () => {
  assert.deepEqual(integrationBlockers(clearState({ testRuns: [aff(1)] }), ctx),
    ['no full test run recorded (state-cli test --full)']);
  assert.deepEqual(integrationBlockers(clearState(), ctx),
    ['no full test run recorded (state-cli test --full)']);
});

test('failing full run with unproven failures', () => {
  const s = clearState({ testRuns: [full(1, { exit: 1, failures: ['a > x', 'a > y'] }), pre(2, 'a > x'), pre(3, 'a > y', false)] });
  assert.deepEqual(integrationBlockers(s, ctx),
    ['full test run #1 has 1 failing test(s) not proven pre-existing: a > y']);
});

test('failing full run with unknown failures (null or empty list)', () => {
  for (const failures of [null, []]) {
    const s = clearState({ testRuns: [full(1, { exit: 1, failures })], ship: SHIP });
    assert.deepEqual(integrationBlockers(s, ctx),
      ['full test run #1 failed and its failures are unknown (no JUnit report)']);
  }
});

test('all failures proven but ship not armed', () => {
  const s = clearState({ testRuns: [full(1, { exit: 1, failures: ['a > x'] }), pre(2, 'a > x')] });
  assert.deepEqual(integrationBlockers(s, ctx),
    ['full test run #1 failures are all pre-existing; waiving them needs /senior-dev:ship']);
});

test('all failures proven + ship armed: no test blocker', () => {
  const s = clearState({ testRuns: [full(1, { exit: 1, failures: ['a > x'] }), pre(2, 'a > x')], ship: { ...SHIP, fullRun: 99 } });
  assert.deepEqual(integrationBlockers(s, ctx), []);
});

test('green full at the current tree: no test blocker', () => {
  assert.deepEqual(integrationBlockers(clearState({ testRuns: [full(1)] }), ctx), []);
});

test('tree not covered', () => {
  const s = clearState({ testRuns: [full(1, { tree: 'old' })] });
  assert.deepEqual(integrationBlockers(s, ctx),
    ['current tree is not covered by a green test run since full run #1 (state-cli test --affected)']);
  // null tree (no commits / git error) is never covered
  assert.deepEqual(integrationBlockers(clearState({ testRuns: [full(1)] }), { tree: null, tests: TESTS }),
    ['current tree is not covered by a green test run since full run #1 (state-cli test --affected)']);
});

test('green affected since the latest full covers; since an older full, red, or other tree does not', () => {
  const ok = clearState({ testRuns: [full(1, { tree: 'old' }), aff(2)] });
  assert.deepEqual(integrationBlockers(ok, ctx), []);
  const blocked = 'current tree is not covered by a green test run since full run #3 (state-cli test --affected)';
  const older = clearState({ testRuns: [full(1, { tree: 'old' }), aff(2), full(3, { tree: 'old2' })] });
  assert.deepEqual(integrationBlockers(older, ctx), [blocked]);
  const red = clearState({ testRuns: [full(3, { tree: 'old' }), aff(4, { sinceFull: 3, exit: 1 })] });
  assert.deepEqual(integrationBlockers(red, ctx), [blocked]);
  const other = clearState({ testRuns: [full(3, { tree: 'old' }), aff(4, { sinceFull: 3, tree: 'x' })] });
  assert.deepEqual(integrationBlockers(other, ctx), [blocked]);
  const oneKind = clearState({ testRuns: [full(3, { tree: 'old' }), { ...aff(4, { sinceFull: 3 }), kind: 'one' }] });
  assert.deepEqual(integrationBlockers(oneKind, ctx), [blocked]);
});

test('shipped full run still needs coverage of later changes', () => {
  const s = clearState({ testRuns: [full(1, { exit: 1, failures: ['a > x'], tree: 'old' }), pre(2, 'a > x')], ship: SHIP });
  assert.deepEqual(integrationBlockers(s, ctx),
    ['current tree is not covered by a green test run since full run #1 (state-cli test --affected)']);
  s.testRuns.push(aff(3));
  assert.deepEqual(integrationBlockers(s, ctx), []);
});

// ---- hook tests ----
function makeRepo(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}
function gate(repo, command) {
  const r = spawnSync('node', [GATE], { encoding: 'utf8', input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: repo }) });
  return { status: r.status, out: r.stderr || '' };
}

test('commit-gate blocks a push with no full run, allows after a green full at HEAD^{tree}', () => {
  const repo = makeRepo('sd-itg-cg-');
  writeSkillsConfig(repo, { version: 4, source: 'superpowers', shared: false, tests: TESTS });
  writeState(repo, clearState());
  const r = gate(repo, 'git push');
  assert.equal(r.status, 2);
  assert.ok(r.out.includes('no full test run recorded (state-cli test --full)'));
  writeState(repo, clearState({ testRuns: [full(1, { tree: headTree(repo) })] }));
  assert.equal(gate(repo, 'git push').status, 0);
});

test('guard pre-push applies the same rule', () => {
  const repo = makeRepo('sd-itg-gd-');
  execFileSync('node', [CLI, 'guard', 'install'], { cwd: repo, env: { ...process.env, SENIOR_DEV_OFFLINE: '1' } });
  writeSkillsConfig(repo, { ...readSkillsConfig(repo), version: 4, tests: TESTS });
  writeState(repo, clearState());
  const run = () => spawnSync('node', [join(repo, '.senior-dev', 'guard', 'guard.mjs'), 'pre-push'], { cwd: repo, encoding: 'utf8' });
  const r = run();
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('no full test run recorded (state-cli test --full)'));
  writeState(repo, clearState({ testRuns: [full(1, { tree: headTree(repo) })] }));
  assert.equal(run().status, 0);
});
