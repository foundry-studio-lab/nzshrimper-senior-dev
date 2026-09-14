import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestVerdicts, integrationBlockers, openGateItems, CHAINS, DOCS_GATE } from '../scripts/lib/state.mjs';

function st(reviews, adjudications = []) {
  return {
    version: 1, task: 't', type: 'quick-fix', startedAt: 'x', chain: CHAINS['quick-fix'],
    phases: { implement: { status: 'done' }, review: { status: 'done' }, verify: { status: 'done' }, docs: { status: 'done' } },
    reviews, adjudications, docsGate: { handover: true, affectedDocs: true },
    degradations: [], bypasses: [], scratchFiles: [], waits: [], dispatches: [], stopGate: { lastSnapshotHash: null },
  };
}
const NR = (reviewer, cycle = 1, phase = 'implement') => ({ phase, reviewer, verdict: 'NEEDS_REVISION', cycle });
const OK = (reviewer, cycle = 1, phase = 'implement') => ({ phase, reviewer, verdict: 'APPROVED', cycle });

test('a split verdict blocks in every recording order', () => {
  assert.equal(latestVerdicts(st([NR('codex'), OK('claude')])).implement, 'NEEDS_REVISION');
  assert.equal(latestVerdicts(st([OK('claude'), NR('codex')])).implement, 'NEEDS_REVISION');
  assert.equal(latestVerdicts(st([NR('claude'), OK('codex')])).implement, 'NEEDS_REVISION');
  assert.ok(integrationBlockers(st([NR('codex'), OK('claude')])).some((b) => b.includes('NEEDS_REVISION')));
  assert.ok(openGateItems(st([NR('codex'), OK('claude')])).includes('review:implement=NEEDS_REVISION'));
});

test('a later approval by the rejecting reviewer clears the phase', () => {
  const s = st([OK('claude'), NR('codex'), OK('codex', 2)]);
  assert.equal(latestVerdicts(s).implement, 'APPROVED');
  assert.deepEqual(integrationBlockers(s), []);
});

test('a single reviewer approval is APPROVED (docs-only lanes have no second pass)', () => {
  assert.equal(latestVerdicts(st([OK('claude')])).implement, 'APPROVED');
  assert.equal(latestVerdicts(st([NR('claude')])).implement, 'NEEDS_REVISION');
  assert.deepEqual(latestVerdicts(st([])), {});
});

test('an overruled adjudication clears exactly that rejection', () => {
  const adj = [{ phase: 'implement', reviewer: 'codex', cycle: 1, decision: 'overruled' }];
  assert.equal(latestVerdicts(st([NR('codex'), OK('claude')], adj)).implement, 'APPROVED');
  // wrong cycle, wrong reviewer, or upheld: still blocked
  assert.equal(latestVerdicts(st([NR('codex', 2), OK('claude')], adj)).implement, 'NEEDS_REVISION');
  assert.equal(latestVerdicts(st([NR('claude'), OK('codex')], adj)).implement, 'NEEDS_REVISION');
  assert.equal(latestVerdicts(st([NR('codex'), OK('claude')], [{ ...adj[0], decision: 'upheld' }])).implement, 'NEEDS_REVISION');
});

test('phases resolve independently', () => {
  const v = latestVerdicts(st([OK('claude'), OK('codex'), NR('codex', 1, 'finish'), OK('claude', 1, 'finish')]));
  assert.equal(v.implement, 'APPROVED');
  assert.equal(v.finish, 'NEEDS_REVISION');
});
