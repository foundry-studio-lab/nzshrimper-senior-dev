import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildPrompt, parseVerdict, timeoutMs, findCompanion } from '../scripts/review-run.mjs';

const RUNNER = new URL('../scripts/review-run.mjs', import.meta.url).pathname;
const V = '{"verdict":"NEEDS_REVISION","concerns":[{"id":"1","file":"a.js","line":1,"text":"bug"}]}';
const TOOLS = 'Read,Grep,Glob,Bash(git diff:*),Bash(git show:*),Bash(git log:*)';
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

// One fake body serves both lanes: it logs its argv, bumps an attempt counter
// and acts on FAKE_MODE (comma list, one mode per attempt; the last repeats).
// It lives outside the repo so its own bookkeeping never trips the write check.
const FAKE = `import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const d = process.env.FAKE_DIR;
appendFileSync(join(d, 'calls.jsonl'), JSON.stringify(process.argv.slice(2)) + '\\n');
const n = (existsSync(join(d, 'n')) ? Number(readFileSync(join(d, 'n'), 'utf8')) : 0) + 1;
writeFileSync(join(d, 'n'), String(n));
const modes = (process.env.FAKE_MODE || 'json').split(',');
const mode = modes[Math.min(n, modes.length) - 1];
const V = ${JSON.stringify(V)};
if (mode === 'json') process.stdout.write('thinking...\\n' + V + '\\n');
if (mode === 'noise') process.stdout.write(V + '\\n\`\`\`\\n');
if (mode === 'prose') process.stdout.write('Looks fine to me overall.\\n');
if (mode === 'hang') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000); process.stdout.write(V + '\\n'); }
if (mode === 'write') { writeFileSync('x.txt', 'oops'); process.stdout.write(V + '\\n'); }
if (mode === 'dirty') { appendFileSync('a.js', 'more'); process.stdout.write(V + '\\n'); }
if (mode === 'auth') { process.stderr.write('Invalid API key · Please run /login\\n'); process.exit(1); }
if (mode === 'verdict-auth') { process.stdout.write(V + '\\n'); process.stderr.write('Please run /login\\n'); process.exit(1); }
if (mode === 'untracked') { appendFileSync('u.txt', 'more'); process.stdout.write(V + '\\n'); }
if (mode === 'state') { mkdirSync('.senior-dev', { recursive: true }); writeFileSync('.senior-dev/state.json', '{}'); process.stdout.write(V + '\\n'); }
if (mode === 'env') { writeFileSync(join(d, 'env'), String(process.env.SENIOR_DEV_REVIEW_RUN)); process.stdout.write(V + '\\n'); }
if (mode === 'verdict-login') { process.stdout.write('{"verdict":"NEEDS_REVISION","concerns":[{"id":"1","text":"login bug: authentication skipped"}]}\\n'); process.exit(1); }
if (mode === 'grandchild') {
  spawn(process.execPath, ['-e', 'setTimeout(() => require("fs").writeFileSync(process.argv[1], "alive"), 2500)', join(d, 'grandchild')], { stdio: 'ignore' });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
}
`;

function setup({ dirty = false } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'sd-rr-'));
  const fake = mkdtempSync(join(tmpdir(), 'sd-rr-fake-'));
  g(repo, 'init', '-q');
  g(repo, 'config', 'user.email', 't@t'); g(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'a.js'), '1');
  g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'init');
  if (dirty) writeFileSync(join(repo, 'a.js'), '2');
  writeFileSync(join(fake, 'fake-companion.mjs'), FAKE);
  const claude = join(fake, 'fake-claude');
  writeFileSync(claude, `#!/usr/bin/env node\nimport(${JSON.stringify(join(fake, 'fake-companion.mjs'))});\n`);
  chmodSync(claude, 0o755);
  return { repo, fake, claude, companion: join(fake, 'fake-companion.mjs') };
}

