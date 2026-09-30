// `state-cli test`: run the configured commands, record every run in state.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  const passed = [], failed = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(xmlText))) {
    const id = `${attr(m[1], 'classname')} > ${attr(m[1], 'name')}`;
    const body = m[3] || '';
    if (/<(failure|error)\b/.test(body)) failed.push(id);
    else if (!/<skipped\b/.test(body)) passed.push(id);
  }
  return { passed, failed };
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
    if (existsSync(real)) copyFileSync(real, tmp);
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

function changedFiles(cwd, base) {
  const list = (args) => gitOut(cwd, args).split('\n').filter(Boolean);
  const out = new Set(list(['ls-files', '--others', '--exclude-standard']));
  for (const f of list(['diff', '--name-only', '--diff-filter=d', base])) out.add(f);
  return [...out].sort();
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
  if (kind === 'affected') {
    if (!t.related) cmdKind = 'full';
    else {
      runFiles = files && files.length ? [...files] : changedFiles(cwd, last('full')?.head || state.baseHead || 'HEAD');
      template = t.related;
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
  if (cmdKind === 'full') template = t.full;

  const nothing = kind === 'affected' && cmdKind === 'affected' && runFiles.length === 0;
  const cmd = nothing ? '' : fill(template, { files: runFiles, test });
  const report = t.report && kind !== 'build' ? resolve(cwd, t.report) : null;
  let exit = 0;
  let parsed = null;
  if (!nothing) {
    if (report) rmSync(report, { force: true });
    const r = spawnSync('sh', ['-c', cmd], { cwd, stdio: 'inherit', env: process.env });
    exit = r.status ?? 1;
    if (report) {
      try { parsed = parseJUnit(readFileSync(report, 'utf8')); } catch { parsed = null; }
    }
  }
  const fulls = state.testRuns.filter((r) => r.kind === 'full');
  const at = new Date().toISOString();
  const run = {
    id: 1 + state.testRuns.reduce((m, r) => Math.max(m, r.id), 0),
    kind: cmdKind,
    cmd,
    files: runFiles,
    test: test ?? null,
    exit,
    failures: parsed ? parsed.failed : null,
    head: headSha(cwd),
    tree: wouldCommitTree(cwd),
    phase,
    sinceFull: fulls.length ? fulls[fulls.length - 1].id : null,
    at,
  };
  state.testRuns.push(run);
  if (exit === 0) state.phases[phase] = { ...(state.phases[phase] || { status: 'in_progress' }), testsGreenAt: at };

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
