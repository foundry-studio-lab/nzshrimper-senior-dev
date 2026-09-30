import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readState, writeSkillsConfig } from '../scripts/lib/state.mjs';
import { shq, fill, parseJUnit, wouldCommitTree } from '../scripts/lib/test-runner.mjs';

const CLI = new URL('../scripts/state-cli.mjs', import.meta.url).pathname;
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
function cli(cwd, args) {
  try { return { status: 0, out: execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SENIOR_DEV_OFFLINE: '1' } }) }; }
  catch (e) { return { status: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}

const xml = (cases) => `<testsuites><testsuite>${cases.join('')}</testsuite></testsuites>`;
const pass = (c, n) => `<testcase classname="${c}" name="${n}"/>`;
const failing = (c, n) => `<testcase classname="${c}" name="${n}"><failure message="x"/></testcase>`;

// A repo with a committed a.js/b.js, a started session, and a fake runner that
// copies a fixture to .senior-dev/junit.xml (when present), logs cwd + args to a
// marker file and exits with the code in the exit file.
function setup({ tests = {}, related = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sd-tr-'));
  const aux = mkdtempSync(join(tmpdir(), 'sd-tr-aux-'));
  g(dir, 'init', '-q');
  g(dir, 'config', 'user.email', 't@t'); g(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'a.js'), '1'); writeFileSync(join(dir, 'b.js'), '1');
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'init');
  const runner = join(aux, 'fake.mjs');
  writeFileSync(runner, `import {readFileSync,writeFileSync,appendFileSync,existsSync,mkdirSync} from 'node:fs';
const [fx, ex, marker, ...rest] = process.argv.slice(2);
appendFileSync(marker, process.cwd() + ' ' + rest.join(' ') + '\\n');
if (existsSync(fx)) { mkdirSync('.senior-dev', {recursive:true}); writeFileSync('.senior-dev/junit.xml', readFileSync(fx, 'utf8')); }
process.exit(Number(readFileSync(ex, 'utf8')));
`);
  const fx = join(aux, 'fixture.xml'), ex = join(aux, 'exit'), marker = join(aux, 'marker');
  writeFileSync(ex, '0');
  const base = `node ${runner} ${fx} ${ex} ${marker}`;
  const t = { full: `${base} FULL`, one: `${base} ONE {test} {file}|{name}`, report: '.senior-dev/junit.xml', ...tests };
  if (related) t.related = `${base} REL {files}`;
  writeSkillsConfig(dir, { version: 4, source: 'superpowers', shared: false, tests: t });
  cli(dir, ['init', '--task', 't', '--type', 'quick-fix']);
  const setReport = (x) => writeFileSync(fx, x);
  const setExit = (n) => writeFileSync(ex, String(n));
  const markers = () => (existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { dir, aux, fx, setReport, setExit, markers };
}

test('shq round-trips hostile names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-shq-'));
  const s = "a b'$(touch x)";
  const out = execFileSync('sh', ['-c', 'printf %s ' + shq(s)], { cwd: dir, encoding: 'utf8' });
  assert.equal(out, s);
  assert.equal(existsSync(join(dir, 'x')), false);
});

test('fill substitutes files, test, file and name', () => {
  assert.equal(fill('r {files} !', { files: ['a b', 'c'] }), "r 'a b' 'c' !");
  assert.equal(fill('t {test}', { test: "x > y'" }), "t 'x > y'\\'''");
  assert.equal(fill('{file}|{name}', { test: 'f.js > my test > deeper' }), "'f.js'|'my test > deeper'");
  assert.equal(fill('{file}|{name}', { test: 'plain' }), "'plain'|''");
});

test('parseJUnit: pass, failure, error, skipped, entities', () => {
  const x = xml([
    pass('s', 'ok'), failing('s', 'bad'),
    '<testcase classname="s" name="err"><error message="e"/></testcase>',
    '<testcase classname="s" name="sk"><skipped/></testcase>',
    pass('s', 'a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;'),
  ]);
  assert.deepEqual(parseJUnit(x), {
    passed: ['s > ok', `s > a & b <c> "d" 'e'`],
    failed: ['s > bad', 's > err'],
  });
});

