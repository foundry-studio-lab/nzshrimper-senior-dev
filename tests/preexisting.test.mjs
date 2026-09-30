import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readState, writeState, writeSkillsConfig } from '../scripts/lib/state.mjs';

const CLI = new URL('../scripts/state-cli.mjs', import.meta.url).pathname;
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
function cli(cwd, args) {
  try { return { status: 0, out: execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SENIOR_DEV_OFFLINE: '1' } }) }; }
  catch (e) { return { status: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}

const xml = (cases) => `<testsuites><testsuite>${cases.join('')}</testsuite></testsuites>`;
const pass = (n) => `<testcase classname="a.test.js" name="${n}"/>`;
const failing = (n) => `<testcase classname="a.test.js" name="${n}"><failure message="x"/></testcase>`;
const ID = 'a.test.js > X';

// The fake runner reads the COMMITTED result.xml / exit files of whatever
// checkout it runs in, so base and HEAD can behave differently.
// base/head: { report: xml string | null, exit: number }.
function setup({ base, head, tests = {}, branch = false, staleOnBase = null }) {
  const dir = mkdtempSync(join(tmpdir(), 'sd-pe-'));
  const aux = mkdtempSync(join(tmpdir(), 'sd-pe-aux-'));
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 't@t'); g(dir, 'config', 'user.name', 't');
  const runner = join(aux, 'fake.mjs');
  const marker = join(aux, 'marker');
  writeFileSync(runner, `import {readFileSync,writeFileSync,appendFileSync,existsSync,mkdirSync} from 'node:fs';
appendFileSync(${JSON.stringify(marker)}, process.cwd() + ' ' + process.argv.slice(2).join(' ') + '\\n');
if (existsSync('result.xml')) { mkdirSync('.senior-dev', {recursive:true}); writeFileSync('.senior-dev/junit.xml', readFileSync('result.xml', 'utf8')); }
process.exit(Number(readFileSync('exit', 'utf8')));
`);
  const commit = (side, msg) => {
    if (side.report === null) rmSync(join(dir, 'result.xml'), { force: true });
    else writeFileSync(join(dir, 'result.xml'), side.report);
    writeFileSync(join(dir, 'exit'), String(side.exit));
    g(dir, 'add', '-A'); g(dir, 'commit', '-q', '--allow-empty', '-m', msg);
    return g(dir, 'rev-parse', 'HEAD');
  };
  if (staleOnBase) {
    mkdirSync(join(dir, '.senior-dev'), { recursive: true });
    writeFileSync(join(dir, '.senior-dev', 'junit.xml'), staleOnBase);
    g(dir, 'add', '-f', '.senior-dev/junit.xml');
  }
  const baseSha = commit(base, 'base');
  writeSkillsConfig(dir, { version: 4, source: 'superpowers', shared: false, tests: {
    full: `node ${runner} FULL`, one: `node ${runner} ONE {test}`, report: '.senior-dev/junit.xml', ...tests,
  } });
  if (branch) g(dir, 'checkout', '-qb', 'feat');
  cli(dir, ['init', '--task', 't', '--type', 'quick-fix']);
  const headSha = commit(head, 'head');
  const markers = () => (existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { dir, aux, baseSha, headSha, markers };
}
const lastRun = (dir) => readState(dir).testRuns.at(-1);
const worktrees = (dir) => g(dir, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '));

test('fails on base and HEAD -> proven', () => {
  const s = setup({ base: { report: xml([failing('X')]), exit: 1 }, head: { report: xml([failing('X'), pass('Y')]), exit: 1 } });
  const r = cli(s.dir, ['test', '--preexisting', ID]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, new RegExp(`preexisting ${ID}: PROVEN - fails on base ${s.baseSha.slice(0, 7)} and HEAD`));
  const run = lastRun(s.dir);
  assert.equal(run.kind, 'preexisting');
  assert.equal(run.test, ID);
  assert.equal(run.proven, true);
  assert.equal(run.base, s.baseSha);
  assert.equal(run.head, s.headSha);
  assert.equal(readState(s.dir).testRuns.length, 1, 'only the proof run is recorded');
  assert.equal(readState(s.dir).testHistory, undefined, 'internal runs add no history');
  const st = readState(s.dir);
  assert.ok(!Object.values(st.phases).some((p) => p.testsGreenAt), 'never stamps green');
  const m = s.markers();
  assert.equal(m.length, 2);
  assert.match(m[0], /sd-proof-/, 'base run happens in the proof worktree');
  assert.ok(m[1].startsWith(realpathSync(s.dir)), 'HEAD run happens in the checkout');
  assert.ok(m[0].includes(`ONE ${ID}`));
});

test('fails on HEAD only -> not proven, caused by this change', () => {
  const s = setup({ base: { report: xml([pass('X')]), exit: 0 }, head: { report: xml([failing('X')]), exit: 1 } });
  const r = cli(s.dir, ['test', '--preexisting', ID]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, new RegExp(`preexisting ${ID}: NOT PROVEN - caused by this change: passes on base ${s.baseSha.slice(0, 7)}`));
  const run = lastRun(s.dir);
  assert.equal(run.proven, false);
  assert.match(run.reason, /^caused by this change/);
});

test('runner crashes on base -> not proven, absent from the base report', () => {
  const s = setup({ base: { report: null, exit: 1 }, head: { report: xml([failing('X')]), exit: 1 } });
  const r = cli(s.dir, ['test', '--preexisting', ID]);
  assert.equal(r.status, 1, r.out);
  const run = lastRun(s.dir);
  assert.equal(run.proven, false);
  assert.match(run.reason, /^absent from the base report: /);
});

test('test absent from base report -> not proven', () => {
  const s = setup({ base: { report: xml([failing('Other')]), exit: 1 }, head: { report: xml([failing('X')]), exit: 1 } });
  const r = cli(s.dir, ['test', '--preexisting', ID]);
  assert.equal(r.status, 1, r.out);
  assert.equal(lastRun(s.dir).proven, false);
  assert.match(lastRun(s.dir).reason, /^absent from the base report: /);
});

test('passes on HEAD -> nothing to prove', () => {
  const s = setup({ base: { report: xml([failing('X')]), exit: 1 }, head: { report: xml([pass('X')]), exit: 0 } });
  const r = cli(s.dir, ['test', '--preexisting', ID]);
  assert.equal(r.status, 1, r.out);
  assert.equal(lastRun(s.dir).proven, false);
  assert.equal(lastRun(s.dir).reason, 'passes on HEAD - nothing to prove');
});

test('absent from the HEAD report -> not proven', () => {
  const s = setup({ base: { report: xml([failing('X')]), exit: 1 }, head: { report: null, exit: 1 } });
  const r = cli(s.dir, ['test', '--preexisting', ID]);
  assert.equal(r.status, 1, r.out);
  assert.equal(lastRun(s.dir).proven, false);
  assert.match(lastRun(s.dir).reason, /^absent from the HEAD report: /);
});

test('a stale report in the run checkout never proves (HEAD runner writes none)', () => {
  const s = setup({ base: { report: xml([failing('X')]), exit: 1 }, head: { report: null, exit: 1 } });
  mkdirSync(join(s.dir, '.senior-dev'), { recursive: true });
  writeFileSync(join(s.dir, '.senior-dev', 'junit.xml'), xml([failing('X')]));
  const r = cli(s.dir, ['test', '--preexisting', ID]);
  assert.equal(r.status, 1, r.out);
  assert.equal(lastRun(s.dir).proven, false);
  assert.match(lastRun(s.dir).reason, /^absent from the HEAD report: /);
});

test('a stale report committed on base never proves (base runner crashes)', () => {
  const s = setup({
    base: { report: null, exit: 1 }, head: { report: xml([failing('X')]), exit: 1 },
    staleOnBase: xml([failing('X')]),
  });
  const r = cli(s.dir, ['test', '--preexisting', ID]);
  assert.equal(r.status, 1, r.out);
  assert.equal(lastRun(s.dir).proven, false);
  assert.match(lastRun(s.dir).reason, /^absent from the base report: /);
});

test('needs one and report configured', () => {
  const both = { base: { report: xml([failing('X')]), exit: 1 }, head: { report: xml([failing('X')]), exit: 1 } };
  const noOne = setup({ ...both, tests: { one: undefined } });
  const r1 = cli(noOne.dir, ['test', '--preexisting', ID]);
  assert.equal(r1.status, 1);
  assert.match(r1.out, /senior-dev: .*'one'/);
  const noReport = setup({ ...both, tests: { report: undefined } });
  const r2 = cli(noReport.dir, ['test', '--preexisting', ID]);
  assert.equal(r2.status, 1);
  assert.match(r2.out, /senior-dev: .*'report'/);
  assert.equal(noOne.markers().length + noReport.markers().length, 0, 'nothing ran');
});

test('setup runs in the proof worktree with SENIOR_DEV_MAIN set', () => {
  const s0 = mkdtempSync(join(tmpdir(), 'sd-pe-out-'));
  const out = join(s0, 'setup.txt');
  const s = setup({
    base: { report: xml([failing('X')]), exit: 1 }, head: { report: xml([failing('X')]), exit: 1 },
    tests: { setup: `printf '%s\\n%s' "$SENIOR_DEV_MAIN" "$PWD" > ${out}` },
  });
  const r = cli(s.dir, ['test', '--preexisting', ID]);
  assert.equal(r.status, 0, r.out);
  const [main, pwd] = readFileSync(out, 'utf8').split('\n');
  assert.equal(realpathSync(main), realpathSync(s.dir));
  assert.match(pwd, /sd-proof-/);
});

test('the proof worktree is removed even when setup throws', () => {
  const s0 = mkdtempSync(join(tmpdir(), 'sd-pe-out-'));
  const where = join(s0, 'where');
  const s = setup({
    base: { report: xml([failing('X')]), exit: 1 }, head: { report: xml([failing('X')]), exit: 1 },
    tests: { setup: `pwd > ${where}; exit 3` },
  });
  const before = worktrees(s.dir);
  const r = cli(s.dir, ['test', '--preexisting', ID]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /senior-dev: .*setup/);
  const tmp = readFileSync(where, 'utf8').trim();
  assert.match(tmp, /sd-proof-/);
  assert.equal(existsSync(tmp), false, 'temp dir is gone');
  assert.deepEqual(worktrees(s.dir), before);
  assert.equal(s.markers().length, 0, 'no test ran after setup failed');
});

test('pre-0.4 session falls back to merge-base with the default branch', () => {
  const s = setup({ base: { report: xml([pass('X')]), exit: 0 }, head: { report: xml([failing('X')]), exit: 1 }, branch: true });
  const st = readState(s.dir);
  delete st.baseHead;
  writeState(s.dir, st);
  const r = cli(s.dir, ['test', '--preexisting', ID]);
  assert.equal(r.status, 1, r.out);
  const run = lastRun(s.dir);
  assert.equal(run.base, s.baseSha);
  assert.match(run.reason, new RegExp(`caused by this change: passes on base ${s.baseSha.slice(0, 7)}`));
});