function run(s, args, { mode = 'json', env = {} } = {}) {
  const r = spawnSync('node', [RUNNER, ...args], {
    cwd: s.repo, encoding: 'utf8',
    env: { ...process.env, FAKE_DIR: s.fake, FAKE_MODE: mode, SENIOR_DEV_CLAUDE_BIN: s.claude,
      SENIOR_DEV_CODEX_COMPANION: s.companion, SENIOR_DEV_REVIEW_TIMEOUT_MS: '1500', ...env },
  });
  return { status: r.status, stdout: r.stdout, out: r.stdout + r.stderr };
}
const calls = (s) => existsSync(join(s.fake, 'calls.jsonl'))
  ? readFileSync(join(s.fake, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : null;
const CLAUDE = ['--reviewer', 'claude', '--model', 'sonnet', '--phase', 'implement', '--range', 'base..HEAD'];
const CODEX = ['--reviewer', 'codex', '--effort', 'high', '--phase', 'implement', '--range', 'base..HEAD'];

test('json after prose lines: verdict alone on stdout, exit 0', () => {
  const s = setup();
  const r = run(s, CLAUDE);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.stdout.trim(), V);
});

test('trailing noise after the JSON line is ignored', () => {
  const s = setup();
  const r = run(s, CLAUDE, { mode: 'noise' });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.stdout.trim(), V);
});

test('prose then json: one fresh retry succeeds', () => {
  const s = setup();
  const r = run(s, CLAUDE, { mode: 'prose,json' });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.stdout.trim(), V);
  assert.equal(calls(s).length, 2);
});

test('prose twice: exit 3 with the exact degrade line', () => {
  const s = setup();
  const r = run(s, CLAUDE, { mode: 'prose' });
  assert.equal(r.status, 3, r.out);
  assert.ok(r.stdout.includes('state-cli degrade --wanted "claude review (phase implement)" --used none --reason "no JSON verdict twice"'), r.out);
});

test('hang twice: Node-enforced timeout, exit 3 timed out twice', () => {
  const s = setup();
  const t0 = Date.now();
  const r = run(s, CLAUDE, { mode: 'hang' });
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /timed out twice/);
  assert.equal(calls(s).length, 2);
  assert.ok(Date.now() - t0 < 9000, 'the fakes were killed, not waited out');
});

test('mixed failures name both: timeout then prose', () => {
  const s = setup();
  const r = run(s, CLAUDE, { mode: 'hang,prose' });
  assert.equal(r.status, 3, r.out);
  assert.match(r.stdout, /--reason "timed out \([^)]*\), then no JSON verdict"/);
});

test('a reviewer that writes a file: exit 4, no retry', () => {
  const s = setup();
  const r = run(s, CLAUDE, { mode: 'write' });
  assert.equal(r.status, 4, r.out);
  assert.ok(r.stdout.startsWith('WRITE DETECTED: claude changed the repo during a read-only review'), r.out);
  assert.match(r.stdout, /status/);
  assert.equal(calls(s).length, 1);
});

test('a write to an already-dirty file is caught by the diff hash', () => {
  const s = setup({ dirty: true });
  const r = run(s, CLAUDE, { mode: 'dirty' });
  assert.equal(r.status, 4, r.out);
  assert.match(r.stdout, /diff/);
  assert.ok(!/\bstatus\b/.test(r.stdout.split('\n')[1] || ''), 'status itself did not change');
});

// Final review F3: an untracked edit leaves status and `diff HEAD` unchanged;
// the would-commit tree hash covers it. The senior-dev state file is
// deliberately not compared (see the next test).
test('an edit to a pre-existing untracked file is caught: exit 4', () => {
  const s = setup();
  writeFileSync(join(s.repo, 'u.txt'), 'u');
  const r = run(s, CLAUDE, { mode: 'untracked' });
  assert.equal(r.status, 4, r.out);
  assert.match(r.stdout, /changed: .*tree/);
});

// Wave 2 N2 (controller ruling): the conductor's own `state-cli waiting` and
// the headless Stop hook write state during a review; that is not a reviewer write.
test('a write to the git-ignored senior-dev state file does NOT trip the write check', () => {
  const s = setup();
  writeFileSync(join(s.repo, '.git', 'info', 'exclude'), '.senior-dev/\n');
  const r = run(s, CLAUDE, { mode: 'state' });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.stdout.trim(), V);
});