test('wouldCommitTree matches HEAD tree after committing and never touches the real index', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-wct-'));
  g(dir, 'init', '-q');
  g(dir, 'config', 'user.email', 't@t'); g(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, '.gitignore'), 'ign.txt\n');
  writeFileSync(join(dir, 'a.js'), '1');
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'i');
  writeFileSync(join(dir, 'a.js'), '2');
  writeFileSync(join(dir, 'new.js'), 'n');
  writeFileSync(join(dir, 'ign.txt'), 'i');
  const tree = wouldCommitTree(dir);
  assert.equal(g(dir, 'diff', '--cached', '--name-only'), '');
  assert.equal(g(dir, 'ls-tree', '-r', '--name-only', tree).split('\n').includes('new.js'), true);
  assert.equal(g(dir, 'ls-tree', '-r', '--name-only', tree).split('\n').includes('ign.txt'), false);
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'two');
  assert.equal(g(dir, 'rev-parse', 'HEAD^{tree}'), tree);
});

test('--full records failures from the report; red run exits 1 and sets no testsGreenAt', () => {
  const t = setup();
  t.setReport(xml([pass('s', 'ok'), failing('s', 'bad')])); t.setExit(1);
  const r = cli(t.dir, ['test', '--full']);
  assert.equal(r.status, 1, r.out);
  const s = readState(t.dir);
  assert.equal(s.testRuns.length, 1);
  const run = s.testRuns[0];
  assert.equal(run.id, 1); assert.equal(run.kind, 'full'); assert.equal(run.exit, 1);
  assert.deepEqual(run.failures, ['s > bad']);
  assert.equal(run.phase, 'implement'); assert.equal(run.sinceFull, null);
  assert.equal(run.head, g(t.dir, 'rev-parse', 'HEAD'));
  assert.equal(run.tree, g(t.dir, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(s.phases.implement?.testsGreenAt, undefined);
});

test('green run stamps testsGreenAt; --build records kind build without parsing', () => {
  const t = setup({ tests: { build: 'true' } });
  t.setReport(xml([failing('s', 'bad')]));
  assert.equal(cli(t.dir, ['test', '--build']).status, 0);
  let s = readState(t.dir);
  assert.equal(s.testRuns[0].kind, 'build'); assert.equal(s.testRuns[0].failures, null);
  assert.equal(s.phases.implement?.testsGreenAt, undefined); // a green build is not a green test run
  assert.equal(cli(t.dir, ['test', '--full']).status, 0);
  assert.ok(readState(t.dir).phases.implement.testsGreenAt);
  s = readState(t.dir);
  assert.equal(s.testRuns[1].id, 2);
});

test('stale report is not parsed', () => {
  const t = setup();
  mkdirSync(join(t.dir, '.senior-dev'), { recursive: true });
  writeFileSync(join(t.dir, '.senior-dev', 'junit.xml'), xml([failing('s', 'stale')]));
  const r = cli(t.dir, ['test', '--full']);
  assert.equal(r.status, 0, r.out);
  const run = readState(t.dir).testRuns[0];
  assert.equal(run.failures, null);
  assert.ok(readState(t.dir).phases.implement.testsGreenAt);
});

test('--affected defaults to files changed since the last full run', () => {
  const t = setup();
  assert.equal(cli(t.dir, ['test', '--full']).status, 0);
  writeFileSync(join(t.dir, 'a.js'), '2');
  writeFileSync(join(t.dir, 'c.js'), 'c');
  const r = cli(t.dir, ['test', '--affected']);
  assert.equal(r.status, 0, r.out);
  const s = readState(t.dir);
  const run = s.testRuns[1];
  assert.equal(run.kind, 'affected');
  assert.deepEqual(run.files, ['a.js', 'c.js']);
  assert.equal(run.sinceFull, 1);
  assert.ok(t.markers().at(-1).endsWith('REL a.js c.js'), t.markers().at(-1));
  assert.notEqual(run.tree, g(t.dir, 'rev-parse', 'HEAD^{tree}')); // would-commit tree includes the edits
});

test('--affected with explicit files uses them', () => {
  const t = setup();
  assert.equal(cli(t.dir, ['test', '--affected', 'x y.js', 'z.js']).status, 0);
  assert.deepEqual(readState(t.dir).testRuns[0].files, ['x y.js', 'z.js']);
  assert.ok(t.markers().at(-1).endsWith('REL x y.js z.js'));
});

test('--affected with no changes records green with files [] and runs nothing', () => {
  const t = setup();
  assert.equal(cli(t.dir, ['test', '--affected']).status, 0);
  const run = readState(t.dir).testRuns[0];
  assert.deepEqual(run.files, []); assert.equal(run.exit, 0);
  assert.deepEqual(t.markers(), []);
  assert.ok(readState(t.dir).phases.implement.testsGreenAt);
});

test('--affected without related falls back to full', () => {
  const t = setup({ related: false });
  writeFileSync(join(t.dir, 'a.js'), '2');
  assert.equal(cli(t.dir, ['test', '--affected']).status, 0);
  assert.equal(readState(t.dir).testRuns[0].kind, 'full');
  assert.ok(t.markers().at(-1).endsWith('FULL'));
});

test('contradiction: fail, pass, fail on one id prints CONTRADICTION and records it', () => {
  const t = setup();
  const oneRun = (rep, exit) => { t.setReport(rep); t.setExit(exit); return cli(t.dir, ['test', '--one', 'f.js > x']); };
  const F = xml([failing('f.js', 'x'), pass('f.js', 'y')]);
  const P = xml([pass('f.js', 'x'), failing('f.js', 'y')]);
  assert.ok(!oneRun(F, 1).out.includes('CONTRADICTION'));
  assert.ok(!oneRun(P, 1).out.includes('CONTRADICTION'));
  const r = oneRun(F, 1);
  assert.match(r.out, /CONTRADICTION: f\.js > x has failed, passed, and failed again this phase/);
  const c = readState(t.dir).contradictions;
  assert.equal(c.length, 1);
  assert.equal(c[0].test, 'f.js > x'); assert.equal(c[0].phase, 'implement'); assert.ok(c[0].at);
  // 'f.js > y' went pass, fail, pass: not a contradiction
  assert.equal(c.some((x) => x.test === 'f.js > y'), false);
  // unresolved: another --one run prints the stop line again
  assert.match(oneRun(P, 1).out, /CONTRADICTION: f\.js > x/);
  assert.equal(readState(t.dir).contradictions.filter((x) => x.test === 'f.js > x').length, 1);
  assert.equal(readState(t.dir).testHistory['f.js > x'].length, 4);
});

test('--resolve clears the stop and records resolved; unknown id exits 1', () => {
  const t = setup();
  const run = (rep, exit) => { t.setReport(rep); t.setExit(exit); return cli(t.dir, ['test', '--one', 'f.js > x']); };
  run(xml([failing('f.js', 'x')]), 1); run(xml([pass('f.js', 'x')]), 0); run(xml([failing('f.js', 'x')]), 1);
  assert.equal(cli(t.dir, ['test', '--resolve', 'nope', '--reason', 'r']).status, 1);
  assert.equal(cli(t.dir, ['test', '--resolve', 'f.js > x']).status, 1); // reason required
  const r = cli(t.dir, ['test', '--resolve', 'f.js > x', '--reason', 'code is right']);
  assert.equal(r.status, 0, r.out);
  const c = readState(t.dir).contradictions[0];
  assert.equal(c.resolved.reason, 'code is right'); assert.ok(c.resolved.at);
  const again = run(xml([failing('f.js', 'x')]), 1);
  assert.ok(!again.out.includes('CONTRADICTION'), again.out);
});

test('runs from a worktree use the worktree checkout', () => {
  const t = setup();
  const wt = join(t.aux, 'wt');
  g(t.dir, 'worktree', 'add', '-q', '-b', 'feat', wt);
  writeFileSync(join(wt, 'w.js'), 'w');
  g(wt, 'add', '-A'); g(wt, 'commit', '-qm', 'w');
  const r = cli(wt, ['test', '--full']);
  assert.equal(r.status, 0, r.out);
  const run = readState(t.dir).testRuns[0];
  assert.equal(run.head, g(wt, 'rev-parse', 'HEAD'));
  assert.notEqual(run.head, g(t.dir, 'rev-parse', 'HEAD'));
  assert.ok(t.markers().at(-1).startsWith(execFileSync('node', ['-p', `require('fs').realpathSync(${JSON.stringify(wt)})`], { encoding: 'utf8' }).trim()), t.markers().at(-1));
});

test('no tests config refuses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-tr-none-'));
  g(dir, 'init', '-q');
  cli(dir, ['init', '--task', 't', '--type', 'quick-fix']);
  const r = cli(dir, ['test', '--full']);
  assert.equal(r.status, 1);
  assert.match(r.out, /senior-dev: no tests config - run skills-config set-tests, or use tests-green/);
  writeSkillsConfig(dir, { version: 4, source: 'superpowers', shared: false, tests: { none: true } });
  assert.equal(cli(dir, ['test', '--full']).status, 1);
});

