import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  findRepoRoot, readState, writeState, hasActiveSession, currentPhase,
  latestVerdicts, openGateItems, integrationBlockers, snapshotHash,
  ensureExcluded, consumeBypass, statePath, CHAINS, DOCS_GATE,
} from '../scripts/lib/state.mjs';

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-test-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

function activeState(overrides = {}) {
  return {
    version: 1,
    task: 'test task',
    type: 'feature',
    startedAt: '2026-07-03T00:00:00.000Z',
    chain: CHAINS['feature'],
    phases: {},
    reviews: [],
    docsGate: { ...DOCS_GATE['feature'] },
    degradations: [],
    bypasses: [],
    stopGate: { lastSnapshotHash: null },
    ...overrides,
  };
}

test('findRepoRoot returns null outside a git repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-norepo-'));
  assert.equal(findRepoRoot(dir), null);
});

test('findRepoRoot finds the repo root', () => {
  const repo = makeRepo();
  const sub = join(repo, 'a', 'b');
  mkdirSync(sub, { recursive: true });
  assert.equal(realpath(findRepoRoot(sub)), realpath(repo));
});

function realpath(p) {
  return execFileSync('realpath', [p]).toString().trim();
}

function commit(repo) {
  writeFileSync(join(repo, 'README.md'), 'x');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: repo });
}

function addWorktree(repo, dirPrefix) {
  const parent = mkdtempSync(join(tmpdir(), dirPrefix));
  const wt = join(parent, 'wt');
  execFileSync('git', ['worktree', 'add', wt, '-b', 'wtbranch'], { cwd: repo });
  return wt;
}

test('findRepoRoot resolves the MAIN checkout root from inside a linked worktree', () => {
  const repo = makeRepo();
  commit(repo);
  const wt = addWorktree(repo, 'sd-wt-');
  const sub = join(wt, 'nested');
  mkdirSync(sub, { recursive: true });
  assert.equal(realpath(findRepoRoot(sub)), realpath(repo));
});

test('read/write state roundtrip', () => {
  const repo = makeRepo();
  const s = activeState();
  writeState(repo, s);
  assert.deepEqual(readState(repo), s);
});

test('readState returns null for missing, corrupt, and wrong-version files', () => {
  const repo = makeRepo();
  assert.equal(readState(repo), null);
  mkdirSync(join(repo, '.senior-dev'), { recursive: true });
  writeFileSync(statePath(repo), 'not json{{{');
  assert.equal(readState(repo), null);
  writeFileSync(statePath(repo), JSON.stringify({ version: 99, task: 'x' }));
  assert.equal(readState(repo), null);
});

test('hasActiveSession', () => {
  assert.equal(hasActiveSession(null), false);
  assert.equal(hasActiveSession(activeState()), true);
  assert.equal(hasActiveSession(activeState({ closedAt: 'now' })), false);
});

test('currentPhase walks the chain', () => {
  const s = activeState();
  assert.equal(currentPhase(s), 'brainstorm');
  s.phases.brainstorm = { status: 'done' };
  s.phases.worktree = { status: 'done' };
  assert.equal(currentPhase(s), 'plan');
});

test("latestVerdicts keeps each reviewer's latest verdict per phase", () => {
  const s = activeState({
    reviews: [
      { phase: 'implement', reviewer: 'codex', cycle: 1, verdict: 'NEEDS_REVISION' },
      { phase: 'implement', reviewer: 'codex', cycle: 2, verdict: 'APPROVED' },
    ],
  });
  assert.deepEqual(latestVerdicts(s), { implement: 'APPROVED' });
});

test('openGateItems lists undone phases, unapproved reviews, missing docs', () => {
  const s = activeState({
    reviews: [{ phase: 'implement', reviewer: 'codex', cycle: 1, verdict: 'NEEDS_REVISION' }],
  });
  const items = openGateItems(s);
  assert.ok(items.includes('phase:brainstorm'));
  assert.ok(items.includes('review:implement=NEEDS_REVISION'));
  assert.ok(items.includes('docs:spec'));
  assert.deepEqual(openGateItems(null), []);
});

test('openGateItems ignores waived docs items (null) and true items', () => {
  const s = activeState({ docsGate: { spec: null, plan: true, handover: false } });
  const items = openGateItems(s);
  assert.ok(!items.includes('docs:spec'));
  assert.ok(!items.includes('docs:plan'));
  assert.ok(items.includes('docs:handover'));
});

test('integrationBlockers requires approved reviews, verify done, docs ticked', () => {
  const s = activeState({
    reviews: [{ phase: 'implement', reviewer: 'codex', cycle: 1, verdict: 'NEEDS_REVISION' }],
  });
  const blockers = integrationBlockers(s);
  assert.ok(blockers.some((b) => b.includes('implement')));
  assert.ok(blockers.some((b) => b.includes('verification')));
  assert.ok(blockers.some((b) => b.includes('spec')));
  // all-green case
  const g = activeState({
    reviews: [{ phase: 'implement', reviewer: 'codex', cycle: 1, verdict: 'APPROVED' }],
    phases: { verify: { status: 'done' } },
    docsGate: { spec: true, plan: true, handover: true, affectedDocs: true },
  });
  assert.deepEqual(integrationBlockers(g), []);
});

test('integrationBlockers demands at least one review except docs-only/investigation', () => {
  const s = activeState({
    phases: { verify: { status: 'done' } },
    docsGate: { spec: true, plan: true, handover: true, affectedDocs: true },
  });
  assert.ok(integrationBlockers(s).some((b) => b.includes('no review')));
  const d = activeState({
    type: 'docs-only', chain: CHAINS['docs-only'],
    docsGate: { handover: true },
  });
  assert.ok(!integrationBlockers(d).some((b) => b.includes('no review')));
});

test('snapshotHash is order-insensitive and content-sensitive', () => {
  assert.equal(snapshotHash(['a', 'b']), snapshotHash(['b', 'a']));
  assert.notEqual(snapshotHash(['a']), snapshotHash(['a', 'b']));
});

test('ensureExcluded adds .senior-dev/state.json once', () => {
  const repo = makeRepo();
  ensureExcluded(repo);
  ensureExcluded(repo);
  const content = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(content.split('\n').filter((l) => l === '.senior-dev/state.json').length, 1);
});

test('consumeBypass is one-shot and logged', () => {
  const repo = makeRepo();
  const s = activeState({ bypassArmed: { reason: 'hotfix', at: 'now' } });
  writeState(repo, s);
  assert.equal(consumeBypass(repo, s, 'git push'), true);
  const after = readState(repo);
  assert.equal(after.bypassArmed, undefined);
  assert.equal(after.bypasses.length, 1);
  assert.equal(after.bypasses[0].action, 'git push');
  assert.equal(consumeBypass(repo, after, 'git push'), false);
});
