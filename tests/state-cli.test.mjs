import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readState, statePath } from '../scripts/lib/state.mjs';

const CLI = new URL('../scripts/state-cli.mjs', import.meta.url).pathname;

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-cli-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

function cli(repo, args, opts = {}) {
  try {
    const out = execFileSync('node', [CLI, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, SENIOR_DEV_OFFLINE: '1' }, ...opts });
    return { status: 0, out };
  } catch (e) {
    return { status: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

test('init creates state with the right chain and docs gate, and excludes dir', () => {
  const repo = makeRepo();
  const r = cli(repo, ['init', '--task', 'add widget', '--type', 'feature']);
  assert.equal(r.status, 0);
  const s = readState(repo);
  assert.equal(s.task, 'add widget');
  assert.equal(s.type, 'feature');
  assert.equal(s.chain[0], 'brainstorm');
  assert.equal(s.docsGate.spec, false);
  const exclude = join(repo, '.git', 'info', 'exclude');
  assert.ok(readFileSync(exclude, 'utf8').includes('.senior-dev/'));
});

test('init rejects unknown type', () => {
  const repo = makeRepo();
  const r = cli(repo, ['init', '--task', 'x', '--type', 'nonsense']);
  assert.equal(r.status, 1);
});

test('phase + tests-green + review + docs update state', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'bug-fix']);
  cli(repo, ['phase', 'debug', '--status', 'done', '--artefact', 'notes.md']);
  cli(repo, ['phase', 'implement', '--status', 'in_progress']);
  cli(repo, ['tests-green']);
  cli(repo, ['review', '--phase', 'implement', '--reviewer', 'codex', '--verdict', 'APPROVED', '--cycle', '1']);
  cli(repo, ['docs', '--handover', 'true']);
  const s = readState(repo);
  assert.equal(s.phases.debug.status, 'done');
  assert.equal(s.phases.debug.artefact, 'notes.md');
  assert.ok(s.phases.implement.testsGreenAt);
  assert.equal(s.reviews[0].verdict, 'APPROVED');
  assert.equal(s.docsGate.handover, true);
});

test('init seeds an empty waits history array', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'quick-fix']);
  assert.deepEqual(readState(repo).waits, []);
});

test('waiting --on requires a value and refuses a second arm while one is active', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'quick-fix']);
  assert.equal(cli(repo, ['waiting', '--on']).status, 1); // value-less --on
  assert.equal(cli(repo, ['waiting']).status, 1); // neither --on nor --clear
  assert.equal(readState(repo).waiting, undefined);
  const armed = cli(repo, ['waiting', '--on', 'reviewer feedback']);
  assert.equal(armed.status, 0);
  assert.equal(readState(repo).waiting.on, 'reviewer feedback');
  assert.ok(readState(repo).waiting.at);
  const doubleArm = cli(repo, ['waiting', '--on', 'something else']);
  assert.equal(doubleArm.status, 1);
  assert.ok(doubleArm.out.includes('already waiting on: reviewer feedback'));
  assert.equal(readState(repo).waiting.on, 'reviewer feedback'); // unchanged
});

test('waiting --clear clears the active wait, refuses when none is active, and rejects both flags together', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'quick-fix']);
  assert.equal(cli(repo, ['waiting', '--clear']).status, 1); // nothing active
  cli(repo, ['waiting', '--on', 'ci run']);
  const cleared = cli(repo, ['waiting', '--clear']);
  assert.equal(cleared.status, 0);
  const s = readState(repo);
  assert.equal(s.waiting, undefined);
  assert.equal(s.waits.length, 1);
  assert.equal(s.waits[0].on, 'ci run');
  assert.ok(s.waits[0].clearedAt);

  assert.equal(cli(repo, ['waiting', '--on', 'x', '--clear']).status, 1);
});

test('status shows an active wait prominently and a past-waits count once waits accumulate', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'quick-fix']);
  const before = cli(repo, ['status']);
  assert.ok(!before.out.includes('WAITING on'));
  assert.ok(!before.out.toLowerCase().includes('past wait'));
  cli(repo, ['waiting', '--on', 'codex review']);
  const during = cli(repo, ['status']);
  assert.ok(during.out.includes('WAITING on: codex review'));
  cli(repo, ['waiting', '--clear']);
  const after = cli(repo, ['status']);
  assert.ok(!after.out.includes('WAITING on'));
  assert.ok(after.out.toLowerCase().includes('past wait'));
});

test('finish refuses while a wait is active, even with --force-open', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'quick-fix']);
  cli(repo, ['waiting', '--on', 'external ci']);
  const r = cli(repo, ['finish', '--force-open', 'ship it anyway']);
  assert.equal(r.status, 1);
  assert.ok(r.out.includes('external ci'));
  assert.ok(existsSync(statePath(repo)));
});

