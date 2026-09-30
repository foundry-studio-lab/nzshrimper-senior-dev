import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  readState, writeState, writeSkillsConfig, headTree, integrationBlockers,
} from '../scripts/lib/state.mjs';

const CLI = new URL('../scripts/state-cli.mjs', import.meta.url).pathname;
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
function cli(cwd, args, input) {
  const r = { cwd, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SENIOR_DEV_OFFLINE: '1' } };
  try { return { status: 0, out: execFileSync('node', [CLI, ...args], r) }; }
  catch (e) { return { status: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}
const TESTS = { full: 'node -e 0' };

function setup({ tests = TESTS } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sd-ship-'));
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 't@t'); g(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'f'), '1');
  g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'base');
  if (tests) writeSkillsConfig(dir, { version: 4, source: 'superpowers', shared: false, tests });
  cli(dir, ['init', '--task', 't', '--type', 'quick-fix']);
  const tree = headTree(dir);
  const set = (runs, extra = {}) => {
    const s = readState(dir);
    s.testRuns = runs; Object.assign(s, extra);
    writeState(dir, s);
  };
  return { dir, tree, set };
}
const full = (id, tree, o = {}) => ({ id, kind: 'full', exit: 0, failures: [], tree, sinceFull: null, ...o });
const red = (id, tree, failures = ['a > x']) => full(id, tree, { exit: 1, failures });
const pre = (id, t, tree, proven = true) => ({ id, kind: 'preexisting', test: t, proven, exit: 1, tree, sinceFull: 1 });
const ship = (dir, reason = 'known') => cli(dir, ['ship', '--reason', reason]);

test('refuses with no tests config or tests.none', () => {
  for (const tests of [null, { none: true }]) {
    const { dir } = setup({ tests });
    const r = ship(dir);
    assert.equal(r.status, 1);
    assert.match(r.out, /no tests config/);
  }
});

test('refuses with no full run', () => {
  const { dir } = setup();
  const r = ship(dir);
  assert.equal(r.status, 1);
  assert.match(r.out, /no full test run recorded/);
});

test('refuses when the full run is green', () => {
  const { dir, tree, set } = setup();
  set([full(1, tree)]);
  const r = ship(dir);
  assert.equal(r.status, 1);
  assert.match(r.out, /full run is green - nothing to waive/);
});

test('refuses when failures are unknown', () => {
  for (const failures of [null, []]) {
    const { dir, tree, set } = setup();
    set([red(1, tree, failures)]);
    const r = ship(dir);
    assert.equal(r.status, 1);
    assert.match(r.out, /failures are unknown/);
  }
});

test('refuses naming every unproven failure', () => {
  const { dir, tree, set } = setup();
  set([red(1, tree, ['a > x', 'a > y', 'a > z']), pre(2, 'a > x', tree), pre(3, 'a > y', tree, false)]);
  const r = ship(dir);
  assert.equal(r.status, 1);
  assert.match(r.out, /a > y/);
  assert.match(r.out, /a > z/);
  assert.doesNotMatch(r.out, /a > x,|a > x$/m);
  assert.equal(readState(dir).ship, undefined);
});