// Wave 3: a snapshot that cannot be taken in a git repo degrades; it never
// fails open to an empty value. An unreadable untracked file breaks `git add -A`.
test('a write-check snapshot error in a git repo: exit 3 before any reviewer runs', { skip: process.getuid?.() === 0 }, () => {
  const s = setup();
  writeFileSync(join(s.repo, 'locked.txt'), 'x');
  chmodSync(join(s.repo, 'locked.txt'), 0o000);
  const r = run(s, CLAUDE);
  chmodSync(join(s.repo, 'locked.txt'), 0o644);
  assert.equal(r.status, 3, r.out);
  assert.match(r.stdout, /--used none --reason "write check failed: [^"]+"/);
  assert.equal(calls(s), null, 'the reviewer was never spawned');
});

test('outside a git repo the write check stays empty (no degrade on that alone)', () => {
  const s = setup();
  const plain = mkdtempSync(join(tmpdir(), 'sd-rr-plain-'));
  const r = spawnSync('node', [RUNNER, ...CLAUDE], {
    cwd: plain, encoding: 'utf8',
    env: { ...process.env, FAKE_DIR: s.fake, FAKE_MODE: 'json', SENIOR_DEV_CLAUDE_BIN: s.claude, SENIOR_DEV_REVIEW_TIMEOUT_MS: '1500' },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), V);
});

// Wave 2 N3: hooks inside the headless reviewer stand down on this env.
test('the reviewer child sees SENIOR_DEV_REVIEW_RUN=1 in both lanes', () => {
  for (const lane of [CLAUDE, CODEX]) {
    const s = setup();
    const r = run(s, lane, { mode: 'env' });
    assert.equal(r.status, 0, r.out);
    assert.equal(readFileSync(join(s.fake, 'env'), 'utf8'), '1');
  }
});

// Wave 2 N4: auth is read from stderr only; a verdict mentioning login is a verdict.
test('non-zero exit with a verdict whose concern mentions login, stderr empty: the verdict, exit 0', () => {
  const s = setup();
  const r = run(s, CLAUDE, { mode: 'verdict-login' });
  assert.equal(r.status, 0, r.out);
  assert.equal(JSON.parse(r.stdout).verdict, 'NEEDS_REVISION');
  assert.equal(calls(s).length, 1);
});

// Wave 2 N1: interrupting the runner takes the detached reviewer group down too.
test('SIGTERM to the runner kills the reviewer group and exits 143', async () => {
  const s = setup();
  const child = spawn('node', [RUNNER, ...CLAUDE], {
    cwd: s.repo, stdio: 'ignore',
    env: { ...process.env, FAKE_DIR: s.fake, FAKE_MODE: 'grandchild', SENIOR_DEV_CLAUDE_BIN: s.claude, SENIOR_DEV_REVIEW_TIMEOUT_MS: '20000' },
  });
  const exited = new Promise((res) => child.on('exit', (code, sig) => res({ code, sig })));
  const t0 = Date.now();
  while (!existsSync(join(s.fake, 'calls.jsonl')) && Date.now() - t0 < 5000) await sleep(50);
  await sleep(300); // the fake has spawned its grandchild
  child.kill('SIGTERM');
  const { code } = await exited;
  assert.equal(code, 143);
  await sleep(2500); // the grandchild would write 2.5 s after it started, >= 0.3 s before the kill
  assert.equal(existsSync(join(s.fake, 'grandchild')), false, 'the grandchild outlived the interrupted runner');
});

// Final review F4: the timeout kills the reviewer's whole process group.
test('timeout kills the reviewer process group, grandchildren included', () => {
  const s = setup();
  const r = run(s, CLAUDE, { mode: 'grandchild,prose' });
  assert.equal(r.status, 3, r.out);
  assert.match(r.stdout, /--reason "timed out \([^)]*\), then no JSON verdict"/);
  // The grandchild would write 2.5 s after it started; the runner returns after >= 1.5 s (timeout) + attempt 2.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  assert.equal(existsSync(join(s.fake, 'grandchild')), false, 'the grandchild outlived the timeout');
});