test('finish succeeds after the wait is cleared, and the archive retains waits history with clearedAt', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'quick-fix']);
  cli(repo, ['waiting', '--on', 'external ci']);
  cli(repo, ['waiting', '--clear']);
  cli(repo, ['phase', 'implement', '--status', 'done']);
  cli(repo, ['phase', 'review', '--status', 'done']);
  cli(repo, ['phase', 'verify', '--status', 'done']);
  cli(repo, ['docs', '--handover', 'true', '--affectedDocs', 'true']);
  cli(repo, ['phase', 'docs', '--status', 'done']);
  const r = cli(repo, ['finish']);
  assert.equal(r.status, 0);
  const hist = readdirSync(join(repo, '.senior-dev', 'history'));
  const archived = JSON.parse(readFileSync(join(repo, '.senior-dev', 'history', hist[0]), 'utf8'));
  assert.equal(archived.waits.length, 1);
  assert.equal(archived.waits[0].on, 'external ci');
  assert.ok(archived.waits[0].clearedAt);
});

test('bypass requires a reason and arms one-shot flag', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'quick-fix']);
  assert.equal(cli(repo, ['bypass', '--reason', '']).status, 1);
  assert.equal(cli(repo, ['bypass']).status, 1);
  assert.equal(cli(repo, ['bypass', '--reason', 'operator hotfix']).status, 0);
  assert.equal(readState(repo).bypassArmed.reason, 'operator hotfix');
});

test('bypass --reason-stdin records a reason containing double quotes verbatim', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'quick-fix']);
  const reason = 'he said " I dunno " do it anyway';
  const r = cli(repo, ['bypass', '--reason-stdin'], { input: reason });
  assert.equal(r.status, 0);
  assert.equal(readState(repo).bypassArmed.reason, reason);
});

test('bypass --reason-stdin records a multi-word reason with a leading -- prefix verbatim', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'quick-fix']);
  const reason = '--force just ship it, ignore the warning';
  const r = cli(repo, ['bypass', '--reason-stdin'], { input: reason });
  assert.equal(r.status, 0);
  assert.equal(readState(repo).bypassArmed.reason, reason);
});

test('bypass --reason-stdin trims surrounding whitespace but rejects empty/whitespace-only stdin', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'quick-fix']);
  const padded = cli(repo, ['bypass', '--reason-stdin'], { input: '  reason with padding  \n' });
  assert.equal(padded.status, 0);
  assert.equal(readState(repo).bypassArmed.reason, 'reason with padding');

  const empty = cli(repo, ['bypass', '--reason-stdin'], { input: '   \n  ' });
  assert.equal(empty.status, 1);
});

test('plain --reason still works when --reason-stdin is not given', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'quick-fix']);
  const r = cli(repo, ['bypass', '--reason', 'direct caller reason']);
  assert.equal(r.status, 0);
  assert.equal(readState(repo).bypassArmed.reason, 'direct caller reason');
});

test('bypass with neither --reason nor --reason-stdin exits 1', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'quick-fix']);
  const r = cli(repo, ['bypass']);
  assert.equal(r.status, 1);
});

test('bypass rejects --reason and --reason-stdin given together', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'quick-fix']);
  const r = cli(repo, ['bypass', '--reason', 'x', '--reason-stdin'], { input: 'y' });
  assert.equal(r.status, 1);
});

test('status renders without crashing and mentions task + phase', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'my task', '--type', 'feature']);
  const r = cli(repo, ['status']);
  assert.equal(r.status, 0);
  assert.ok(r.out.includes('my task'));
  assert.ok(r.out.includes('brainstorm'));
});

test('status reports no active session when none exists', () => {
  const repo = makeRepo();
  const r = cli(repo, ['status']);
  assert.equal(r.status, 0);
  assert.ok(r.out.toLowerCase().includes('no active'));
});

test('sweep prints git evidence sections', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'quick-fix']);
  const r = cli(repo, ['sweep']);
  assert.equal(r.status, 0);
  assert.ok(r.out.includes('git worktree list'));
  assert.ok(r.out.includes('git status --porcelain'));
});

test('flags that require a value reject missing values', () => {
  const repo = makeRepo();
  // --task at end of argv must not become task:"true"
  assert.equal(cli(repo, ['init', '--type', 'feature', '--task']).status, 1);
  assert.equal(readState(repo), null);
  cli(repo, ['init', '--task', 'x', '--type', 'feature']);
  // --wanted followed by another flag must not become wanted:"true"
  assert.equal(cli(repo, ['degrade', '--wanted', '--used', 'x']).status, 1);
  assert.equal(readState(repo).degradations.length, 0);
  // --add at end of argv must not record "true"
  assert.equal(cli(repo, ['scratch', '--add']).status, 1);
  assert.equal(readState(repo).scratchFiles.length, 0);
});

