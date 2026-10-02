import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeState, CHAINS, DOCS_GATE } from '../scripts/lib/state.mjs';

const SCRIPT = new URL('../scripts/session-start.mjs', import.meta.url).pathname;

function run(cwd, stdinObj = {}) {
  return execFileSync('node', [SCRIPT], {
    cwd, encoding: 'utf8', input: JSON.stringify({ cwd, ...stdinObj }),
  });
}

test('outside a git repo: silent, exit 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-ss-norepo-'));
  assert.equal(run(dir), '');
});

test('in a repo with no session: emits bootstrap context', () => {
  const repo = mkdtempSync(join(tmpdir(), 'sd-ss-'));
  execFileSync('git', ['init', '-q', repo]);
  const out = JSON.parse(run(repo));
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(ctx.includes('senior-dev:conductor'));
  assert.ok(!ctx.includes('RESUME'));
  assert.ok(ctx.includes('state-cli.mjs'));
});

test('in a repo with an active session: emits resume notice', () => {
  const repo = mkdtempSync(join(tmpdir(), 'sd-ss-active-'));
  execFileSync('git', ['init', '-q', repo]);
  writeState(repo, {
    version: 1, task: 'half-done widget', type: 'feature',
    startedAt: 'x', chain: CHAINS['feature'], phases: { brainstorm: { status: 'done' } },
    reviews: [], docsGate: { ...DOCS_GATE['feature'] }, degradations: [], bypasses: [],
    stopGate: { lastSnapshotHash: null },
  });
  const ctx = JSON.parse(run(repo)).hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('RESUME'));
  assert.ok(ctx.includes('half-done widget'));
  assert.ok(ctx.includes('worktree'));
  assert.ok(ctx.includes('state-cli.mjs'));
});

test('in a repo with an active session and a waiting state: RESUME block flags it', () => {
  const repo = mkdtempSync(join(tmpdir(), 'sd-ss-waiting-'));
  execFileSync('git', ['init', '-q', repo]);
  writeState(repo, {
    version: 1, task: 'half-done widget', type: 'feature',
    startedAt: 'x', chain: CHAINS['feature'], phases: { brainstorm: { status: 'done' } },
    reviews: [], docsGate: { ...DOCS_GATE['feature'] }, degradations: [], bypasses: [],
    stopGate: { lastSnapshotHash: null },
    waiting: { on: 'codex review', at: '2026-01-01T00:00:00.000Z' },
  });
  const ctx = JSON.parse(run(repo)).hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('WAITING on:'));
  assert.ok(ctx.includes('codex review'));
  assert.ok(ctx.includes('2026-01-01T00:00:00.000Z'));
});

test('active session with a corrupt waiting field: RESUME block still renders, no crash', () => {
  const repo = mkdtempSync(join(tmpdir(), 'sd-ss-waiting-corrupt-'));
  execFileSync('git', ['init', '-q', repo]);
  writeState(repo, {
    version: 1, task: 'half-done widget', type: 'feature',
    startedAt: 'x', chain: CHAINS['feature'], phases: { brainstorm: { status: 'done' } },
    reviews: [], docsGate: { ...DOCS_GATE['feature'] }, degradations: [], bypasses: [],
    stopGate: { lastSnapshotHash: null },
    waiting: 'not-an-object',
  });
  const ctx = JSON.parse(run(repo)).hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('RESUME'));
  assert.ok(!ctx.includes('WAITING on:'));
});

test('malformed stdin: still works from process cwd', () => {
  const repo = mkdtempSync(join(tmpdir(), 'sd-ss-badstdin-'));
  execFileSync('git', ['init', '-q', repo]);
  const out = execFileSync('node', [SCRIPT], { cwd: repo, encoding: 'utf8', input: 'not-json' });
  assert.ok(out.includes('senior-dev:conductor'));
  assert.ok(out.includes('state-cli.mjs'));
});

// v0.4.2 §3.2: the banner lists test items too. All non-test items cleared.
function clearedRepo(withTests) {
  const repo = mkdtempSync(join(tmpdir(), 'sd-ss-tests-'));
  execFileSync('git', ['init', '-q', repo]);
  writeState(repo, {
    version: 1, task: 'cleared', type: 'quick-fix', startedAt: 'x',
    chain: CHAINS['quick-fix'],
    phases: Object.fromEntries(CHAINS['quick-fix'].map((p) => [p, { status: 'done' }])),
    reviews: [], docsGate: Object.fromEntries(Object.keys(DOCS_GATE['quick-fix']).map((k) => [k, true])),
    degradations: [], bypasses: [], stopGate: { lastSnapshotHash: null },
  });
  if (withTests) {
    mkdirSync(join(repo, '.senior-dev'), { recursive: true });
    writeFileSync(join(repo, '.senior-dev', 'skills.json'), JSON.stringify({ version: 4, source: 'superpowers', shared: false, tests: { full: 'node --test' } }));
  }
  return repo;
}

test('banner lists the test item when tests are configured', () => {
  const ctx = JSON.parse(run(clearedRepo(true))).hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('tests: no full test run recorded'));
});

test('banner without a tests config has no tests item', () => {
  const ctx = JSON.parse(run(clearedRepo(false))).hookSpecificOutput.additionalContext;
  assert.equal(ctx.split('\n').find((l) => l.startsWith('open gate items:')), 'open gate items: none');
});