test('refuses when the full run passed no tests (runner may not have run the suite)', () => {
  // A misconfigured runner reports one synthetic failure and nothing else; it
  // reproduces on base, so it "proves" itself while no real test ran.
  const { dir, tree, set } = setup();
  set([{ ...red(1, tree), passedCount: 0 }, pre(2, 'a > x', tree)]);
  const r = ship(dir);
  assert.equal(r.status, 1);
  assert.match(r.out, /full test run #1 passed no tests/);
  assert.equal(readState(dir).ship, undefined);
});

test('refuses a full run whose failing ids repeat (one proof must not waive two tests)', () => {
  // Narrowing the `one` command can prove one of two same-named failures; the
  // duplicate in the full run must still block the waiver of both.
  const { dir, tree, set } = setup();
  set([{ ...red(1, tree, ['a > x', 'a > x']), passedCount: 1 }, pre(2, 'a > x', tree)]);
  const r = ship(dir);
  assert.equal(r.status, 1);
  assert.match(r.out, /full test run #1 has ambiguous failing ids: a > x/);
  assert.equal(readState(dir).ship, undefined);
});

test('refuses when the current HEAD tree is not covered', () => {
  const { dir, set } = setup();
  set([red(1, 'other-tree'), pre(2, 'a > x', 'other-tree')]);
  const r = ship(dir);
  assert.equal(r.status, 1);
  assert.match(r.out, /not covered/);
});

test('refuses when build is configured and no green build at the current tree', () => {
  const { dir, tree, set } = setup({ tests: { ...TESTS, build: 'node -e 0' } });
  set([red(1, tree), pre(2, 'a > x', tree), { id: 3, kind: 'build', exit: 0, tree: 'other', sinceFull: 1 }]);
  let r = ship(dir);
  assert.equal(r.status, 1);
  assert.match(r.out, /build/);
  set([red(1, tree), pre(2, 'a > x', tree), { id: 3, kind: 'build', exit: 1, tree, sinceFull: 1 }]);
  r = ship(dir);
  assert.equal(r.status, 1);
  assert.match(r.out, /build/);
});

test('arms when all hold; status shows it; second arming refused; no test blocker left', () => {
  const { dir, tree, set } = setup({ tests: { ...TESTS, build: 'node -e 0' } });
  set([red(1, tree), pre(2, 'a > x', tree), { id: 3, kind: 'build', exit: 0, tree, sinceFull: 1 }]);
  const r = ship(dir, 'flaky on base');
  assert.equal(r.status, 0, r.out);
  const s = readState(dir);
  assert.equal(s.ship.reason, 'flaky on base');
  assert.equal(s.ship.fullRun, 1);
  assert.ok(s.ship.at);
  assert.match(cli(dir, ['status']).out, /SHIP armed: flaky on base \(full run #1\)/);
  const again = ship(dir);
  assert.equal(again.status, 1);
  assert.match(again.out, /ship already armed/);
  const b = integrationBlockers(s, { tests: { ...TESTS, build: 'node -e 0' }, trees: [tree] });
  assert.ok(!b.some((x) => /test run/.test(x)), b.join('|'));
});

test('ship does not clear reviews or docs', () => {
  const { dir, tree, set } = setup();
  set([red(1, tree), pre(2, 'a > x', tree)], {
    reviews: [{ phase: 'implement', reviewer: 'codex', verdict: 'NEEDS_REVISION', cycle: 1 }],
    docsGate: { handover: false, affectedDocs: true },
  });
  assert.equal(ship(dir).status, 0);
  const b = integrationBlockers(readState(dir), { tests: TESTS, trees: [tree] });
  assert.ok(b.some((x) => /review for 'implement'/.test(x)));
  assert.ok(b.some((x) => /docs gate item 'handover'/.test(x)));
});

test('a commit after ship still needs affected coverage', () => {
  const { dir, tree, set } = setup();
  set([red(1, tree), pre(2, 'a > x', tree)]);
  assert.equal(ship(dir).status, 0);
  writeFileSync(join(dir, 'f'), '2');
  g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'next');
  const b = integrationBlockers(readState(dir), { tests: TESTS, trees: [headTree(dir)] });
  assert.ok(b.some((x) => /not covered/.test(x)), b.join('|'));
});

test('reason from stdin survives quotes and a leading --', () => {
  const { dir, tree, set } = setup();
  set([red(1, tree), pre(2, 'a > x', tree)]);
  const reason = `-- it's "quoted" \\ and $HOME`;
  const r = cli(dir, ['ship', '--reason-stdin'], reason + '\n');
  assert.equal(r.status, 0, r.out);
  assert.equal(readState(dir).ship.reason, reason);
});

test('needs exactly one of --reason or --reason-stdin', () => {
  const { dir, tree, set } = setup();
  set([red(1, tree), pre(2, 'a > x', tree)]);
  assert.equal(cli(dir, ['ship']).status, 1);
  assert.equal(cli(dir, ['ship', '--reason', 'a', '--reason-stdin'], 'b').status, 1);
  assert.equal(readState(dir).ship, undefined);
});
