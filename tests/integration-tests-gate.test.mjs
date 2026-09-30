import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  integrationBlockers, writeState, CHAINS, DOCS_GATE, writeSkillsConfig, readSkillsConfig, headTree,
} from '../scripts/lib/state.mjs';
import { classifyCommand, integrationTargets } from '../scripts/commit-gate.mjs';

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
const ctx = { trees: [T], tests: TESTS };
const SHIP = { reason: 'known flaky', at: 'x', fullRun: 1 };

test('no tests config or tests.none: blockers identical to 0.3.1', () => {
  const s = clearState({ reviews: [], docsGate: { handover: false } });
  const base = integrationBlockers(s);
  assert.ok(base.length >= 2);
  assert.deepEqual(integrationBlockers(s, {}), base);
  assert.deepEqual(integrationBlockers(s, { trees: [T] }), base);
  assert.deepEqual(integrationBlockers(s, { trees: [T], tests: { none: true } }), base);
  assert.deepEqual(integrationBlockers(s, { trees: [T], tests: 'x' }), base);
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
  assert.deepEqual(integrationBlockers(clearState({ testRuns: [full(1)] }), { trees: [null], tests: TESTS }),
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

test('trees undefined skips coverage; every tree in the list must be covered; empty list is not covered', () => {
  const s = clearState({ testRuns: [full(1, { tree: 'old' }), aff(2, { tree: 'T2' })] });
  const blocked = ['current tree is not covered by a green test run since full run #1 (state-cli test --affected)'];
  assert.deepEqual(integrationBlockers(s, { tests: TESTS }), []);
  assert.deepEqual(integrationBlockers(s, { tests: TESTS, trees: [] }), blocked);
  assert.deepEqual(integrationBlockers(s, { tests: TESTS, trees: ['old', 'T2'] }), []);
  assert.deepEqual(integrationBlockers(s, { tests: TESTS, trees: ['old', 'T3'] }), blocked);
  // rules 1-2 still apply without trees
  assert.deepEqual(integrationBlockers(clearState(), { tests: TESTS }), ['no full test run recorded (state-cli test --full)']);
});

test('shipped full run still needs coverage of later changes', () => {
  const s = clearState({ testRuns: [full(1, { exit: 1, failures: ['a > x'], tree: 'old' }), pre(2, 'a > x')], ship: SHIP });
  assert.deepEqual(integrationBlockers(s, ctx),
    ['current tree is not covered by a green test run since full run #1 (state-cli test --affected)']);
  s.testRuns.push(aff(3));
  assert.deepEqual(integrationBlockers(s, ctx), []);
});

test('integrationTargets reports integration kinds and -C dirs; classifyCommand unchanged', () => {
  const cmd = 'git -C a -C b push origin x && git merge y; gh pr create -t z; gh pr merge 1; git -C a -C /abs push';
  assert.deepEqual(classifyCommand(cmd), { commit: false, integration: true });
  assert.deepEqual(integrationTargets(cmd), [
    { kind: 'push', dir: join('a', 'b') }, { kind: 'merge', dir: null },
    { kind: 'pr-create', dir: null }, { kind: 'pr-merge', dir: null }, { kind: 'push', dir: '/abs' },
  ]);
  assert.deepEqual(integrationTargets('git commit -m x'), []);
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

// Main repo with a tests config + guard-less session, plus a linked worktree
// on branch feat carrying one extra commit (so its HEAD^{tree} differs).
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t.com', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }).trim();
function repoWithWorktree(prefix) {
  const main = makeRepo(prefix);
  const wt = mkdtempSync(join(tmpdir(), prefix + 'wt-'));
  git(main, 'worktree', 'add', '-q', wt, '-b', 'feat');
  writeFileSync(join(wt, 'f.js'), '1');
  git(wt, 'add', 'f.js');
  git(wt, 'commit', '-qm', 'feat');
  writeSkillsConfig(main, { version: 4, source: 'superpowers', shared: false, tests: TESTS });
  return { main, wt, mainTree: headTree(main), wtTree: headTree(wt) };
}
function gateAt(cwd, command) {
  const r = spawnSync('node', [GATE], { encoding: 'utf8', input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }) });
  return { status: r.status, out: r.stderr || '' };
}
const NOT_COVERED = 'current tree is not covered by a green test run since full run #1';

test('commit-gate push from a linked worktree checks the worktree tree', () => {
  const { main, wt, mainTree, wtTree } = repoWithWorktree('sd-itg-wt-');
  assert.notEqual(mainTree, wtTree);
  writeState(main, clearState({ testRuns: [full(1, { tree: mainTree })] }));
  const r = gateAt(wt, 'git push origin feat');
  assert.equal(r.status, 2);
  assert.ok(r.out.includes(NOT_COVERED));
  writeState(main, clearState({ testRuns: [full(1, { tree: mainTree }), aff(2, { tree: wtTree })] }));
  assert.equal(gateAt(wt, 'git push origin feat').status, 0);
});

test('git -C <main> push from a worktree cwd checks main\'s tree', () => {
  const { main, wt, mainTree, wtTree } = repoWithWorktree('sd-itg-c-');
  writeState(main, clearState({ testRuns: [full(1, { tree: wtTree })] }));
  assert.equal(gateAt(wt, 'git push origin feat').status, 0);
  const r = gateAt(wt, `git -C ${main} push origin main`);
  assert.equal(r.status, 2);
  assert.ok(r.out.includes(NOT_COVERED));
  // relative -C resolves against the payload cwd
  assert.equal(gateAt(wt, `git -C ../${basename(main)} push`).status, 2);
  writeState(main, clearState({ testRuns: [full(1, { tree: wtTree }), aff(2, { tree: mainTree })] }));
  assert.equal(gateAt(wt, `git -C ${main} push origin main`).status, 0);
});

test('git merge is not blocked by coverage; rules 1-2 still apply', () => {
  const { main } = repoWithWorktree('sd-itg-m-');
  writeState(main, clearState());
  const r = gateAt(main, 'git merge --no-ff feat');
  assert.equal(r.status, 2);
  assert.ok(r.out.includes('no full test run recorded'));
  writeState(main, clearState({ testRuns: [full(1, { tree: 'somewhere-else' })] }));
  assert.equal(gateAt(main, 'git merge --no-ff feat').status, 0);
});

test('pass token records whether a bypass was consumed', () => {
  const repo = makeRepo('sd-itg-tok-');
  execFileSync('node', [CLI, 'guard', 'install'], { cwd: repo, env: { ...process.env, SENIOR_DEV_OFFLINE: '1' } });
  writeState(repo, clearState());
  const tok = () => JSON.parse(readFileSync(join(repo, '.senior-dev', 'guard', 'pass.json'), 'utf8'));
  assert.equal(gate(repo, 'git push').status, 0);
  assert.equal(tok().bypassed, false);
  writeState(repo, clearState({ docsGate: { handover: false }, bypassArmed: { reason: 'r', at: 'x' } }));
  assert.equal(gate(repo, 'git push').status, 0);
  assert.equal(tok().bypassed, true);
});

test('guard pre-push checks the pushed shas, even with a non-bypassed pass token', () => {
  const { main, wt, mainTree, wtTree } = repoWithWorktree('sd-itg-pp-');
  execFileSync('node', [CLI, 'guard', 'install'], { cwd: main, env: { ...process.env, SENIOR_DEV_OFFLINE: '1' } });
  writeSkillsConfig(main, { ...readSkillsConfig(main), version: 4, tests: TESTS });
  writeState(main, clearState({ testRuns: [full(1, { tree: mainTree })] }));
  const featSha = git(wt, 'rev-parse', 'HEAD');
  const Z = '0'.repeat(40);
  const tokenPath = join(main, '.senior-dev', 'guard', 'pass.json');
  const token = (bypassed) => writeFileSync(tokenPath, JSON.stringify({
    type: 'integration', commandHash: 'x', bypassed, expiresAt: new Date(Date.now() + 60000).toISOString() }));
  // Pushing feat from the MAIN checkout: HEAD is covered, the pushed sha is not.
  const push = (input) => spawnSync(join(main, '.git', 'hooks', 'pre-push'), ['origin', 'file:///dev/null'], { cwd: main, encoding: 'utf8', input });
  const line = `refs/heads/feat ${featSha} refs/heads/feat ${Z}\n`;
  token(false);
  const r = push(line);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(NOT_COVERED));
  token(true);
  assert.equal(push(line).status, 0);
  // delete lines are ignored: nothing ships, coverage is not checked
  token(false);
  assert.equal(push(`(delete) ${Z} refs/heads/gone ${featSha}\n`).status, 0);
  // covered sha passes
  writeState(main, clearState({ testRuns: [full(1, { tree: mainTree }), aff(2, { tree: wtTree })] }));
  assert.equal(push(line).status, 0);
});

test('guard pre-push stdin reaches both a chained prior hook and the guard', () => {
  const { main, wt, mainTree } = repoWithWorktree('sd-itg-ch-');
  const hooksDir = join(main, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, 'pre-push'), '#!/bin/sh\ncat > /dev/null\nexit 0\n');
  chmodSync(join(hooksDir, 'pre-push'), 0o755);
  execFileSync('node', [CLI, 'guard', 'install'], { cwd: main, env: { ...process.env, SENIOR_DEV_OFFLINE: '1' } });
  writeSkillsConfig(main, { ...readSkillsConfig(main), version: 4, tests: TESTS });
  writeState(main, clearState({ testRuns: [full(1, { tree: mainTree })] }));
  const featSha = git(wt, 'rev-parse', 'HEAD');
  const r = spawnSync(join(hooksDir, 'pre-push'), ['origin', 'x'], { cwd: main, encoding: 'utf8', input: `refs/heads/feat ${featSha} refs/heads/feat ${'0'.repeat(40)}\n` });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(NOT_COVERED));
});
