// `state-cli test`: run the configured commands, record every run in state.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, existsSync, rmSync, readFileSync, statSync, utimesSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { currentPhase, headTree } from './state.mjs';

export { headTree };

export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function fill(template, { files, test } = {}) {
  const id = test ?? '';
  const i = id.indexOf(' > ');
  const file = i < 0 ? id : id.slice(0, i);
  const name = i < 0 ? '' : id.slice(i + 3);
  const vals = { files: (files || []).map(shq).join(' '), test: shq(id), file: shq(file), name: shq(name) };
  return template.replace(/\{(files|test|file|name)\}/g, (_, k) => vals[k]);
}

const decode = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g,
  (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e]);
const attr = (tag, k) => {
  const m = new RegExp(`\\s${k}="([^"]*)"`).exec(tag);
  return m ? decode(m[1]) : '';
};

export function parseJUnit(xmlText) {
  const passed = [], failed = [], skipped = [], files = {};
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(xmlText))) {
    const id = `${attr(m[1], 'classname')} > ${attr(m[1], 'name')}`;
    const body = m[3] || '';
    if (/<(failure|error)\b/.test(body)) {
      failed.push(id);
      // The `file` attribute (node's reporter) tells same-named tests apart.
      if (/\sfile="/.test(m[1])) (files[id] = files[id] || []).push(attr(m[1], 'file'));
    } else if (/<skipped\b/.test(body)) skipped.push(id);
    else passed.push(id);
  }
  return { passed, failed, skipped, files };
}

const gitOut = (cwd, args, env) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: env ? { ...process.env, ...env } : process.env,
}).trim();

