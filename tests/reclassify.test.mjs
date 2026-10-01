import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readState, writeState, CHAINS, LANE_RANK, openGateItems } from '../scripts/lib/state.mjs';

const CLI = new URL('../scripts/state-cli.mjs', import.meta.url).pathname;
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-reclass-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}
function cli(repo, args) {
  try { return { status: 0, out: execFileSync('node', [CLI, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, SENIOR_DEV_OFFLINE: '1' } }) }; }
  catch (e) { return { status: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}
const start = (repo, type) => cli(repo, ['init', '--task', 't', '--type', type]);
const re = (repo, type, ...more) => cli(repo, ['reclassify', '--type', type, '--reason', 'scope grew', ...more]);

test('LANE_RANK ranks lanes', () => {
  assert.deepEqual(LANE_RANK, { investigation: 0, 'docs-only': 1, 'quick-fix': 2, 'bug-fix': 3, refactor: 3, feature: 4 });
});

test('quick-fix -> bug-fix keeps phases, reviews, docs progress; no bypass', () => {
  const repo = makeRepo();
  start(repo, 'quick-fix');
  cli(repo, ['phase', 'implement', '--status', 'done']);
  cli(repo, ['review', '--phase', 'implement', '--reviewer', 'claude', '--verdict', 'APPROVED', '--cycle', '1']);
  cli(repo, ['docs', '--handover', 'true']);
  const before = readState(repo);
  const r = re(repo, 'bug-fix');
  assert.equal(r.status, 0, r.out);
  const s = readState(repo);
  assert.equal(s.type, 'bug-fix');
  assert.deepEqual(s.chain, CHAINS['bug-fix']);
  assert.equal(s.phases.implement.status, 'done');
  assert.deepEqual(s.reviews, before.reviews);
  assert.deepEqual(s.docsGate, { handover: before.docsGate.handover, affectedDocs: before.docsGate.affectedDocs });
  assert.equal(s.docsGate.handover, true);
  assert.deepEqual(s.bypasses, []);
  assert.equal(s.reclassifications.length, 1);
  const e = s.reclassifications[0];
  assert.deepEqual({ ...e, at: undefined }, { from: 'quick-fix', to: 'bug-fix', reason: 'scope grew', byOperator: false, at: undefined });
  assert.ok(e.at);
  assert.ok(cli(repo, ['status']).out.includes('reclassified: quick-fix -> bug-fix (scope grew)'));
});

test('quick-fix -> feature adds spec and plan gates', () => {
  const repo = makeRepo();
  start(repo, 'quick-fix');
  assert.equal(re(repo, 'feature').status, 0);
  const s = readState(repo);
  assert.deepEqual(s.docsGate, { spec: false, plan: false, handover: false, affectedDocs: false });
});

test('bug-fix -> refactor (same rank) needs no operator', () => {
  const repo = makeRepo();
  start(repo, 'bug-fix');
  assert.equal(re(repo, 'refactor').status, 0);
  assert.equal(readState(repo).type, 'refactor');
});

test('lowering the lane needs --by-operator', () => {
  const repo = makeRepo();
  start(repo, 'feature');
  const r = re(repo, 'quick-fix');
  assert.equal(r.status, 1);
  assert.ok(r.out.includes('reclassifying feature -> quick-fix lowers the lane; it needs the operator\'s yes (--by-operator)'), r.out);
  assert.equal(readState(repo).type, 'feature');
  const ok = re(repo, 'quick-fix', '--by-operator');
  assert.equal(ok.status, 0, ok.out);
  const s = readState(repo);
  assert.equal(s.reclassifications[0].byOperator, true);
  assert.ok(cli(repo, ['status']).out.includes('reclassified: feature -> quick-fix (scope grew) [operator]'));
});

test('refusals: same type, unknown type, missing reason, valued --by-operator', () => {
  const repo = makeRepo();
  start(repo, 'quick-fix');
  const same = re(repo, 'quick-fix');
  assert.equal(same.status, 1);
  assert.ok(same.out.includes('session is already quick-fix'));
  const unk = re(repo, 'nope');
  assert.equal(unk.status, 1);
  assert.ok(unk.out.includes('one of: feature, bug-fix'), unk.out);
  for (const args of [['reclassify', '--type', 'bug-fix'], ['reclassify', '--type', 'bug-fix', '--reason', '  ']]) {
    const m = cli(repo, args);
    assert.equal(m.status, 1);
    assert.ok(m.out.includes('reclassify needs --reason "<why>"'), m.out);
  }
  assert.equal(re(repo, 'bug-fix', '--by-operator', 'yes').status, 1);
  assert.equal(readState(repo).type, 'quick-fix');
});

test('a done debug phase is kept after bug-fix -> feature and is not an open gate item', () => {
  const repo = makeRepo();
  start(repo, 'bug-fix');
  cli(repo, ['phase', 'debug', '--status', 'done']);
  assert.equal(re(repo, 'feature').status, 0);
  const s = readState(repo);
  assert.equal(s.phases.debug.status, 'done');
  assert.ok(!openGateItems(s).includes('phase:debug'));
  assert.ok(openGateItems(s).includes('phase:brainstorm'));
});

test('prototype-key lane names are refused everywhere, state unchanged', () => {
  const repo = makeRepo();
  assert.equal(cli(repo, ['init', '--task', 't', '--type', 'constructor']).status, 1);
  assert.equal(readState(repo), null);
  start(repo, 'quick-fix');
  const before = JSON.stringify(readState(repo));
  for (const t of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(re(repo, t).status, 1, t);
    assert.equal(re(repo, t, '--by-operator').status, 1, t);
  }
  assert.equal(JSON.stringify(readState(repo)), before);
  const sl = cli(repo, ['skills-config', 'set-lane', 'constructor', '--steps', 'implement=own']);
  assert.equal(sl.status, 1);
  assert.ok(sl.out.includes('set-lane needs a lane, one of:'), sl.out);
});

test('reclassify refuses when the current session type is not a known lane', () => {
  const repo = makeRepo();
  start(repo, 'quick-fix');
  const s = readState(repo);
  s.type = 'constructor';
  writeState(repo, s);
  const r = re(repo, 'feature');
  assert.equal(r.status, 1);
  assert.ok(r.out.includes("session type 'constructor' is not a known lane - reclassify refused"), r.out);
});

test('dropping docs-gate keys needs --by-operator', () => {
  const repo = makeRepo();
  start(repo, 'refactor');
  const r = re(repo, 'bug-fix');
  assert.equal(r.status, 1);
  assert.ok(r.out.includes("reclassifying refactor -> bug-fix drops gate items (spec, plan); it needs the operator's yes (--by-operator)"), r.out);
  assert.equal(readState(repo).type, 'refactor');
  assert.equal(re(repo, 'bug-fix', '--by-operator').status, 0);
  assert.deepEqual(readState(repo).docsGate, { handover: false, affectedDocs: false });
});

test('a phase done in both lanes stays done', () => {
  const repo = makeRepo();
  start(repo, 'quick-fix');
  cli(repo, ['phase', 'implement', '--status', 'done']);
  cli(repo, ['phase', 'review', '--status', 'done']);
  assert.equal(re(repo, 'feature').status, 0);
  const s = readState(repo);
  assert.equal(s.phases.implement.status, 'done');
  assert.equal(s.phases.review.status, 'done');
});

test('feature -> quick-fix with brainstorm in_progress: phase is implement, brainstorm not open; status keeps 0.3.1 alignment', () => {
  const repo = makeRepo();
  start(repo, 'feature');
  cli(repo, ['phase', 'brainstorm', '--status', 'in_progress']);
  assert.equal(re(repo, 'quick-fix', '--by-operator').status, 0);
  const out = cli(repo, ['status']).out;
  assert.ok(out.includes('phase:  implement\n'), out);
  assert.ok(!out.includes('phase:brainstorm'), out);
  assert.ok(!openGateItems(readState(repo)).includes('phase:brainstorm'));
});
