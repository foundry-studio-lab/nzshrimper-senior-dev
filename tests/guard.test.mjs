import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeState, readState, CHAINS, DOCS_GATE, writeSkillsConfig, readSkillsConfig } from '../scripts/lib/state.mjs';

const CLI = new URL('../scripts/state-cli.mjs', import.meta.url).pathname;

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-guard-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}
function cli(repo, args, input, opts = {}) {
  try {
    const out = execFileSync('node', [CLI, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, SENIOR_DEV_OFFLINE: '1' }, ...(input ? { input } : {}), ...opts });
    return { status: 0, out };
  } catch (e) { return { status: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}
function hook(repo, name, args = []) {
  // spawnSync (not execFileSync) so stderr is captured on the SUCCESS path
  // too - needed to assert on the shim's "failing open" warning, which is
  // written to stderr while the shim still exits 0.
  const r = spawnSync(join(repo, '.git', 'hooks', name), args, { cwd: repo, encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function blockedState(overrides = {}) {
  return {
    version: 1, task: 'guard test', type: 'quick-fix', startedAt: 'x',
    chain: CHAINS['quick-fix'], phases: { implement: { status: 'done' } },
    reviews: [{ phase: 'implement', reviewer: 'codex', verdict: 'NEEDS_REVISION', cycle: 1 }],
    docsGate: { ...DOCS_GATE['quick-fix'] }, degradations: [], bypasses: [],
    scratchFiles: [], waits: [], stopGate: { lastSnapshotHash: null }, ...overrides,
  };
}

test('guard install creates bundle, shims, and records consent', () => {
  const repo = makeRepo();
  const r = cli(repo, ['guard', 'install']);
  assert.equal(r.status, 0);
  for (const f of ['guard.mjs', 'state-lib.mjs', 'version']) {
    assert.ok(existsSync(join(repo, '.senior-dev', 'guard', f)), f);
  }
  for (const h of ['pre-commit', 'pre-push', 'pre-merge-commit']) {
    const p = join(repo, '.git', 'hooks', h);
    assert.ok(existsSync(p), h);
    assert.ok(readFileSync(p, 'utf8').includes('senior-dev guard shim'));
  }
  assert.equal(readSkillsConfig(repo).guard, 'installed');
});

test('guard status reports installed / absent / declined', () => {
  const repo = makeRepo();
  assert.ok(cli(repo, ['guard', 'status']).out.includes('absent'));
  cli(repo, ['guard', 'install']);
  assert.ok(cli(repo, ['guard', 'status']).out.includes('installed'));
  cli(repo, ['guard', 'uninstall']);
  assert.ok(cli(repo, ['guard', 'status']).out.includes('declined'));
});

test('pre-push hook blocks a staged open-gate session, plain terminal', () => {
  const repo = makeRepo();
  cli(repo, ['guard', 'install']);
  writeState(repo, blockedState());
  const r = hook(repo, 'pre-push', ['origin', 'file:///dev/null']);
  assert.equal(r.status, 1);
  assert.ok(r.out.includes('senior-dev gate: integration blocked'));
});

test('pre-push allows when gates are clear, and when no session', () => {
  const repo = makeRepo();
  cli(repo, ['guard', 'install']);
  assert.equal(hook(repo, 'pre-push').status, 0); // no session
  writeState(repo, blockedState({
    reviews: [{ phase: 'implement', reviewer: 'codex', verdict: 'APPROVED', cycle: 1 }],
    phases: { implement: { status: 'done' }, verify: { status: 'done' } },
    docsGate: { handover: true, affectedDocs: true },
  }));
  assert.equal(hook(repo, 'pre-push').status, 0);
});

test('pre-commit enforces tests-green during implement', () => {
  const repo = makeRepo();
  cli(repo, ['guard', 'install']);
  writeState(repo, blockedState({ phases: { implement: { status: 'in_progress' } }, reviews: [] }));
  const r = hook(repo, 'pre-commit');
  assert.equal(r.status, 1);
  assert.ok(r.out.includes('tests-green'));
  const s = readState(repo);
  s.phases.implement.testsGreenAt = 'now';
  writeState(repo, s);
  assert.equal(hook(repo, 'pre-commit').status, 0);
});

test('armed bypass is consumed once by the guard on a would-block push', () => {
  const repo = makeRepo();
  cli(repo, ['guard', 'install']);
  writeState(repo, blockedState({ bypassArmed: { reason: 'hotfix', at: 'x' } }));
  assert.equal(hook(repo, 'pre-push').status, 0);
  const s = readState(repo);
  assert.equal(s.bypassArmed, undefined);
  assert.equal(s.bypasses.length, 1);
  assert.equal(hook(repo, 'pre-push').status, 1); // consumed - blocks again
});

test('existing hook is preserved and chained; uninstall restores it', () => {
  const repo = makeRepo();
  const hooksDir = join(repo, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, 'pre-push'), '#!/bin/sh\necho prior-hook-ran >&2\nexit 0\n');
  chmodSync(join(hooksDir, 'pre-push'), 0o755);
  cli(repo, ['guard', 'install']);
  assert.ok(existsSync(join(hooksDir, 'pre-push.pre-senior-dev')));
  writeState(repo, blockedState());
  const r = hook(repo, 'pre-push');
  assert.equal(r.status, 1);                       // guard still blocks
  assert.ok(r.out.includes('prior-hook-ran'));     // prior hook ran first
  cli(repo, ['guard', 'uninstall']);
  assert.ok(readFileSync(join(hooksDir, 'pre-push'), 'utf8').includes('prior-hook-ran'));
  assert.ok(!existsSync(join(hooksDir, 'pre-push.pre-senior-dev')));
});

test('prior hook that blocks wins before the guard runs', () => {
  const repo = makeRepo();
  const hooksDir = join(repo, '.git', 'hooks');
  writeFileSync(join(hooksDir, 'pre-push'), '#!/bin/sh\necho prior-block >&2\nexit 7\n');
  chmodSync(join(hooksDir, 'pre-push'), 0o755);
  cli(repo, ['guard', 'install']);
  const r = hook(repo, 'pre-push');
  assert.equal(r.status, 7);
  assert.ok(r.out.includes('prior-block'));
});

test('guard fails open on corrupt state', () => {
  const repo = makeRepo();
  cli(repo, ['guard', 'install']);
  mkdirSync(join(repo, '.senior-dev'), { recursive: true });
  writeFileSync(join(repo, '.senior-dev', 'state.json'), '{corrupt');
  assert.equal(hook(repo, 'pre-push').status, 0);
});

test('installed bundle is git-excluded, never untracked dirt', () => {
  const repo = makeRepo();
  cli(repo, ['guard', 'install']);
  const porcelain = execFileSync('git', ['-C', repo, 'status', '--porcelain', '-uall'], { encoding: 'utf8' });
  assert.ok(!porcelain.includes('.senior-dev/guard'), `bundle shows as dirt:\n${porcelain}`);
  const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.ok(exclude.split('\n').includes('.senior-dev/guard/'));
});

test('corrupt pass token is purged on sight by a would-block push', () => {
  const repo = makeRepo();
  cli(repo, ['guard', 'install']);
  writeState(repo, blockedState());
  const tokenPath = join(repo, '.senior-dev', 'guard', 'pass.json');
  writeFileSync(tokenPath, '{corrupt');
  assert.equal(hook(repo, 'pre-push').status, 1); // corrupt token grants nothing
  assert.ok(!existsSync(tokenPath), 'corrupt pass.json must be consumed/purged');
});

test('shim fails open when state-lib.mjs alone is missing (guard.mjs present)', () => {
  const repo = makeRepo();
  cli(repo, ['guard', 'install']);
  writeState(repo, blockedState());
  unlinkSync(join(repo, '.senior-dev', 'guard', 'state-lib.mjs'));
  const r = hook(repo, 'pre-push');
  assert.equal(r.status, 0);
  assert.ok(r.out.toLowerCase().includes('failing open'), `expected a failing-open warning, got: ${r.out}`);
});

test('install is idempotent and respects core.hooksPath', () => {
  const repo = makeRepo();
  cli(repo, ['guard', 'install']);
  assert.equal(cli(repo, ['guard', 'install']).status, 0); // no double-preserve of our own shim
  assert.ok(!existsSync(join(repo, '.git', 'hooks', 'pre-push.pre-senior-dev')));
  const repo2 = makeRepo();
  mkdirSync(join(repo2, 'myhooks'), { recursive: true });
  execFileSync('git', ['-C', repo2, 'config', 'core.hooksPath', 'myhooks']);
  cli(repo2, ['guard', 'install']);
  assert.ok(existsSync(join(repo2, 'myhooks', 'pre-push')));
});

test('core.hooksPath with a tilde resolves to the git-expanded dir, never a literal ~ dir', () => {
  const repo = makeRepo();
  // Point $HOME at a throwaway temp dir for this subprocess only, so
  // tilde-expansion of core.hooksPath never touches the real home dir.
  const fakeHome = mkdtempSync(join(tmpdir(), 'sd-guard-fakehome-'));
  execFileSync('git', ['-C', repo, 'config', 'core.hooksPath', '~/sd-guard-test-hooks']);
  const r = cli(repo, ['guard', 'install'], undefined, { env: { ...process.env, HOME: fakeHome } });
  assert.equal(r.status, 0, r.out);

  const expandedDir = join(fakeHome, 'sd-guard-test-hooks');
  for (const h of ['pre-commit', 'pre-push', 'pre-merge-commit']) {
    assert.ok(existsSync(join(expandedDir, h)), `shim for ${h} should land in the tilde-expanded hooks dir`);
  }
  // The old bug planted shims at a literal `~` directory inside the repo
  // (join(repoRoot, '~/sd-guard-test-hooks')) because it never expanded the
  // tilde itself - assert that dangerous literal directory was never created.
  assert.ok(!existsSync(join(repo, '~')), 'no literal ~ directory should exist in the repo');

  writeState(repo, blockedState());
  const hookResult = spawnSync(join(expandedDir, 'pre-push'), ['origin', 'file:///dev/null'], { cwd: repo, encoding: 'utf8' });
  assert.equal(hookResult.status, 1);
  assert.ok((hookResult.stdout + hookResult.stderr).includes('senior-dev gate: integration blocked'));
});

test('guard pre-push blocks a split verdict even when the approval was recorded last', () => {
  const repo = makeRepo();
  cli(repo, ['guard', 'install']);
  writeState(repo, blockedState({
    phases: { implement: { status: 'done' }, review: { status: 'done' }, verify: { status: 'done' }, docs: { status: 'done' } },
    reviews: [
      { phase: 'implement', reviewer: 'codex', verdict: 'NEEDS_REVISION', cycle: 1 },
      { phase: 'implement', reviewer: 'claude', verdict: 'APPROVED', cycle: 1 },
    ],
    docsGate: { handover: true, affectedDocs: true },
    adjudications: [],
  }));
  const r = hook(repo, 'pre-push');
  assert.notEqual(r.status, 0);
  assert.ok(r.out.includes('NEEDS_REVISION'), r.out);
});

test('guard pre-push allows the push once the rejection is overruled', () => {
  const repo = makeRepo();
  cli(repo, ['guard', 'install']);
  writeState(repo, blockedState({
    phases: { implement: { status: 'done' }, review: { status: 'done' }, verify: { status: 'done' }, docs: { status: 'done' } },
    reviews: [
      { phase: 'implement', reviewer: 'claude', verdict: 'APPROVED', cycle: 1 },
      { phase: 'implement', reviewer: 'codex', verdict: 'NEEDS_REVISION', cycle: 1 },
    ],
    docsGate: { handover: true, affectedDocs: true },
    adjudications: [],
  }));
  assert.notEqual(hook(repo, 'pre-push').status, 0);
  const o = cli(repo, ['review', '--phase', 'implement', '--reviewer', 'codex', '--cycle', '1', '--overrule', '--reason', 'adjudicator: concern is outside the diff']);
  assert.equal(o.status, 0, o.out);
  assert.equal(hook(repo, 'pre-push').status, 0);
});