// The tree the working state would commit as, via a throwaway index.
export function wouldCommitTree(cwd) {
  const dir = mkdtempSync(join(tmpdir(), 'sd-idx-'));
  const tmp = join(dir, 'index');
  try {
    const real = gitOut(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    if (existsSync(real)) {
      copyFileSync(real, tmp);
      // Keep the index's mtime: git treats entries at or after it as racily
      // clean and re-hashes them; a fresh copy mtime makes it trust stale stat.
      const st = statSync(real);
      utimesSync(tmp, st.atime, st.mtime);
    }
    const env = { GIT_INDEX_FILE: tmp };
    gitOut(cwd, ['add', '-A'], env);
    return gitOut(cwd, ['write-tree'], env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function headSha(cwd) {
  try { return gitOut(cwd, ['rev-parse', 'HEAD']); } catch { return null; }
}

// Files changed since `base` (plus untracked), and whether any was deleted.
// --no-renames: a renamed-away path is a deletion (its importers break).
function changedFiles(cwd, base) {
  // -z: git otherwise C-quotes non-ASCII paths.
  const list = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
  const out = new Set(list(['ls-files', '-z', '--others', '--exclude-standard']));
  for (const f of list(['diff', '-z', '--name-only', '--no-renames', '--diff-filter=d', base])) out.add(f);
  const deleted = list(['diff', '-z', '--name-only', '--no-renames', '--diff-filter=D', base]).length > 0;
  return { files: [...out], deleted };
}

// fail -> pass -> fail as a subsequence of the outcomes.
function contradicts(oks) {
  let stage = 0;
  for (const ok of oks) {
    if (stage === 0 && !ok) stage = 1;
    else if (stage === 1 && ok) stage = 2;
    else if (stage === 2 && !ok) return true;
  }
  return false;
}

// Run one shell command, parsing `report` (deleted first) when given.
function exec(cmd, cwd, report, env) {
  if (report) rmSync(report, { force: true });
  const r = spawnSync('sh', ['-c', cmd], { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
  let parsed = null;
  if (report) {
    try { parsed = parseJUnit(readFileSync(report, 'utf8')); } catch { parsed = null; }
  }
  return { exit: r.status ?? 1, parsed };
}

function runBase(state) {
  const fulls = state.testRuns.filter((r) => r.kind === 'full');
  return {
    id: 1 + state.testRuns.reduce((m, r) => Math.max(m, r.id), 0),
    sinceFull: fulls.length ? fulls[fulls.length - 1].id : null,
  };
}

const line = (t) => `CONTRADICTION: ${t} has failed, passed, and failed again this phase`;

export function runTest({ repoRoot, cwd, state, cfg, kind, files, test }) {
  const t = cfg.tests;
  const phase = currentPhase(state);
  if (!phase) throw new Error('all phases already done');
  state.testRuns = state.testRuns || [];
  const last = (k) => [...state.testRuns].reverse().find((r) => r.kind === k);

  let cmdKind = kind;
  let runFiles = [];
  let template;
  let deleted = false;
  if (kind === 'affected') {
    if (!t.related) cmdKind = 'full';
    else {
      const changed = changedFiles(cwd, last('full')?.head || state.baseHead || 'HEAD');
      deleted = changed.deleted;
      // Explicit files add to the changed list, never replace it.
      runFiles = [...new Set([...(files || []), ...changed.files])].sort();
      template = t.related;
      if (deleted) { cmdKind = 'full'; runFiles = []; }
    }
  }
  if (kind === 'one') {
    if (!t.one) throw new Error("no 'one' command configured - run skills-config set-tests --one");
    template = t.one;
  }
  if (kind === 'build') {
    if (!t.build) throw new Error("no 'build' command configured - run skills-config set-tests --build");
    template = t.build;
  }
  const report = t.report && kind !== 'build' ? resolve(cwd, t.report) : null;
  if (report) rmSync(report, { force: true });
  // Snapshot head/tree BEFORE the command: files it writes must not enter the tree.
  const head = headSha(cwd);
  const tree = wouldCommitTree(cwd);

  // An empty list is "nothing to run" only at the latest full run's tree, or
  // with no full run yet when nothing changed since baseHead; else run full.
  let nothing = false;
  if (kind === 'affected' && cmdKind === 'affected' && runFiles.length === 0) {
    const F = last('full');
    nothing = F ? F.tree === tree && F.exit === 0 : typeof state.baseHead === 'string';
    if (!nothing) cmdKind = 'full';
  }
  if (cmdKind === 'full') template = t.full;
  const cmd = nothing ? '' : fill(template, { files: runFiles, test });
  const { exit, parsed } = nothing ? { exit: 0, parsed: null } : exec(cmd, cwd, report);
  const at = new Date().toISOString();
  const run = {
    ...runBase(state), kind: cmdKind, cmd, files: runFiles, test: test ?? null, exit,
    failures: parsed ? parsed.failed : null, passedCount: parsed ? parsed.passed.length : null, head, tree, phase, at,
  };
  state.testRuns.push(run);
  if (exit === 0 && kind !== 'build') state.phases[phase] = { ...(state.phases[phase] || { status: 'in_progress' }), testsGreenAt: at };

  state.testHistory = state.testHistory || {};
  state.contradictions = state.contradictions || [];
  if (parsed) {
    for (const [ids, ok] of [[parsed.passed, true], [parsed.failed, false]]) {
      for (const id of ids) (state.testHistory[id] = state.testHistory[id] || []).push({ phase, ok, run: run.id });
    }
    for (const id of new Set([...parsed.passed, ...parsed.failed])) {
      const floor = Math.max(0, ...state.contradictions
        .filter((c) => c.test === id && c.phase === phase && c.resolved).map((c) => c.resolvedAfterRun || 0));
      const oks = state.testHistory[id].filter((h) => h.phase === phase && h.run > floor).map((h) => h.ok);
      if (contradicts(oks) && !state.contradictions.some((c) => c.test === id && c.phase === phase && !c.resolved)) {
        state.contradictions.push({ test: id, phase, at, run: run.id });
        console.log(line(id));
      }
    }
  }
  return { run, exit };
}

function baseCommit(cwd, state) {
  if (state.baseHead) return state.baseHead;
  let def = 'main';
  try { def = gitOut(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, ''); } catch { /* keep main */ }
  try { return gitOut(cwd, ['merge-base', 'HEAD', def]); } catch { throw new Error(`no base commit: session has no baseHead and 'git merge-base HEAD ${def}' failed`); }
}

// Prove `test` fails on the base commit too. Only a FAILED entry in both
// reports proves it; a missing test (crash, deps, new test) never does.
// `cwd` is the run checkout's root (SENIOR_DEV_MAIN for setup).
export function provePreexisting({ cwd, state, cfg, test }) {
  const t = cfg.tests;
  if (!t.one) throw new Error("test --preexisting needs a 'one' command - run skills-config set-tests --one");
  if (!t.report) throw new Error("test --preexisting needs a 'report' path - run skills-config set-tests --report");
  const phase = currentPhase(state);
  if (!phase) throw new Error('all phases already done');
  state.testRuns = state.testRuns || [];
  const base = baseCommit(cwd, state);
  const sha7 = base.slice(0, 7);
  const cmd = fill(t.one, { test });
  const headReport = resolve(cwd, t.report);
  rmSync(headReport, { force: true });
  const head = headSha(cwd);
  const tree = wouldCommitTree(cwd);

  const tmp = mkdtempSync(join(tmpdir(), 'sd-proof-'));
  const tmpReal = realpathSync(tmp); // reporters write realpaths (/private/var on macOS)
  let onBase;
  let added = false;
  try {
    gitOut(cwd, ['worktree', 'add', '--detach', tmp, base]);
    added = true;
    if (t.setup) {
      const s = spawnSync('sh', ['-c', t.setup], { cwd: tmp, stdio: 'inherit', env: { ...process.env, SENIOR_DEV_MAIN: cwd } });
      if (s.status !== 0) throw new Error(`setup failed in the proof worktree (exit ${s.status ?? 'signal'})`);
    }
    onBase = exec(cmd, tmp, resolve(tmp, t.report));
  } finally {
    if (added) {
      try { gitOut(cwd, ['worktree', 'remove', '--force', tmp]); } catch { /* warned below */ }
      try { gitOut(cwd, ['worktree', 'prune']); } catch { /* warned below */ }
    } else rmSync(tmp, { recursive: true, force: true });
    if (existsSync(tmp)) console.error(`senior-dev: warning: proof worktree left behind at ${tmp}`);
  }
  const onHead = exec(cmd, cwd, headReport);

  const where = (p, id) => (!p ? 'no parseable report' : p.failed.includes(id) ? 'failed' : p.passed.includes(id) ? 'passed' : 'test not in report');
  // Two testcases sharing an id (node's reporter gives every file classname
  // "test") could let one test's base failure prove another's: never prove.
  const count = (p, id) => (p ? [...p.failed, ...p.passed, ...(p.skipped || [])].filter((x) => x === id).length : 0);
  const shared = [['HEAD', onHead.parsed], ['base', onBase.parsed]].find(([, p]) => count(p, test) > 1);
  const h = where(onHead.parsed, test);
  const b = where(onBase.parsed, test);
  let proven = false;
  let reason;
  // Same id from a different file (a test deleted on base, a same-named one
  // added on HEAD) is a different test. Paths are compared per checkout.
  const rel = (f, roots) => {
    const r = roots.find((x) => f.startsWith(x + sep));
    return r ? f.slice(r.length + 1) : f;
  };
  const fileOf = (p, roots) => (p?.files?.[test] || []).map((f) => rel(f, roots)).join(',');
  const real = (p) => { try { return realpathSync(p); } catch { return p; } };
  const hf = fileOf(onHead.parsed, [cwd, real(cwd)]);
  const bf = fileOf(onBase.parsed, [tmp, tmpReal]);
  if (shared) reason = `ambiguous id: ${count(shared[1], test)} testcases in the ${shared[0]} report share it - make test names unique`;
  else if (h === 'passed') reason = 'passes on HEAD - nothing to prove';
  else if (h !== 'failed') reason = `absent from the HEAD report: ${h} (exit ${onHead.exit})`;
  // Both sides without a file attribute compare equal (id-only runners);
  // a file on one side only is identity not established: refuse.
  else if (b === 'failed' && hf !== bf) reason = `different test: fails from ${bf || '(no file)'} on base, ${hf || '(no file)'} on HEAD`;
  else if (b === 'failed') { proven = true; reason = `fails on base ${sha7} and HEAD`; }
  else if (b === 'passed') reason = `caused by this change: passes on base ${sha7}`;
  else reason = `absent from the base report: ${b} (exit ${onBase.exit})`;

  const run = {
    ...runBase(state), kind: 'preexisting', cmd, files: [], test, exit: onHead.exit,
    failures: onHead.parsed ? onHead.parsed.failed : null, head, tree, phase,
    at: new Date().toISOString(), proven, reason, base,
  };
  state.testRuns.push(run);
  return { proven, reason, run };
}

// Reprint the stop line for every unresolved contradiction (--one / --affected)
// except those just detected by run `runId`, which runTest already printed.
export function reprintContradictions(state, runId) {
  for (const c of state.contradictions || []) {
    if (!c.resolved && c.run !== runId) console.log(line(c.test));
  }
}

export function resolveContradiction(state, id, reason) {
  const c = (state.contradictions || []).find((x) => x.test === id && !x.resolved);
  if (!c) throw new Error(`no unresolved contradiction for '${id}'`);
  c.resolved = { reason, at: new Date().toISOString() };
  c.resolvedAfterRun = (state.testRuns || []).reduce((m, r) => Math.max(m, r.id), 0);
  return c;
}
