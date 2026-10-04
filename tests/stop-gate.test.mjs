import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeState, readState, CHAINS, DOCS_GATE, openItems } from '../scripts/lib/state.mjs';

const SCRIPT = new URL('../scripts/stop-gate.mjs', import.meta.url).pathname;

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-sg-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

function transcript(dir, lastAssistantText) {
  const p = join(dir, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: lastAssistantText }] } }),
  ];
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

function gate(repo, { stopActive = false, lastText = 'All done, the feature is complete.' } = {}) {
  try {
    execFileSync('node', [SCRIPT], {
      encoding: 'utf8',
      input: JSON.stringify({
        stop_hook_active: stopActive,
        transcript_path: transcript(repo, lastText),
        cwd: repo,
      }),
    });
    return { blocked: false, msg: '' };
  } catch (e) {
    return { blocked: e.status === 2, msg: e.stderr || '' };
  }
}

function openState(overrides = {}) {
  return {
    version: 1, task: 't', type: 'quick-fix', startedAt: 'x',
    chain: CHAINS['quick-fix'], phases: {}, reviews: [],
    docsGate: { ...DOCS_GATE['quick-fix'] }, degradations: [], bypasses: [],
    scratchFiles: [], stopGate: { lastSnapshotHash: null }, ...overrides,
  };
}

test('no active session: allow', () => {
  const repo = makeRepo();
  assert.equal(gate(repo).blocked, false);
});

test('stop_hook_active: allow (loop protection)', () => {
  const repo = makeRepo();
  writeState(repo, openState());
  assert.equal(gate(repo, { stopActive: true }).blocked, false);
});

test('open items + completion claim: block with checklist', () => {
  const repo = makeRepo();
  writeState(repo, openState());
  const r = gate(repo);
  assert.equal(r.blocked, true);
  assert.ok(r.msg.includes('phase:implement'));
});

// v0.4.2 wave 2 N3: inside a headless review-run reviewer the gate stands down.
test('SENIOR_DEV_REVIEW_RUN=1: allow, state untouched, even with open items + a claim', () => {
  const repo = makeRepo();
  writeState(repo, openState());
  const p = join(repo, '.senior-dev', 'state.json');
  const before = readFileSync(p, 'utf8');
  const r = spawnSync('node', [SCRIPT], {
    encoding: 'utf8', env: { ...process.env, SENIOR_DEV_REVIEW_RUN: '1' },
    input: JSON.stringify({ stop_hook_active: false, transcript_path: transcript(repo, 'All done, the feature is complete.'), cwd: repo }),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout + r.stderr, '');
  assert.equal(readFileSync(p, 'utf8'), before);
});

test('open items but no completion claim and not finishing: allow', () => {
  const repo = makeRepo();
  writeState(repo, openState());
  assert.equal(gate(repo, { lastText: 'I will continue tomorrow with the next phase.' }).blocked, false);
});

test('finish phase in progress: blocks even without claim wording', () => {
  const repo = makeRepo();
  writeState(repo, openState({
    phases: { implement: { status: 'done' }, review: { status: 'done' }, verify: { status: 'done' }, docs: { status: 'done' } },
  })); // current phase = finish, docsGate still open
  const r = gate(repo, { lastText: 'Wrapping up.' });
  assert.equal(r.blocked, true);
});

test('identical snapshot: second stop allowed (no ping-pong)', () => {
  const repo = makeRepo();
  writeState(repo, openState());
  assert.equal(gate(repo).blocked, true);
  assert.equal(gate(repo).blocked, false); // same open items -> let through
});

test('changed snapshot: blocks again', () => {
  const repo = makeRepo();
  writeState(repo, openState());
  assert.equal(gate(repo).blocked, true);
  const s = readState(repo);
  s.phases.implement = { status: 'done' }; // items change
  writeState(repo, s);
  assert.equal(gate(repo).blocked, true);
});

test('active wait: allow the stop even with open items and a completion claim', () => {
  const repo = makeRepo();
  writeState(repo, openState({ waiting: { on: 'codex review', at: '2026-01-01T00:00:00.000Z' } }));
  assert.equal(gate(repo).blocked, false);
});

test('wait cleared: blocks again on a snapshot never previously challenged', () => {
  const repo = makeRepo();
  writeState(repo, openState({ waiting: { on: 'codex review', at: '2026-01-01T00:00:00.000Z' } }));
  // While waiting, the gate exits before ever recording a snapshot hash -
  // so this does NOT count as "already challenged" for the once-per-snapshot check below.
  assert.equal(gate(repo).blocked, false);
  const s = readState(repo);
  delete s.waiting;
  writeState(repo, s);
  assert.equal(gate(repo).blocked, true);
});

test('corrupt stdin: fail open', () => {
  try {
    execFileSync('node', [SCRIPT], { encoding: 'utf8', input: 'garbage' });
    assert.ok(true);
  } catch {
    assert.fail('should not exit non-zero on corrupt stdin');
  }
});

// v0.4.2 §3.2: the stop gate lists test items too. All non-test items cleared.
function clearedState() {
  return openState({
    phases: Object.fromEntries(CHAINS['quick-fix'].map((p) => [p, { status: 'done' }])),
    docsGate: Object.fromEntries(Object.keys(DOCS_GATE['quick-fix']).map((k) => [k, true])),
  });
}
function writeCfg(repo, text) {
  mkdirSync(join(repo, '.senior-dev'), { recursive: true });
  writeFileSync(join(repo, '.senior-dev', 'skills.json'), text);
}

test('tests configured, no full run recorded: stop gate blocks on the test item', () => {
  const repo = makeRepo();
  writeState(repo, clearedState());
  writeCfg(repo, JSON.stringify({ version: 4, source: 'superpowers', shared: false, tests: { full: 'node --test' } }));
  const r = gate(repo);
  assert.equal(r.blocked, true);
  assert.ok(r.msg.includes('tests: no full test run recorded'));
});

test('no tests config, everything else cleared: stop gate allows', () => {
  const repo = makeRepo();
  writeState(repo, clearedState());
  assert.equal(gate(repo).blocked, false);
});

test('openItems fails closed when evaluating the test rules throws', () => {
  const repo = makeRepo();
  writeCfg(repo, JSON.stringify({ version: 4, source: 'superpowers', shared: false, tests: { full: 'node --test' } }));
  const state = clearedState();
  Object.defineProperty(state, 'baseHead', { get() { throw new Error('boom'); } });
  assert.deepEqual(openItems(repo, state), ['tests: could not evaluate the test rules (boom)']);
});

test('invalid skills.json with an open phase: stop gate still blocks', () => {
  const repo = makeRepo();
  writeState(repo, openState());
  writeCfg(repo, '{not json');
  assert.equal(gate(repo).blocked, true);
});