// Final review F5: auth failure wins over a verdict-shaped line.
test('a verdict line then a login failure with non-zero exit: exit 3 not logged in, one call', () => {
  const s = setup();
  const r = run(s, CLAUDE, { mode: 'verdict-auth' });
  assert.equal(r.status, 3, r.out);
  assert.match(r.stdout, /--reason "claude CLI not logged in"/);
  assert.equal(calls(s).length, 1);
});

// Final review F8: only ENOENT is "not found".
test('a reviewer binary that cannot be executed: failed to start (EACCES)', () => {
  const s = setup();
  const bin = join(s.fake, 'noexec');
  writeFileSync(bin, '#!/bin/sh\n');
  const r = run(s, CLAUDE, { env: { SENIOR_DEV_CLAUDE_BIN: bin } });
  assert.equal(r.status, 3, r.out);
  assert.match(r.stdout, /--reason "claude CLI failed to start \(EACCES\)"/);
});

// Final review F7: a copy of the scripts with no review-prompt.md beside them.
test('an unexpected error (prompt template unreadable) is a degrade line, exit 3', () => {
  const s = setup();
  const root = mkdtempSync(join(tmpdir(), 'sd-rr-copy-'));
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  for (const f of ['review-run.mjs', 'lib/test-runner.mjs', 'lib/state.mjs']) {
    writeFileSync(join(root, 'scripts', f), readFileSync(new URL(`../scripts/${f}`, import.meta.url)));
  }
  const r = spawnSync('node', [join(root, 'scripts', 'review-run.mjs'), ...CLAUDE], { cwd: s.repo, encoding: 'utf8' });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /--used none --reason "unexpected error: ENOENT[^"]*review-prompt\.md[^"]*"/);
  assert.equal(r.stderr, '');
});

test('missing claude binary: exit 3 claude CLI not found', () => {
  const s = setup();
  const r = run(s, CLAUDE, { env: { SENIOR_DEV_CLAUDE_BIN: '/nonexistent/claude' } });
  assert.equal(r.status, 3, r.out);
  assert.match(r.stdout, /--reason "claude CLI not found"/);
});

test('claude not logged in: exit 3, no retry', () => {
  const s = setup();
  const r = run(s, CLAUDE, { mode: 'auth' });
  assert.equal(r.status, 3, r.out);
  assert.match(r.stdout, /--reason "claude CLI not logged in"/);
  assert.equal(calls(s).length, 1);
});

test('claude argv is the exact read-only command with the filled prompt last', () => {
  const s = setup();
  run(s, [...CLAUDE, '--spec', 'docs/s.md']);
  const argv = calls(s)[0];
  assert.deepEqual(argv.slice(0, -1), ['-p', '--model', 'sonnet', '--permission-mode', 'plan',
    '--allowedTools', TOOLS, '--output-format', 'text']);
  const prompt = argv.at(-1);
  for (const s2 of ['phase implement', 'base..HEAD', 'Spec: docs/s.md']) assert.ok(prompt.includes(s2), s2);
  assert.ok(!/<RANGE>|<PHASE>|<SPEC>|^---$/m.test(prompt));
});

test('codex argv: task --fresh --effort with the filled prompt; spec defaults to none', () => {
  const s = setup();
  const r = run(s, CODEX);
  assert.equal(r.status, 0, r.out);
  const argv = calls(s)[0];
  assert.deepEqual(argv.slice(0, 4), ['task', '--fresh', '--effort', 'high']);
  assert.ok(argv[4].includes('phase implement') && argv[4].includes('Spec: none.'));
});

