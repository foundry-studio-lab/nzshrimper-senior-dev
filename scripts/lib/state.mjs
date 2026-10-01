// Shared state for the senior-dev orchestrator. Single source of truth for
// lane definitions and gate logic; hooks and the CLI both import from here.
import { execFileSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';

export const CHAINS = {
  'feature':       ['brainstorm', 'worktree', 'plan', 'implement', 'review', 'verify', 'docs', 'finish'],
  'bug-fix':       ['debug', 'implement', 'review', 'verify', 'docs', 'finish'],
  'refactor':      ['worktree', 'plan', 'implement', 'review', 'verify', 'docs', 'finish'],
  'quick-fix':     ['implement', 'review', 'verify', 'docs', 'finish'],
  'docs-only':     ['implement', 'review', 'docs', 'finish'],
  'investigation': ['investigate', 'finish'],
};

// Own-key check: `CHAINS['constructor']` is truthy, so a bare lookup is not a lane test.
export const isLane = (t) => typeof t === 'string' && Object.hasOwn(CHAINS, t);

// false = required and missing; true = done; null = waived for this lane.
export const DOCS_GATE = {
  'feature':       { spec: false, plan: false, handover: false, affectedDocs: false },
  'refactor':      { spec: false, plan: false, handover: false, affectedDocs: false },
  'bug-fix':       { handover: false, affectedDocs: false },
  'quick-fix':     { handover: false, affectedDocs: false },
  'docs-only':     { handover: false },
  'investigation': {},
};

// How much process a lane demands; `reclassify` needs the operator to lower it.
export const LANE_RANK = { investigation: 0, 'docs-only': 1, 'quick-fix': 2, 'bug-fix': 3, refactor: 3, feature: 4 };

// Lanes where a recorded review is not demanded before integration.
const REVIEW_EXEMPT = new Set(['docs-only', 'investigation']);

// Resolves the MAIN checkout root, not the cwd's worktree root: inside a
// linked worktree (`git worktree add`), `git rev-parse --show-toplevel`
// returns the WORKTREE's own root, which has no .senior-dev/state.json -
// that made the CLI and both hard gates go inert from the feature lane's
// standard worktree flow. `--git-common-dir` instead always points at the
// ONE shared .git directory: for the main checkout that's <root>/.git, and
// for every linked worktree it's still <main>/.git, so its dirname is the
// main checkout root in both cases. Falls back to --show-toplevel if
// --path-format is unsupported by the installed git rather than breaking.
export function findRepoRoot(cwd = process.cwd()) {
  try {
    const out = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    if (out) return dirname(out);
  } catch {
    // fall through to the --show-toplevel fallback below
  }
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

// The tree of HEAD (or `rev`) in the checkout at cwd; null when there are
// no commits or git fails.
export function headTree(cwd, rev = 'HEAD') {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '-q', `${rev}^{tree}`], {
      cwd, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim() || null;
  } catch {
    return null;
  }
}

export function statePath(repoRoot) {
  return join(repoRoot, '.senior-dev', 'state.json');
}

export const VALID_SOURCES = ['own', 'superpowers', 'combo', 'suggest'];

export const CLAUDE_TIERS = ['haiku', 'sonnet', 'opus', 'fable'];
export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
export const TIER_RANK = Object.fromEntries(CLAUDE_TIERS.map((t, i) => [t, i]));
// Every phase from every chain (chain order, deduplicated), then the
// adjudicate pseudo-phase - the only non-chain key the models map accepts.
export const MODEL_PHASES = [...new Set([...Object.values(CHAINS).flat(), 'adjudicate'])];
// Built-in "Balanced" floors. Phases absent here run inline on the controller.
export const DEFAULT_MODELS = {
  implement:  { claude: 'sonnet' },
  review:     { claude: 'sonnet', codex: 'medium' },
  debug:      { claude: 'opus' },
  finish:     { claude: 'opus', codex: 'high' },
  adjudicate: { claude: 'fable' },
};

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function validModelEntry(v) {
  if (!isPlainObject(v)) return false;
  for (const [k, val] of Object.entries(v)) {
    if (k === 'claude') { if (!CLAUDE_TIERS.includes(val)) return false; }
    else if (k === 'codex') { if (!CODEX_EFFORTS.includes(val)) return false; }
    else return false;
  }
  return true;
}
function validModelMap(m) {
  if (!isPlainObject(m)) return false;
  return Object.entries(m).every(([phase, entry]) => MODEL_PHASES.includes(phase) && validModelEntry(entry));
}
export function validModels(models) {
  if (!isPlainObject(models)) return false;
  if (!Object.keys(models).every((k) => k === 'steps' || k === 'lanes')) return false;
  if (models.steps !== undefined && !validModelMap(models.steps)) return false;
  if (models.lanes !== undefined) {
    if (!isPlainObject(models.lanes)) return false;
    if (!Object.entries(models.lanes).every(([lane, m]) => CHAINS[lane] && validModelMap(m))) return false;
  }
  return true;
}

const TEST_KEYS = ['related', 'one', 'report', 'setup', 'build'];
export function validTests(t) {
  if (!isPlainObject(t)) return false;
  const keys = Object.keys(t);
  if (keys.length === 1 && keys[0] === 'none') return t.none === true;
  return typeof t.full === 'string' && t.full !== ''
    && keys.every((k) => k === 'full' || (TEST_KEYS.includes(k) && typeof t[k] === 'string'));
}

export function skillsConfigPath(repoRoot) {
  return join(repoRoot, '.senior-dev', 'skills.json');
}

export function readSkillsConfig(repoRoot) {
  try {
    const c = JSON.parse(readFileSync(skillsConfigPath(repoRoot), 'utf8'));
    if (typeof c !== 'object' || c === null) return null;
    if (![1, 2, 3, 4].includes(c.version)) return null;
    if (c.tests !== undefined && !validTests(c.tests)) return null;
    if (c.models !== undefined && !validModels(c.models)) return null;
    if (c.source !== undefined && !VALID_SOURCES.includes(c.source)) return null;
    if (c.guard !== undefined && !['installed', 'declined'].includes(c.guard)) return null;
    if (c.lanes !== undefined) {
      if (typeof c.lanes !== 'object' || c.lanes === null || Array.isArray(c.lanes)) return null;
      for (const laneMap of Object.values(c.lanes)) {
        if (typeof laneMap !== 'object' || laneMap === null || Array.isArray(laneMap)) return null;
        for (const v of Object.values(laneMap)) {
          const ok = typeof v === 'string'
            || (Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string'));
          if (!ok) return null;
        }
      }
    }
    return c;
  } catch {
    return null;
  }
}

export function normalizeLaneValue(v) {
  return Array.isArray(v) ? v : [v];
}

// Configured resolution only: lanes -> steps -> default. Which of the
// value's entries is actually installed is the conductor's judgement.
export function resolveConfiguredSkill(cfg, laneType, phase) {
  const laneVal = cfg?.lanes?.[laneType]?.[phase];
  if (laneVal !== undefined) return { value: normalizeLaneValue(laneVal), via: 'lane' };
  const stepVal = cfg?.steps?.[phase];
  if (stepVal !== undefined) return { value: normalizeLaneValue(stepVal), via: 'steps' };
  return { value: [], via: 'default' };
}

// Per-field merge: a lane entry that sets only `codex` keeps the `claude`
// from steps or the default. `via` names the winning layer per field.
export function resolveModel(cfg, laneType, phase) {
  const out = { claude: null, codex: null, via: { claude: 'none', codex: 'none' } };
  for (const field of ['claude', 'codex']) {
    const lane = cfg?.models?.lanes?.[laneType]?.[phase]?.[field];
    const step = cfg?.models?.steps?.[phase]?.[field];
    const dflt = DEFAULT_MODELS[phase]?.[field];
    if (lane !== undefined) { out[field] = lane; out.via[field] = 'lane'; }
    else if (step !== undefined) { out[field] = step; out.via[field] = 'steps'; }
    else if (dflt !== undefined) { out[field] = dflt; out.via[field] = 'default'; }
  }
  return out;
}

// The one place the skills.json version is decided. v3 only when the
// optional models block is present, so machines on v0.2 keep reading
// files that never used it.
export function stampVersion(cfg) {
  cfg.version = cfg.tests !== undefined ? 4 : cfg.models !== undefined ? 3 : 2;
  return cfg;
}

export function writeSkillsConfig(repoRoot, cfg) {
  const p = skillsConfigPath(repoRoot);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  renameSync(tmp, p);
}

export function readState(repoRoot) {
  try {
    const s = JSON.parse(readFileSync(statePath(repoRoot), 'utf8'));
    if (typeof s !== 'object' || s === null || s.version !== 1) return null;
    return s;
  } catch {
    return null;
  }
}

export function writeState(repoRoot, state) {
  const p = statePath(repoRoot);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, p);
}

export function hasActiveSession(state) {
  return !!(state && state.task && !state.closedAt);
}

export function currentPhase(state) {
  for (const name of state.chain || []) {
    const ph = (state.phases || {})[name];
    if (!ph || ph.status !== 'done') return name;
  }
  return null;
}

// The one definition of "a reviewer's latest verdict on a phase": the
// highest-cycle record, a missing cycle counting as 1. The review CLI
// refuses a second record for the same reviewer, phase and cycle, so ties
// only arise from hand-written state; a later array entry wins there. Both
// the gates (via latestVerdicts) and the adjudication CLI read through this.
export function latestReview(state, phase, reviewer) {
  let latest = null;
  for (const r of state.reviews || []) {
    if (r.phase !== phase || r.reviewer !== reviewer) continue;
    if (!latest || (r.cycle ?? 1) >= (latest.cycle ?? 1)) latest = r;
  }
  return latest;
}

// Per reviewer, per phase: each reviewer's latest-cycle verdict counts.
// A phase is blocked while any reviewer's latest verdict is NEEDS_REVISION
// that no operator-confirmed `overruled` adjudication matches. Return
// shape {phase: verdict} is unchanged, so every caller stays as it is.
export function latestVerdicts(state) {
  const overruled = new Set((state.adjudications || [])
    .filter((a) => a.decision === 'overruled')
    .map((a) => `${a.phase}|${a.reviewer}|${a.cycle}`));
  const by = {};
  // ponytail: O(n²) over review records via latestReview; n is at most two
  // reviewers × three cycles × a handful of phases. Group in one pass if a
  // state ever carries hundreds of reviews.
  for (const { phase, reviewer } of state.reviews || []) {
    const r = latestReview(state, phase, reviewer);
    const blocking = r.verdict !== 'APPROVED' && !overruled.has(`${phase}|${reviewer}|${r.cycle ?? 1}`);
    if (blocking) by[phase] = 'NEEDS_REVISION';
    else if (by[phase] === undefined) by[phase] = 'APPROVED';
  }
  return by;
}

export function openGateItems(state) {
  if (!hasActiveSession(state)) return [];
  const items = [];
  for (const name of state.chain || []) {
    const ph = (state.phases || {})[name];
    if (!ph || ph.status !== 'done') items.push(`phase:${name}`);
  }
  for (const [phase, v] of Object.entries(latestVerdicts(state))) {
    if (v !== 'APPROVED') items.push(`review:${phase}=${v}`);
  }
  for (const [k, v] of Object.entries(state.docsGate || {})) {
    if (v === false) items.push(`docs:${k}`);
  }
  return items;
}

// Proofs (passing preexisting runs) made against full run F: a proof holds
// only for the full run it was made against.
const proofsAgainst = (state, F) => (state.testRuns || []).filter((r) => r.kind === 'preexisting' && r.proven === true && r.sinceFull === F.id);

// Failure `t` of `run` is proven when a proof against F names the same test
// from the same file (no file on either side = an id-only runner; a file on
// one side only is identity not established, so unproven).
const provenFailure = (proofs, run, t) => proofs.some((p) => p.test === t && (p.file ?? '') === (run.failureFiles?.[t] ?? ''));

// A red run whose report parsed, passed something, names each failure once,
// and fails only on tests that failed in F and were proven pre-existing
// against F from the same file: it re-ran a known failure, not one the diff
// caused, so it counts like green. File identity matches the proof's rule:
// same file, or no file on either side (id-only runners); one-sided refuses.
export function onlyProvenFailures(state, run, F) {
  if (!F || run.exit === 0 || !Array.isArray(run.failures) || run.failures.length === 0) return false;
  if (!(run.passedCount > 0) || new Set(run.failures).size !== run.failures.length) return false;
  const inF = new Set(F.failures || []);
  const proofs = proofsAgainst(state, F);
  return run.failures.every((t) => inF.has(t) && provenFailure(proofs, run, t));
}

// Spec §3.3: with a `tests` config, integration needs one full run F (the
// latest), F green or every failure proven pre-existing with `ship` armed,
// and - only when the action ships code (ctx.trees given) - every shipped
// tree covered by F or a later green affected run (or, with ship armed, one
// red only on F's proven failures). [] when no tests config.
export function testBlockers(state, ctx = {}) {
  const tests = ctx?.tests;
  if (!isPlainObject(tests) || tests.none) return [];
  const runs = state.testRuns || [];
  const F = runs.filter((r) => r.kind === 'full').reduce((m, r) => (!m || r.id > m.id ? r : m), null);
  if (!F) return ['no full test run recorded (state-cli test --full)'];
  if (F.exit !== 0) {
    if (!Array.isArray(F.failures) || F.failures.length === 0) {
      return [`full test run #${F.id} failed and its failures are unknown (no JUnit report)`];
    }
    // A red run with no passing test is a runner that did not run the suite
    // (its one synthetic failure reproduces on base and would prove itself).
    if (F.passedCount === 0) {
      return [`full test run #${F.id} passed no tests - the runner may not have run the suite; fix the full command, then state-cli test --full`];
    }
    // One proof covers one test: a failing id listed twice is two tests, and
    // narrowing the `one` command could prove the wrong one.
    const dup = [...new Set(F.failures.filter((t, i) => F.failures.indexOf(t) !== i))];
    if (dup.length) {
      return [`full test run #${F.id} has ambiguous failing ids: ${dup.join(', ')} - give those tests unique names, then state-cli test --full`];
    }
    // A proof holds for the full run it was made against: a later red full
    // run may report the same id from another test, so it needs a re-proof.
    const proofs = proofsAgainst(state, F);
    const unproven = F.failures.filter((t) => !provenFailure(proofs, F, t));
    if (unproven.length) {
      return [`full test run #${F.id} has ${unproven.length} failing test(s) not proven pre-existing: ${unproven.join(', ')}`];
    }
    if (!state.ship) return [`full test run #${F.id} failures are all pre-existing; waiving them needs /senior-dev:ship`];
  }
  const trees = ctx.trees;
  if (!Array.isArray(trees)) return [];
  // With ship armed, an affected run red only on F's proven pre-existing
  // failures covers its tree (it cannot be exit 0 while those still fail).
  const green = (r) => r.exit === 0 || (state.ship && onlyProvenFailures(state, r, F));
  const covered = (tree) => tree != null && (F.tree === tree || runs.some((r) => r.kind === 'affected'
    && green(r) && r.sinceFull === F.id && r.tree === tree));
  if (trees.length && trees.every(covered)) return [];
  const out = [`current tree is not covered by a green test run since full run #${F.id} (state-cli test --affected)`];
  // ctx.heads[i] is the commit of trees[i]. The latest run at that commit
  // but another tree means the run saw uncommitted changes.
  const R = runs.filter((r) => r.kind === 'full' || r.kind === 'affected').reduce((m, r) => (!m || r.id > m.id ? r : m), null);
  const heads = Array.isArray(ctx.heads) ? ctx.heads : [];
  if (R?.head && trees.some((t, i) => !covered(t) && heads[i] === R.head && R.tree !== t)) {
    out.push('working tree has changes not in HEAD: commit or remove them, then state-cli test --affected');
  }
  return out;
}

// The commit sha of `rev` in the checkout at cwd; null on any git failure.
export function headCommit(cwd, rev = 'HEAD') {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '-q', `${rev}^{commit}`], {
      cwd, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim() || null;
  } catch {
    return null;
  }
}