test('files a run writes do not enter its tree', () => {
  const t = setup({ tests: { report: 'out/junit.xml' } });
  const p = join(t.aux, 'fake.mjs');
  writeFileSync(p, readFileSync(p, 'utf8').replaceAll('.senior-dev', 'out'));
  t.setReport(xml([pass('s', 'ok')]));
  assert.equal(cli(t.dir, ['test', '--full']).status, 0);
  assert.equal(existsSync(join(t.dir, 'out', 'junit.xml')), true);
  const run = readState(t.dir).testRuns[0];
  assert.deepEqual(run.failures, []);
  assert.equal(run.tree, g(t.dir, 'rev-parse', 'HEAD^{tree}'));
});

test('non-ASCII changed files reach {files} unquoted', () => {
  const t = setup();
  writeFileSync(join(t.dir, 'é.js'), 'x');
  assert.equal(cli(t.dir, ['test', '--affected']).status, 0);
  assert.deepEqual(readState(t.dir).testRuns[0].files, ['é.js']);
  assert.ok(t.markers().at(-1).endsWith('REL é.js'));
});

// ---- F2 / F4 ----
test('F2: a deletion-only change runs full and records kind full', () => {
  const t = setup();
  rmSync(join(t.dir, 'b.js'));
  assert.equal(cli(t.dir, ['test', '--affected']).status, 0);
  const run = readState(t.dir).testRuns[0];
  assert.equal(run.kind, 'full'); assert.deepEqual(run.files, []);
  assert.ok(t.markers().at(-1).endsWith('FULL'), t.markers().at(-1));
});