test('missing codex companion: exit 3 companion script not found', () => {
  const s = setup();
  const r = run(s, CODEX, { env: { SENIOR_DEV_CODEX_COMPANION: '/nonexistent/codex-companion.mjs' } });
  assert.equal(r.status, 3, r.out);
  assert.match(r.stdout, /--wanted "codex review \(phase implement\)" --used none --reason "codex companion script not found"/);
});

test('usage errors exit 2 before any reviewer runs', () => {
  const s = setup();
  let r = run(s, ['--reviewer', 'claude', '--phase', 'implement', '--range', 'a..b']);
  assert.equal(r.status, 2); assert.match(r.out, /--model/);
  r = run(s, ['--reviewer', 'codex', '--phase', 'implement', '--range', 'a..b']);
  assert.equal(r.status, 2); assert.match(r.out, /--effort/);
  r = run(s, ['--reviewer', 'gemini', '--phase', 'implement', '--range', 'a..b']);
  assert.equal(r.status, 2);
  r = run(s, ['--reviewer', 'claude', '--model', 'sonnet', '--range', 'a..b']);
  assert.equal(r.status, 2); assert.match(r.out, /--phase/);
  r = run(s, [...CLAUDE, '--timeout', 'soon']);
  assert.equal(r.status, 2); assert.match(r.out, /--timeout/);
  assert.equal(calls(s), null);
});

test('timeoutMs: tier defaults, --timeout, env override wins', () => {
  const min = 60_000;
  for (const effort of ['low', 'medium']) assert.equal(timeoutMs({ reviewer: 'codex', effort }, {}), 15 * min);
  for (const model of ['haiku', 'sonnet']) assert.equal(timeoutMs({ reviewer: 'claude', model }, {}), 15 * min);
  assert.equal(timeoutMs({ reviewer: 'codex', effort: 'high' }, {}), 25 * min);
  for (const model of ['opus', 'fable']) assert.equal(timeoutMs({ reviewer: 'claude', model }, {}), 25 * min);
  assert.equal(timeoutMs({ reviewer: 'codex', effort: 'xhigh' }, {}), 40 * min);
  assert.equal(timeoutMs({ reviewer: 'codex', effort: 'xhigh', timeout: '7' }, {}), 7 * min);
  assert.equal(timeoutMs({ reviewer: 'codex', effort: 'xhigh', timeout: '7' }, { SENIOR_DEV_REVIEW_TIMEOUT_MS: '1500' }), 1500);
});

test('parseVerdict takes the last valid verdict line', () => {
  assert.deepEqual(parseVerdict(`x\n${V}\n\`\`\``), JSON.parse(V));
  assert.equal(parseVerdict('{"verdict":"MAYBE","concerns":[]}'), null);
  assert.equal(parseVerdict('{"verdict":"APPROVED"}'), null);
  assert.equal(parseVerdict('prose\n[1]\nnull'), null);
  assert.equal(parseVerdict(`{"verdict":"APPROVED","concerns":[]}\n${V}`).verdict, 'NEEDS_REVISION');
});

test('buildPrompt fills every placeholder between the --- lines only', () => {
  const t = 'header <RANGE>\n---\nphase <PHASE> on <RANGE> and <RANGE>; spec <SPEC>\n---\nfooter';
  assert.equal(buildPrompt(t, { range: 'a..b', phase: 'plan', spec: 'none' }), 'phase plan on a..b and a..b; spec none');
});

test('findCompanion: override first, else newest by path, else null', () => {
  const home = mkdtempSync(join(tmpdir(), 'sd-rr-home-'));
  assert.equal(findCompanion({}, home), null);
  for (const p of ['a/codex/1.0.1', 'b/codex/1.0.3', 'b/codex/1.0.2']) {
    const d = join(home, '.claude/plugins/cache', p, 'scripts');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'codex-companion.mjs'), '');
  }
  assert.equal(findCompanion({}, home), join(home, '.claude/plugins/cache/b/codex/1.0.3/scripts/codex-companion.mjs'));
  assert.equal(findCompanion({ SENIOR_DEV_CODEX_COMPANION: '/x.mjs' }, home), '/x.mjs');
});