export function integrationBlockers(state, ctx = {}) {
  const blockers = [];
  for (const [phase, v] of Object.entries(latestVerdicts(state))) {
    if (v !== 'APPROVED') blockers.push(`review for '${phase}' is ${v}, not APPROVED`);
  }
  if ((state.reviews || []).length === 0 && !REVIEW_EXEMPT.has(state.type)) {
    blockers.push('no review recorded for this session');
  }
  if ((state.chain || []).includes('verify') && (state.phases || {}).verify?.status !== 'done') {
    blockers.push('verification phase not done');
  }
  for (const [k, v] of Object.entries(state.docsGate || {})) {
    if (v === false) blockers.push(`docs gate item '${k}' incomplete`);
  }
  blockers.push(...testBlockers(state, ctx));
  return blockers;
}

export function snapshotHash(items) {
  return createHash('sha256').update(items.slice().sort().join('|')).digest('hex');
}

export function ensureExcluded(repoRoot) {
  try {
    const p = join(repoRoot, '.git', 'info', 'exclude');
    let cur = '';
    try { cur = readFileSync(p, 'utf8'); } catch {}
    const shared = readSkillsConfig(repoRoot)?.shared === true;

    // Lines we manage. skills.json is excluded only when NOT shared; the
    // guard bundle is machine-local (installed per-clone), always excluded.
    const want = ['.senior-dev/state.json', '.senior-dev/history/', '.senior-dev/guard/', '.senior-dev/junit.xml'];
    if (!shared) want.push('.senior-dev/skills.json');

    // Start from existing lines, drop the legacy wholesale line and any of
    // our managed lines, then re-add exactly the set we want. Idempotent, and
    // flips skills.json in/out as `shared` changes.
    const managed = new Set([
      '.senior-dev/', '.senior-dev/state.json',
      '.senior-dev/history/', '.senior-dev/skills.json',
      '.senior-dev/guard/', '.senior-dev/junit.xml',
    ]);
    const kept = cur.split('\n').filter((l) => l !== '' && !managed.has(l));
    const out = [...kept, ...want];

    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, out.join('\n') + '\n');
  } catch {}
}

export function consumeBypass(repoRoot, state, action) {
  if (!state.bypassArmed) return false;
  state.bypasses = state.bypasses || [];
  state.bypasses.push({
    at: new Date().toISOString(),
    reason: state.bypassArmed.reason,
    action,
  });
  delete state.bypassArmed;
  writeState(repoRoot, state);
  return true;
}