test('review rejects bogus reviewer and non-numeric cycle', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'feature']);
  assert.equal(
    cli(repo, ['review', '--phase', 'implement', '--reviewer', 'bob', '--verdict', 'APPROVED', '--cycle', '1']).status,
    1,
  );
  assert.equal(
    cli(repo, ['review', '--phase', 'implement', '--reviewer', 'codex', '--verdict', 'APPROVED', '--cycle', 'abc']).status,
    1,
  );
  assert.equal(readState(repo).reviews.length, 0);
});

test('finish archives and clears active state when all gates are clear', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'Fix the thing!', '--type', 'quick-fix']);
  cli(repo, ['phase', 'implement', '--status', 'done']);
  cli(repo, ['phase', 'review', '--status', 'done']);
  cli(repo, ['phase', 'verify', '--status', 'done']);
  cli(repo, ['docs', '--handover', 'true', '--affectedDocs', 'true']);
  cli(repo, ['phase', 'docs', '--status', 'done']);
  const r = cli(repo, ['finish']);
  assert.equal(r.status, 0);
  assert.ok(!existsSync(statePath(repo)));
  const hist = readdirSync(join(repo, '.senior-dev', 'history'));
  assert.equal(hist.length, 1);
  assert.ok(hist[0].endsWith('.json'));
});

test('finish refuses when gate items are open, listing them, and leaves state intact', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'quick-fix']);
  const r = cli(repo, ['finish']);
  assert.equal(r.status, 1);
  assert.ok(r.out.includes('phase:implement'));
  assert.ok(existsSync(statePath(repo)));
  assert.equal(readdirSync(join(repo, '.senior-dev')).includes('history'), false);
});

test('finish --force-open with a reason archives despite open items and logs the bypass in the archived file', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'quick-fix']);
  const r = cli(repo, ['finish', '--force-open', 'operator says ship it']);
  assert.equal(r.status, 0);
  assert.ok(!existsSync(statePath(repo)));
  const hist = readdirSync(join(repo, '.senior-dev', 'history'));
  assert.equal(hist.length, 1);
  const archived = JSON.parse(readFileSync(join(repo, '.senior-dev', 'history', hist[0]), 'utf8'));
  const bypass = archived.bypasses.find((b) => b.action === 'finish --force-open');
  assert.ok(bypass, 'expected a finish --force-open bypass entry in the archived state');
  assert.equal(bypass.reason, 'operator says ship it');
  assert.ok(Array.isArray(bypass.openItems) && bypass.openItems.length > 0);
  assert.ok(bypass.openItems.includes('phase:implement'));
  assert.ok(bypass.at);
});

test('finish --force-open without a value exits 1 and leaves state intact', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'quick-fix']);
  const r = cli(repo, ['finish', '--force-open']);
  assert.equal(r.status, 1);
  assert.ok(existsSync(statePath(repo)));
});

test('finish uses a unique archive filename per session so a same-day same-slug re-finish does not overwrite the prior archive', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'escalation task', '--type', 'quick-fix']);
  cli(repo, ['finish', '--force-open', 'first pass bypass']);
  cli(repo, ['init', '--task', 'escalation task', '--type', 'quick-fix']);
  cli(repo, ['finish', '--force-open', 'second pass bypass']);
  const histDir = join(repo, '.senior-dev', 'history');
  const hist = readdirSync(histDir);
  assert.equal(hist.length, 2, `expected two distinct archive files, got: ${hist.join(', ')}`);
  const contents = hist.map((f) => JSON.parse(readFileSync(join(histDir, f), 'utf8')));
  const first = contents.find((c) => (c.bypasses || []).some((b) => b.reason === 'first pass bypass'));
  assert.ok(first, 'the first archive (with the "first pass bypass" audit entry) must still exist, unoverwritten');
});

test('status FROM inside a linked worktree reports the main checkout\'s active session', () => {
  const repo = makeRepo();
  writeFileSync(join(repo, 'README.md'), 'x');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: repo });
  cli(repo, ['init', '--task', 'worktree flow task', '--type', 'feature']);
  const wtParent = mkdtempSync(join(tmpdir(), 'sd-cli-wt-'));
  const wt = join(wtParent, 'wt');
  execFileSync('git', ['worktree', 'add', wt, '-b', 'wtbranch'], { cwd: repo });
  const r = cli(wt, ['status']);
  assert.equal(r.status, 0);
  assert.ok(r.out.includes('worktree flow task'));
  assert.ok(!r.out.toLowerCase().includes('no active session'));
});