test('F2: a deletion after a full run runs full; a staged rename counts as a deletion', () => {
  const t = setup();
  assert.equal(cli(t.dir, ['test', '--full']).status, 0);
  g(t.dir, 'mv', 'b.js', 'd.js');
  assert.equal(cli(t.dir, ['test', '--affected']).status, 0);
  assert.equal(readState(t.dir).testRuns[1].kind, 'full');
  assert.equal(t.markers().length, 2);
});

test('F2: unchanged tree after a full run runs nothing and records green', () => {
  const t = setup();
  assert.equal(cli(t.dir, ['test', '--full']).status, 0);
  assert.equal(cli(t.dir, ['test', '--affected']).status, 0);
  const run = readState(t.dir).testRuns[1];
  assert.equal(run.kind, 'affected'); assert.deepEqual(run.files, []); assert.equal(run.exit, 0);
  assert.equal(t.markers().length, 1);
});

test('F2: empty file list at a tree other than the full run\'s runs full', () => {
  const t = setup();
  writeFileSync(join(t.dir, 'a.js'), '2');
  assert.equal(cli(t.dir, ['test', '--full']).status, 0); // full at the uncommitted tree
  writeFileSync(join(t.dir, 'a.js'), '1'); // back to HEAD: no diff vs full.head, other tree
  assert.equal(cli(t.dir, ['test', '--affected']).status, 0);
  assert.equal(readState(t.dir).testRuns[1].kind, 'full');
  assert.equal(t.markers().length, 2);
});

test('F4: explicit --affected files are unioned with the changed files', () => {
  const t = setup();
  writeFileSync(join(t.dir, 'a.js'), '2');
  assert.equal(cli(t.dir, ['test', '--affected', 'unrelated.js']).status, 0);
  assert.deepEqual(readState(t.dir).testRuns[0].files, ['a.js', 'unrelated.js']);
  assert.ok(t.markers().at(-1).endsWith('REL a.js unrelated.js'));
});
