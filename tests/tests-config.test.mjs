import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readState, writeState, readSkillsConfig, writeSkillsConfig, validTests } from '../scripts/lib/state.mjs';

const CLI = new URL('../scripts/state-cli.mjs', import.meta.url).pathname;
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-tests-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}
const git = (repo, ...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
function cli(repo, args) {
  try { return { status: 0, out: execFileSync('node', [CLI, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, SENIOR_DEV_OFFLINE: '1' } }) }; }
  catch (e) { return { status: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}

test('set-tests writes a v4 tests block', () => {
  const repo = makeRepo();
  cli(repo, ['skills-config', 'set', '--source', 'superpowers']);
  const r = cli(repo, ['skills-config', 'set-tests', '--full', 'npm test', '--related', 'npx vitest related --run {files}']);
  assert.equal(r.status, 0, r.out);
  const cfg = readSkillsConfig(repo);
  assert.equal(cfg.version, 4);
  assert.deepEqual(cfg.tests, { full: 'npm test', related: 'npx vitest related --run {files}' });
});

test('set-tests --none records a decline', () => {
  const repo = makeRepo();
  assert.equal(cli(repo, ['skills-config', 'set-tests', '--none']).status, 0);
  const cfg = readSkillsConfig(repo);
  assert.equal(cfg.version, 4);
  assert.deepEqual(cfg.tests, { none: true });
});

test('set-tests refuses without --full or --none, both together, and --none with other flags', () => {
  const repo = makeRepo();
  assert.equal(cli(repo, ['skills-config', 'set-tests']).status, 1);
  assert.equal(cli(repo, ['skills-config', 'set-tests', '--related', 'x']).status, 1);
  assert.equal(cli(repo, ['skills-config', 'set-tests', '--full', 'npm test', '--none']).status, 1);
  assert.equal(cli(repo, ['skills-config', 'set-tests', '--none', '--related', 'x']).status, 1);
  assert.equal(readSkillsConfig(repo), null);
});

test('skills-config set keeps the tests block', () => {
  const repo = makeRepo();
  cli(repo, ['skills-config', 'set', '--source', 'superpowers']);
  cli(repo, ['skills-config', 'set-tests', '--full', 'npm test']);
  cli(repo, ['skills-config', 'set', '--source', 'combo']);
  const cfg = readSkillsConfig(repo);
  assert.equal(cfg.source, 'combo');
  assert.deepEqual(cfg.tests, { full: 'npm test' });
  assert.equal(cfg.version, 4);
});

test('a v4 file with an invalid tests block reads as null', () => {
  const repo = makeRepo();
  for (const tests of [{ full: '' }, { full: 1 }, { full: 'x', bogus: 'y' }, { related: 'x' }, { none: true, full: 'x' }]) {
    writeSkillsConfig(repo, { version: 4, source: 'superpowers', shared: false, tests });
    assert.equal(readSkillsConfig(repo), null, JSON.stringify(tests));
  }
  assert.equal(validTests({ full: 'a', one: 'b', report: 'c', setup: 'd', build: 'e' }), true);
});

test('a v3 file still reads', () => {
  const repo = makeRepo();
  writeSkillsConfig(repo, { version: 3, source: 'superpowers', shared: false, models: { steps: { implement: { claude: 'sonnet' } } } });
  assert.equal(readSkillsConfig(repo).version, 3);
});

test('init records baseHead and baseRefs', () => {
  const repo = makeRepo();
  git(repo, 'commit', '--allow-empty', '-q', '-m', 'one');
  git(repo, 'branch', 'other');
  const head = git(repo, 'rev-parse', 'HEAD');
  const main = git(repo, 'symbolic-ref', 'HEAD');
  assert.equal(cli(repo, ['init', '--task', 't', '--type', 'quick-fix']).status, 0);
  const s = readState(repo);
  assert.equal(s.baseHead, head);
  assert.deepEqual(s.baseRefs, { [main]: head, 'refs/heads/other': head });
});

// --- set-tests locked mid-session (v0.4.2 section 3.3) ---
const REFUSAL = "set-tests refused - this session already has test runs; changing the commands now would change what those runs mean. Rerun with --by-operator (the operator's yes) to change them anyway.";
function sessionWithRuns() {
  const repo = makeRepo();
  assert.equal(cli(repo, ['init', '--task', 't', '--type', 'quick-fix']).status, 0);
  assert.equal(cli(repo, ['skills-config', 'set-tests', '--full', 'npm test']).status, 0);
  const s = readState(repo);
  s.testRuns = [{ at: new Date().toISOString(), command: 'npm test', exit: 0 }];
  writeState(repo, s);
  return repo;
}

test('set-tests is refused while the session has test runs', () => {
  const repo = sessionWithRuns();
  const r = cli(repo, ['skills-config', 'set-tests', '--full', 'x']);
  assert.notEqual(r.status, 0);
  assert.ok(r.out.includes(REFUSAL), r.out);
  assert.deepEqual(readSkillsConfig(repo).tests, { full: 'npm test' });
});

test('set-tests --by-operator changes the commands and logs the change', () => {
  const repo = sessionWithRuns();
  const r = cli(repo, ['skills-config', 'set-tests', '--full', 'x', '--by-operator']);
  assert.equal(r.status, 0, r.out);
  const s = readState(repo);
  assert.equal(s.testsConfigChanges.length, 1);
  assert.deepEqual(s.testsConfigChanges[0].from, { full: 'npm test' });
  assert.deepEqual(s.testsConfigChanges[0].to, { full: 'x' });
  assert.deepEqual(readSkillsConfig(repo).tests, { full: 'x' });
  assert.ok(cli(repo, ['status']).out.includes('tests config changed mid-session (1)'));
});

test('set-tests --by-operator rejects a value', () => {
  const repo = sessionWithRuns();
  const r = cli(repo, ['skills-config', 'set-tests', '--full', 'x', '--by-operator', 'yes']);
  assert.notEqual(r.status, 0);
  assert.ok(r.out.includes('set-tests --by-operator does not take a value'), r.out);
});

test('set-tests is unchanged for a session with no runs and for no session', () => {
  const repo = makeRepo();
  assert.equal(cli(repo, ['init', '--task', 't', '--type', 'quick-fix']).status, 0);
  assert.equal(cli(repo, ['skills-config', 'set-tests', '--full', 'x']).status, 0);
  assert.equal(readState(repo).testsConfigChanges, undefined);
  assert.equal(cli(makeRepo(), ['skills-config', 'set-tests', '--full', 'x']).status, 0);
});

test('init in a repo with no commits records null baseHead and empty baseRefs', () => {
  const repo = makeRepo();
  assert.equal(cli(repo, ['init', '--task', 't', '--type', 'quick-fix']).status, 0);
  const s = readState(repo);
  assert.equal(s.baseHead, null);
  assert.deepEqual(s.baseRefs, {});
});
