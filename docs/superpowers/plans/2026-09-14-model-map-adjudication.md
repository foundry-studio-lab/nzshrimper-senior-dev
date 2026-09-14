# Per-phase Model Map + Review Adjudication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put per-phase model tiers (Claude tier + Codex effort) into `skills.json`, record every subagent dispatch, and let a split review verdict be adjudicated with the operator's confirmation, while fixing the last-review-wins gate bug.

**Architecture:** All logic lives in the existing two files: `scripts/lib/state.mjs` (schema, defaults, resolution, verdict logic; also copied into the guard bundle) and `scripts/state-cli.mjs` (subcommands). The conductor skill and command files gain prose that calls the new subcommands. No new runtime dependencies.

**Tech Stack:** Node ESM (Node 26 on this machine, no build step), `node:test` + `node:assert/strict`, tests spawn the CLI with `execFileSync`.

**Spec:** `docs/superpowers/specs/2026-09-14-model-map-adjudication-design.md`

## Global Constraints

- Claude tiers: exactly `['haiku', 'sonnet', 'opus', 'fable']`, ranked in that order.
- Codex efforts: exactly `['low', 'medium', 'high', 'xhigh']`.
- Built-in defaults (Balanced): `implement: {claude: 'sonnet'}`, `review: {claude: 'sonnet', codex: 'medium'}`, `debug: {claude: 'opus'}`, `finish: {claude: 'opus', codex: 'high'}`, `adjudicate: {claude: 'fable'}`. Every other phase resolves to nothing (controller inline).
- `readSkillsConfig` returns `null` on any schema breach; it never throws and never partially accepts.
- Every skills.json writer preserves every field it does not own. Version is `3` when `models` is present, else `2`.
- CLI failures go through `fail()` (stderr + exit 1); successes print one greppable line.
- Test helpers that spawn the CLI pass `env: { ...process.env, SENIOR_DEV_OFFLINE: '1' }` when they call `status`.
- Run the whole suite with: `node --test --test-reporter=tap tests/*.test.mjs 2>&1 | grep -E '^(not ok|# (tests|pass|fail))'` (prepend `/opt/homebrew/bin` to PATH). Baseline before this plan: 141 pass.
- Commit messages: plain imperative subject; no words "publish", "approved", or "approval" in the subject (a user-level hook pattern-matches them).
- Work in the worktree at `.claude/worktrees/v0.3-model-map-adjudication`, branch `worktree-v0.3-model-map-adjudication`. Run git commands one at a time (the worktree guard refuses composite git commands).

---

### Task 1: skills.json schema v3 — constants, validation, resolution, version stamp

**Files:**
- Modify: `scripts/lib/state.mjs` (exports block near line 64 `VALID_SOURCES`; `readSkillsConfig` lines 70-92; add new functions after `resolveConfiguredSkill`)
- Modify: `scripts/state-cli.mjs` (`skills-config set` ~line 484-506, `set-lane` ~line 517-542, `guard install` ~line 428-431)
- Test: `tests/skills-v3.test.mjs` (new)

**Interfaces:**
- Consumes: `CHAINS`, `readSkillsConfig`, `writeSkillsConfig` (existing).
- Produces (all exported from `scripts/lib/state.mjs`):
  - `CLAUDE_TIERS: string[]`, `CODEX_EFFORTS: string[]`, `TIER_RANK: Record<string, number>`
  - `MODEL_PHASES: string[]` — every phase name from every chain, then `'adjudicate'`, in chain order
  - `DEFAULT_MODELS: Record<phase, {claude?: string, codex?: string}>`
  - `validModels(models: unknown): boolean`
  - `resolveModel(cfg, laneType: string, phase: string): { claude: string|null, codex: string|null, via: { claude: 'lane'|'steps'|'default'|'none', codex: same } }`
  - `stampVersion(cfg): cfg` — sets `cfg.version = cfg.models !== undefined ? 3 : 2` and returns cfg

- [ ] **Step 1: Write the failing tests**

Create `tests/skills-v3.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  readSkillsConfig, writeSkillsConfig, resolveModel, validModels, stampVersion,
  CLAUDE_TIERS, CODEX_EFFORTS, TIER_RANK, MODEL_PHASES, DEFAULT_MODELS,
} from '../scripts/lib/state.mjs';

const CLI = new URL('../scripts/state-cli.mjs', import.meta.url).pathname;
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-v3-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}
function cli(repo, args) {
  try { return { status: 0, out: execFileSync('node', [CLI, ...args], { cwd: repo, encoding: 'utf8' }) }; }
  catch (e) { return { status: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}
const V3 = () => ({
  version: 3, source: 'superpowers', shared: false, guard: 'installed',
  steps: { review: 'code-review' },
  lanes: { feature: { plan: ['own:planner', 'superpowers:writing-plans'] } },
  models: {
    steps: { implement: { claude: 'sonnet' }, review: { claude: 'sonnet', codex: 'medium' } },
    lanes: { feature: { finish: { codex: 'xhigh' } } },
  },
});

test('constants: tiers, efforts, rank order, phases, defaults', () => {
  assert.deepEqual(CLAUDE_TIERS, ['haiku', 'sonnet', 'opus', 'fable']);
  assert.deepEqual(CODEX_EFFORTS, ['low', 'medium', 'high', 'xhigh']);
  assert.ok(TIER_RANK.haiku < TIER_RANK.sonnet && TIER_RANK.sonnet < TIER_RANK.opus && TIER_RANK.opus < TIER_RANK.fable);
  for (const p of ['brainstorm', 'implement', 'debug', 'investigate', 'adjudicate']) assert.ok(MODEL_PHASES.includes(p), p);
  assert.equal(MODEL_PHASES[MODEL_PHASES.length - 1], 'adjudicate');
  assert.deepEqual(DEFAULT_MODELS.review, { claude: 'sonnet', codex: 'medium' });
  assert.deepEqual(DEFAULT_MODELS.adjudicate, { claude: 'fable' });
  assert.equal(DEFAULT_MODELS.brainstorm, undefined);
});

test('v3 round-trips and v1/v2 still parse', () => {
  const repo = makeRepo();
  writeSkillsConfig(repo, V3());
  assert.deepEqual(readSkillsConfig(repo), V3());
  writeSkillsConfig(repo, { version: 1, source: 'own', steps: { plan: 'x:y' } });
  assert.equal(readSkillsConfig(repo).version, 1);
  writeSkillsConfig(repo, { version: 2, source: 'combo', shared: false, lanes: { feature: { plan: 'x:y' } } });
  assert.equal(readSkillsConfig(repo).version, 2);
});

test('every models breach makes readSkillsConfig return null', () => {
  const repo = makeRepo();
  const breaches = [
    (c) => { c.models = []; },
    (c) => { c.models.extra = {}; },
    (c) => { c.models.steps.implement.claude = 'gpt'; },
    (c) => { c.models.steps.review.codex = 'max'; },
    (c) => { c.models.steps.implement.temperature = 1; },
    (c) => { c.models.steps.notaphase = { claude: 'opus' }; },
    (c) => { c.models.lanes.notalane = { finish: { claude: 'opus' } }; },
    (c) => { c.models.lanes.feature.finish = 'opus'; },
    (c) => { c.version = 4; },
  ];
  for (const [i, b] of breaches.entries()) {
    const c = V3(); b(c); writeSkillsConfig(repo, c);
    assert.equal(readSkillsConfig(repo), null, `breach ${i}`);
  }
  assert.equal(validModels(V3().models), true);
  assert.equal(validModels(null), false);
});

test('resolveModel merges per field: lane > steps > default > none', () => {
  const cfg = V3();
  const finish = resolveModel(cfg, 'feature', 'finish');
  assert.deepEqual(finish, { claude: 'opus', codex: 'xhigh', via: { claude: 'default', codex: 'lane' } });
  const review = resolveModel(cfg, 'quick-fix', 'review');
  assert.deepEqual(review, { claude: 'sonnet', codex: 'medium', via: { claude: 'steps', codex: 'steps' } });
  const plan = resolveModel(cfg, 'feature', 'plan');
  assert.deepEqual(plan, { claude: null, codex: null, via: { claude: 'none', codex: 'none' } });
  assert.deepEqual(resolveModel(null, 'feature', 'adjudicate').claude, 'fable');
  assert.deepEqual(resolveModel({ version: 2, source: 'own' }, 'bug-fix', 'debug').via, { claude: 'default', codex: 'none' });
});

test('stampVersion: 3 with models, 2 without', () => {
  assert.equal(stampVersion({ source: 'own' }).version, 2);
  assert.equal(stampVersion({ source: 'own', models: {} }).version, 3);
});

test('set, set-lane and guard install preserve models and never downgrade the version', () => {
  const repo = makeRepo();
  writeSkillsConfig(repo, V3());
  assert.equal(cli(repo, ['skills-config', 'set', '--source', 'combo']).status, 0);
  let c = readSkillsConfig(repo);
  assert.equal(c.version, 3);
  assert.deepEqual(c.models, V3().models);
  assert.equal(c.guard, 'installed');
  assert.equal(cli(repo, ['skills-config', 'set-lane', 'feature', '--steps', 'plan=a:b']).status, 0);
  c = readSkillsConfig(repo);
  assert.equal(c.version, 3);
  assert.deepEqual(c.models, V3().models);
  assert.equal(cli(repo, ['guard', 'install']).status, 0);
  c = readSkillsConfig(repo);
  assert.equal(c.version, 3);
  assert.deepEqual(c.models, V3().models);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-reporter=tap tests/skills-v3.test.mjs 2>&1 | grep -E '^(not ok|# (pass|fail)|SyntaxError)' | head`
Expected: a `SyntaxError` about a missing export (`resolveModel` or `validModels`), so nothing passes.

- [ ] **Step 3: Add the constants, validation, resolution and stamp to `scripts/lib/state.mjs`**

Insert directly after the `export const VALID_SOURCES = [...]` line:

```js
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
```

In `readSkillsConfig`, replace the version line and add the models check:

```js
    if (![1, 2, 3].includes(c.version)) return null;
    if (c.models !== undefined && !validModels(c.models)) return null;
```

Insert directly after `resolveConfiguredSkill`:

```js
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
  cfg.version = cfg.models !== undefined ? 3 : 2;
  return cfg;
}
```

- [ ] **Step 4: Make every writer in `scripts/state-cli.mjs` preserve `models` and stamp the version**

Add `stampVersion` to the import list from `./lib/state.mjs`.

In `skills-config set`: replace `version: 2,` in the `cfg` literal with nothing (delete the line), add after the `lanes` preservation line:

```js
      if (existing.models !== undefined) cfg.models = existing.models;
      stampVersion(cfg);
```

In `set-lane`: replace `cfg.version = 2;` with `stampVersion(cfg);` (place the call after `cfg.lanes[lane] = ...`, just before `writeSkillsConfig`).

In `guard install`: replace `cfg.version = 2;` with `stampVersion(cfg);` (after `cfg.guard = 'installed';`).

- [ ] **Step 5: Run the new tests and the full suite**

Run: `node --test --test-reporter=tap tests/skills-v3.test.mjs 2>&1 | grep -E '^(not ok|# (pass|fail))'`
Expected: `# pass 6`, `# fail 0`.
Run the full suite (Global Constraints). Expected: 147 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/state.mjs scripts/state-cli.mjs tests/skills-v3.test.mjs
git commit -m "feat: skills.json v3 models block - constants, validation, per-field resolution, version stamp"
```

---

### Task 2: `skills-config models` and `skills-config set-models`

**Files:**
- Modify: `scripts/state-cli.mjs` (`skills-config` case: add two `if (sub === ...)` blocks before the final `fail(...)`; add `parseModelSteps` helper next to `parseSteps`; update the `fail('skills-config needs a subcommand: ...')` list)
- Test: `tests/models-cli.test.mjs` (new)

**Interfaces:**
- Consumes: `resolveModel`, `stampVersion`, `MODEL_PHASES`, `CLAUDE_TIERS`, `CODEX_EFFORTS`, `CHAINS`, `readSkillsConfig`, `writeSkillsConfig`, `ensureExcluded`, `readState`, `hasActiveSession` (Task 1 + existing).
- Produces: CLI output formats below, relied on by Task 7's docs and by `commands/skills.md`:
  - `skills-config models [--lane <lane>]` prints `# resolved models - lane: <lane>` (or `# resolved models - steps view (no lane)`), then one line per phase: `<phase>: claude=<tier> (<via>) codex=<effort> (<via>)` with absent fields omitted, or `<phase>: (controller inline)`.
  - `skills-config set-models [--lane <lane>] --steps '<phase>=<claude>[/<codex>],...'` prints `models steps: {...}` or `models lane '<lane>': {...}`.

- [ ] **Step 1: Write the failing tests**

Create `tests/models-cli.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readSkillsConfig, writeSkillsConfig } from '../scripts/lib/state.mjs';

const CLI = new URL('../scripts/state-cli.mjs', import.meta.url).pathname;
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-models-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}
function cli(repo, args) {
  try { return { status: 0, out: execFileSync('node', [CLI, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, SENIOR_DEV_OFFLINE: '1' } }) }; }
  catch (e) { return { status: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}

test('models --lane prints defaults with via for a fresh repo', () => {
  const repo = makeRepo();
  const r = cli(repo, ['skills-config', 'models', '--lane', 'feature']);
  assert.equal(r.status, 0);
  assert.ok(r.out.includes('# resolved models - lane: feature'));
  assert.ok(r.out.includes('review: claude=sonnet (default) codex=medium (default)'));
  assert.ok(r.out.includes('finish: claude=opus (default) codex=high (default)'));
  assert.ok(r.out.includes('adjudicate: claude=fable (default)'));
  assert.ok(r.out.includes('plan: (controller inline)'));
  assert.ok(!r.out.includes('debug:'));                 // not in the feature chain
});

test('models without --lane uses the active session lane, else the steps view', () => {
  const repo = makeRepo();
  assert.ok(cli(repo, ['skills-config', 'models']).out.includes('steps view'));
  cli(repo, ['init', '--task', 't', '--type', 'bug-fix']);
  const r = cli(repo, ['skills-config', 'models']);
  assert.ok(r.out.includes('lane: bug-fix'));
  assert.ok(r.out.includes('debug: claude=opus (default)'));
});

test('set-models writes steps, merges per field, bumps to v3, preserves other fields', () => {
  const repo = makeRepo();
  writeSkillsConfig(repo, { version: 2, source: 'combo', shared: false, guard: 'declined', steps: { plan: 'x:y' } });
  let r = cli(repo, ['skills-config', 'set-models', '--steps', 'implement=opus,review=/high,finish=fable/xhigh']);
  assert.equal(r.status, 0, r.out);
  let c = readSkillsConfig(repo);
  assert.equal(c.version, 3);
  assert.equal(c.source, 'combo');
  assert.equal(c.guard, 'declined');
  assert.equal(c.steps.plan, 'x:y');
  assert.deepEqual(c.models.steps, { implement: { claude: 'opus' }, review: { codex: 'high' }, finish: { claude: 'fable', codex: 'xhigh' } });
  r = cli(repo, ['skills-config', 'set-models', '--steps', 'review=haiku']);
  assert.equal(r.status, 0, r.out);
  c = readSkillsConfig(repo);
  assert.deepEqual(c.models.steps.review, { claude: 'haiku', codex: 'high' });   // per-field merge
  assert.ok(cli(repo, ['skills-config', 'models', '--lane', 'quick-fix']).out.includes('review: claude=haiku (steps) codex=high (steps)'));
});

test('set-models --lane writes the lane map and only lane phases are allowed', () => {
  const repo = makeRepo();
  let r = cli(repo, ['skills-config', 'set-models', '--lane', 'feature', '--steps', 'finish=/xhigh,adjudicate=opus']);
  assert.equal(r.status, 0, r.out);
  const c = readSkillsConfig(repo);
  assert.equal(c.version, 3);
  assert.deepEqual(c.models.lanes.feature, { finish: { codex: 'xhigh' }, adjudicate: { claude: 'opus' } });
  assert.ok(cli(repo, ['skills-config', 'models', '--lane', 'feature']).out.includes('finish: claude=opus (default) codex=xhigh (lane)'));
  assert.equal(cli(repo, ['skills-config', 'set-models', '--lane', 'feature', '--steps', 'debug=opus']).status, 1);
});

test('set-models rejects bad lanes, phases, tiers, efforts and empty entries', () => {
  const repo = makeRepo();
  for (const args of [
    ['--lane', 'nonsense', '--steps', 'implement=opus'],
    ['--steps', 'notaphase=opus'],
    ['--steps', 'implement=gpt'],
    ['--steps', 'review=/max'],
    ['--steps', 'implement='],
    ['--steps', 'implement'],
    ['--steps'],
  ]) {
    const r = cli(repo, ['skills-config', 'set-models', ...args]);
    assert.equal(r.status, 1, args.join(' '));
  }
  assert.equal(readSkillsConfig(repo), null);   // nothing written
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-reporter=tap tests/models-cli.test.mjs 2>&1 | grep -E '^(not ok|# (pass|fail))'`
Expected: `# fail 5` (the CLI prints `skills-config needs a subcommand: ...` and exits 1).

- [ ] **Step 3: Add `parseModelSteps` next to `parseSteps` in `scripts/state-cli.mjs`**

```js
function parseModelSteps(raw, allowedPhases) {
  // "implement=sonnet,review=sonnet/medium,finish=/high"
  //   -> { implement: {claude:'sonnet'}, review: {claude:'sonnet', codex:'medium'}, finish: {codex:'high'} }
  const map = {};
  for (const pair of raw.split(',')) {
    const t = pair.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq < 1) fail(`bad --steps entry '${t}', expected phase=<claude>[/<codex>] or phase=/<codex>`);
    const phase = t.slice(0, eq).trim();
    if (!allowedPhases.includes(phase)) fail(`phase '${phase}' is not valid here (${allowedPhases.join(', ')})`);
    const [claude, codex] = t.slice(eq + 1).split('/').map((s) => s.trim());
    const entry = {};
    if (claude) {
      if (!CLAUDE_TIERS.includes(claude)) fail(`claude tier must be one of: ${CLAUDE_TIERS.join(', ')}`);
      entry.claude = claude;
    }
    if (codex) {
      if (!CODEX_EFFORTS.includes(codex)) fail(`codex effort must be one of: ${CODEX_EFFORTS.join(', ')}`);
      entry.codex = codex;
    }
    if (!entry.claude && !entry.codex) fail(`bad --steps entry '${t}': nothing to set`);
    map[phase] = entry;
  }
  return map;
}
```

Add `resolveModel, MODEL_PHASES, CLAUDE_TIERS, CODEX_EFFORTS` to the import from `./lib/state.mjs`.

- [ ] **Step 4: Add the two subcommands inside `case 'skills-config'`, before the final `fail(...)`**

```js
    if (sub === 'models') {
      let lane = typeof flags.lane === 'string' ? flags.lane : null;
      if (!lane) {
        const st = readState(repoRoot);
        lane = (hasActiveSession(st) && CHAINS[st.type]) ? st.type : null;
      }
      if (lane && !CHAINS[lane]) fail(`models --lane must be one of: ${Object.keys(CHAINS).join(', ')}`);
      const cfg = readSkillsConfig(repoRoot);
      const phases = lane ? [...CHAINS[lane], 'adjudicate'] : MODEL_PHASES;
      console.log(`# resolved models - ${lane ? 'lane: ' + lane : 'steps view (no lane)'}`);
      for (const phase of phases) {
        const r = resolveModel(cfg, lane || '', phase);
        const parts = [];
        if (r.claude) parts.push(`claude=${r.claude} (${r.via.claude})`);
        if (r.codex) parts.push(`codex=${r.codex} (${r.via.codex})`);
        console.log(parts.length ? `${phase}: ${parts.join(' ')}` : `${phase}: (controller inline)`);
      }
      break;
    }
    if (sub === 'set-models') {
      requireValues('skills-config set-models', flags, ['steps', 'lane']);
      const lane = typeof flags.lane === 'string' ? flags.lane : null;
      if (lane && !CHAINS[lane]) fail(`set-models --lane must be one of: ${Object.keys(CHAINS).join(', ')}`);
      if (typeof flags.steps !== 'string') fail("set-models needs --steps 'phase=<claude>[/<codex>],...'");
      const allowed = lane ? [...CHAINS[lane], 'adjudicate'] : MODEL_PHASES;
      const map = parseModelSteps(flags.steps, allowed);
      const cfg = readSkillsConfig(repoRoot) || { source: 'superpowers', shared: false };
      cfg.models = cfg.models || {};
      const target = lane
        ? (cfg.models.lanes = cfg.models.lanes || {}, cfg.models.lanes[lane] = cfg.models.lanes[lane] || {})
        : (cfg.models.steps = cfg.models.steps || {});
      for (const [phase, entry] of Object.entries(map)) target[phase] = { ...(target[phase] || {}), ...entry };
      stampVersion(cfg);
      writeSkillsConfig(repoRoot, cfg);
      ensureExcluded(repoRoot);
      console.log(`models ${lane ? `lane '${lane}'` : 'steps'}: ${JSON.stringify(target)}`);
      break;
    }
```

Update the trailing `fail('skills-config needs a subcommand: show | set | share | unshare | set-lane | resolve')` to list `| models | set-models`.

- [ ] **Step 5: Run the new tests and the full suite**

Run: `node --test --test-reporter=tap tests/models-cli.test.mjs 2>&1 | grep -E '^(not ok|# (pass|fail))'`
Expected: `# pass 5`, `# fail 0`. Full suite: 152 pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/state-cli.mjs tests/models-cli.test.mjs
git commit -m "feat: skills-config models and set-models - resolved table and per-field writes"
```

---

### Task 3: `models --phase`, `dispatch`, and the dispatch ledger

**Files:**
- Modify: `scripts/state-cli.mjs` (`init` state literal ~line 155-168: add two arrays; new `case 'models'` and `case 'dispatch'` after `case 'review'`; `status` case: one new line; add a `modelsUsedLine` helper next to `parseSteps`)
- Test: `tests/dispatch-cli.test.mjs` (new)

**Interfaces:**
- Consumes: `resolveModel`, `MODEL_PHASES`, `CLAUDE_TIERS`, `TIER_RANK`, `requireSession`, `readSkillsConfig`, `writeState`.
- Produces:
  - `state.dispatches: Array<{ phase, claude, floor, reason: string|null, at }>` and `state.adjudications: []` on every new session (Task 5 fills `adjudications`).
  - `models --phase <p> [--json]` prints `claude=<tier|none> codex=<effort|none>` or the JSON from `resolveModel`.
  - `dispatch --phase <p> [--claude <tier> --reason "<why>"]` prints `claude=<tier> codex=<effort|none>` plus ` (raised from <floor>: <reason>)` when raised.
  - `status` prints `models used: <tier>×<n>, ...` plus ` (raised: <phase> "<reason>"; ...)` when any dispatch exists.

- [ ] **Step 1: Write the failing tests**

Create `tests/dispatch-cli.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readState, writeSkillsConfig } from '../scripts/lib/state.mjs';

const CLI = new URL('../scripts/state-cli.mjs', import.meta.url).pathname;
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-dispatch-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}
function cli(repo, args) {
  try { return { status: 0, out: execFileSync('node', [CLI, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, SENIOR_DEV_OFFLINE: '1' } }) }; }
  catch (e) { return { status: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}

test('init creates empty dispatches and adjudications arrays', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 't', '--type', 'feature']);
  const s = readState(repo);
  assert.deepEqual(s.dispatches, []);
  assert.deepEqual(s.adjudications, []);
});

test('models --phase needs a session and prints the resolved pair', () => {
  const repo = makeRepo();
  assert.equal(cli(repo, ['models', '--phase', 'review']).status, 1);
  cli(repo, ['init', '--task', 't', '--type', 'quick-fix']);
  assert.equal(cli(repo, ['models', '--phase', 'review']).out.trim(), 'claude=sonnet codex=medium');
  assert.equal(cli(repo, ['models', '--phase', 'plan']).out.trim(), 'claude=none codex=none');
  assert.equal(cli(repo, ['models', '--phase', 'adjudicate']).out.trim(), 'claude=fable codex=none');
  assert.deepEqual(JSON.parse(cli(repo, ['models', '--phase', 'review', '--json']).out).via, { claude: 'default', codex: 'default' });
  assert.equal(cli(repo, ['models', '--phase', 'nope']).status, 1);
  assert.equal(cli(repo, ['models']).status, 1);
});

test('dispatch records the floor, requires a reason to raise, refuses to lower', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 't', '--type', 'feature']);
  let r = cli(repo, ['dispatch', '--phase', 'implement']);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.out.trim(), 'claude=sonnet codex=none');
  r = cli(repo, ['dispatch', '--phase', 'implement', '--claude', 'opus']);
  assert.equal(r.status, 1);
  assert.ok(r.out.includes('--reason'));
  r = cli(repo, ['dispatch', '--phase', 'implement', '--claude', 'opus', '--reason', 'multi-file integration']);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.out.trim(), 'claude=opus codex=none (raised from sonnet: multi-file integration)');
  r = cli(repo, ['dispatch', '--phase', 'implement', '--claude', 'haiku', '--reason', 'cheap']);
  assert.equal(r.status, 1);
  assert.ok(r.out.includes('never lowers'));
  r = cli(repo, ['dispatch', '--phase', 'implement', '--claude', 'sonnet']);   // at the floor: no reason needed
  assert.equal(r.status, 0, r.out);
  assert.equal(cli(repo, ['dispatch', '--phase', 'plan']).status, 1);        // inline phase: nothing to dispatch
  assert.equal(cli(repo, ['dispatch', '--phase', 'implement', '--claude', 'gpt', '--reason', 'x']).status, 1);
  const d = readState(repo).dispatches;
  assert.equal(d.length, 3);
  assert.deepEqual(d.map((x) => x.claude), ['sonnet', 'opus', 'sonnet']);
  assert.equal(d[1].floor, 'sonnet');
  assert.equal(d[1].reason, 'multi-file integration');
  assert.equal(d[0].reason, null);
  assert.ok(d[0].at);
});

test('dispatch honours a configured floor and status reports models used', () => {
  const repo = makeRepo();
  writeSkillsConfig(repo, { version: 3, source: 'superpowers', shared: false, models: { steps: { implement: { claude: 'opus' } } } });
  cli(repo, ['init', '--task', 't', '--type', 'feature']);
  assert.equal(cli(repo, ['dispatch', '--phase', 'implement', '--claude', 'sonnet']).status, 1);
  cli(repo, ['dispatch', '--phase', 'implement']);
  cli(repo, ['dispatch', '--phase', 'review']);
  cli(repo, ['dispatch', '--phase', 'review', '--claude', 'fable', '--reason', 'subtle concurrency diff']);
  const s = cli(repo, ['status']).out;
  assert.ok(s.includes('models used: opus×1, sonnet×1, fable×1 (raised: review "subtle concurrency diff")'), s);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-reporter=tap tests/dispatch-cli.test.mjs 2>&1 | grep -E '^(not ok|# (pass|fail))'`
Expected: `# fail 4`.

- [ ] **Step 3: Extend `init` and add the helper**

In the `init` state literal, after `waits: [],` add:

```js
      dispatches: [],
      adjudications: [],
```

Next to `parseSteps` add:

```js
function modelsUsedLine(state) {
  const d = state.dispatches || [];
  if (!d.length) return null;
  const counts = {};
  for (const x of d) counts[x.claude] = (counts[x.claude] || 0) + 1;
  const raised = d.filter((x) => x.reason).map((x) => `${x.phase} "${x.reason}"`);
  const used = Object.entries(counts).map(([t, n]) => `${t}×${n}`).join(', ');
  return `models used: ${used}${raised.length ? ` (raised: ${raised.join('; ')})` : ''}`;
}
```

Add `TIER_RANK` to the import from `./lib/state.mjs` (with the names Task 2 added).

- [ ] **Step 4: Add the two subcommands after `case 'review'` (before `case 'docs'`)**

```js
  case 'models': {
    const state = requireSession(repoRoot);
    requireValues('models', flags, ['phase']);
    if (!flags.phase) fail('models needs --phase <phase>');
    if (!MODEL_PHASES.includes(flags.phase)) fail(`models --phase must be one of: ${MODEL_PHASES.join(', ')}`);
    const r = resolveModel(readSkillsConfig(repoRoot), state.type, flags.phase);
    if (flags.json === true) console.log(JSON.stringify(r));
    else console.log(`claude=${r.claude || 'none'} codex=${r.codex || 'none'}`);
    break;
  }
  case 'dispatch': {
    const state = requireSession(repoRoot);
    requireValues('dispatch', flags, ['phase', 'claude', 'reason']);
    if (!flags.phase) fail('dispatch needs --phase <phase>');
    if (!MODEL_PHASES.includes(flags.phase)) fail(`dispatch --phase must be one of: ${MODEL_PHASES.join(', ')}`);
    const r = resolveModel(readSkillsConfig(repoRoot), state.type, flags.phase);
    const floor = r.claude;
    if (!floor) fail(`phase '${flags.phase}' runs inline on the controller - no dispatch tier configured`);
    let tier = floor;
    let reason = null;
    if (typeof flags.claude === 'string') {
      if (!CLAUDE_TIERS.includes(flags.claude)) fail(`--claude must be one of: ${CLAUDE_TIERS.join(', ')}`);
      if (TIER_RANK[flags.claude] < TIER_RANK[floor]) fail(`dispatch never lowers the configured floor (${floor})`);
      if (TIER_RANK[flags.claude] > TIER_RANK[floor]) {
        if (typeof flags.reason !== 'string' || !flags.reason.trim()) {
          fail(`raising above the floor (${floor}) needs --reason "<SDD complexity signal>"`);
        }
        reason = flags.reason.trim();
      }
      tier = flags.claude;
    }
    state.dispatches = state.dispatches || [];
    state.dispatches.push({ phase: flags.phase, claude: tier, floor, reason, at: new Date().toISOString() });
    writeState(repoRoot, state);
    console.log(`claude=${tier} codex=${r.codex || 'none'}${reason ? ` (raised from ${floor}: ${reason})` : ''}`);
    break;
  }
```

In `case 'status'`, directly after the `degradations` line add:

```js
    const modelsUsed = modelsUsedLine(state);
    if (modelsUsed) console.log(modelsUsed);
```

- [ ] **Step 5: Run the new tests and the full suite**

Expected: `# pass 4` for the file; full suite 156 pass. (`tests/state-cli.test.mjs` asserts the `init` shape by fields, so the two new arrays do not break it; if a `deepEqual` on the whole state exists, extend its expected object with the two arrays.)

- [ ] **Step 6: Commit**

```bash
git add scripts/state-cli.mjs tests/dispatch-cli.test.mjs
git commit -m "feat: models --phase, dispatch ledger with floor checks, status models-used line"
```

---

### Task 4: Per-reviewer verdict resolution (gate fix)

**Files:**
- Modify: `scripts/lib/state.mjs` (`latestVerdicts`, lines 146-150)
- Test: `tests/verdicts.test.mjs` (new)

**Interfaces:**
- Consumes: `state.reviews[] { phase, reviewer, verdict, cycle }`, `state.adjudications[] { phase, reviewer, cycle, decision }` (Task 5 writes them; this task only reads).
- Produces: `latestVerdicts(state)` keeps its `{ [phase]: 'APPROVED'|'NEEDS_REVISION' }` shape; `openGateItems` and `integrationBlockers` change behaviour only through it.

- [ ] **Step 1: Write the failing tests**

Create `tests/verdicts.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestVerdicts, integrationBlockers, openGateItems, CHAINS, DOCS_GATE } from '../scripts/lib/state.mjs';

function st(reviews, adjudications = []) {
  return {
    version: 1, task: 't', type: 'quick-fix', startedAt: 'x', chain: CHAINS['quick-fix'],
    phases: { implement: { status: 'done' }, review: { status: 'done' }, verify: { status: 'done' }, docs: { status: 'done' } },
    reviews, adjudications, docsGate: { handover: true, affectedDocs: true },
    degradations: [], bypasses: [], scratchFiles: [], waits: [], dispatches: [], stopGate: { lastSnapshotHash: null },
  };
}
const NR = (reviewer, cycle = 1, phase = 'implement') => ({ phase, reviewer, verdict: 'NEEDS_REVISION', cycle });
const OK = (reviewer, cycle = 1, phase = 'implement') => ({ phase, reviewer, verdict: 'APPROVED', cycle });

test('a split verdict blocks in every recording order', () => {
  assert.equal(latestVerdicts(st([NR('codex'), OK('claude')])).implement, 'NEEDS_REVISION');
  assert.equal(latestVerdicts(st([OK('claude'), NR('codex')])).implement, 'NEEDS_REVISION');
  assert.equal(latestVerdicts(st([NR('claude'), OK('codex')])).implement, 'NEEDS_REVISION');
  assert.ok(integrationBlockers(st([NR('codex'), OK('claude')])).some((b) => b.includes('NEEDS_REVISION')));
  assert.ok(openGateItems(st([NR('codex'), OK('claude')])).includes('review:implement=NEEDS_REVISION'));
});

test('a later approval by the rejecting reviewer clears the phase', () => {
  const s = st([OK('claude'), NR('codex'), OK('codex', 2)]);
  assert.equal(latestVerdicts(s).implement, 'APPROVED');
  assert.deepEqual(integrationBlockers(s), []);
});

test('a single reviewer approval is APPROVED (docs-only lanes have no second pass)', () => {
  assert.equal(latestVerdicts(st([OK('claude')])).implement, 'APPROVED');
  assert.equal(latestVerdicts(st([NR('claude')])).implement, 'NEEDS_REVISION');
  assert.deepEqual(latestVerdicts(st([])), {});
});

test('an overruled adjudication clears exactly that rejection', () => {
  const adj = [{ phase: 'implement', reviewer: 'codex', cycle: 1, decision: 'overruled' }];
  assert.equal(latestVerdicts(st([NR('codex'), OK('claude')], adj)).implement, 'APPROVED');
  // wrong cycle, wrong reviewer, or upheld: still blocked
  assert.equal(latestVerdicts(st([NR('codex', 2), OK('claude')], adj)).implement, 'NEEDS_REVISION');
  assert.equal(latestVerdicts(st([NR('claude'), OK('codex')], adj)).implement, 'NEEDS_REVISION');
  assert.equal(latestVerdicts(st([NR('codex'), OK('claude')], [{ ...adj[0], decision: 'upheld' }])).implement, 'NEEDS_REVISION');
});

test('phases resolve independently', () => {
  const v = latestVerdicts(st([OK('claude'), OK('codex'), NR('codex', 1, 'finish'), OK('claude', 1, 'finish')]));
  assert.equal(v.implement, 'APPROVED');
  assert.equal(v.finish, 'NEEDS_REVISION');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-reporter=tap tests/verdicts.test.mjs 2>&1 | grep -E '^(not ok|# (pass|fail))'`
Expected: `# fail 2` at least (the first test's second ordering and the overrule test fail under last-wins).

- [ ] **Step 3: Replace `latestVerdicts` in `scripts/lib/state.mjs`**

```js
// Per reviewer, per phase: each reviewer's latest-cycle verdict counts.
// A phase is blocked while any reviewer's latest verdict is NEEDS_REVISION
// that no operator-confirmed `overruled` adjudication matches. Return
// shape {phase: verdict} is unchanged, so every caller stays as it is.
export function latestVerdicts(state) {
  const perPhase = {};
  for (const r of state.reviews || []) {
    const per = (perPhase[r.phase] = perPhase[r.phase] || {});
    const cur = per[r.reviewer];
    if (!cur || (r.cycle ?? 1) >= (cur.cycle ?? 1)) per[r.reviewer] = r;
  }
  const overruled = new Set((state.adjudications || [])
    .filter((a) => a.decision === 'overruled')
    .map((a) => `${a.phase}|${a.reviewer}|${a.cycle}`));
  const by = {};
  for (const [phase, per] of Object.entries(perPhase)) {
    const blocking = Object.values(per).some((r) =>
      r.verdict !== 'APPROVED' && !overruled.has(`${phase}|${r.reviewer}|${r.cycle ?? 1}`));
    by[phase] = blocking ? 'NEEDS_REVISION' : 'APPROVED';
  }
  return by;
}
```

- [ ] **Step 4: Run the new tests and the full suite**

Expected: `# pass 5`; full suite 161 pass. Existing `tests/state.test.mjs` cases (cycle 1 NEEDS_REVISION then cycle 2 APPROVED by the same reviewer; single NEEDS_REVISION) keep passing under the new rule.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/state.mjs tests/verdicts.test.mjs
git commit -m "fix: verdicts resolve per reviewer - a later approval no longer masks another reviewer's rejection"
```

---

### Task 5: `review --overrule` / `--uphold` adjudication records

**Files:**
- Modify: `scripts/state-cli.mjs` (`case 'review'` ~line 196-215: add a branch at the top; `status`: one new line)
- Test: `tests/review-overrule.test.mjs` (new)

**Interfaces:**
- Consumes: `resolveModel`, `CLAUDE_TIERS`, `readSkillsConfig`, `requireSession`, `writeState`, `latestVerdicts` (Task 4).
- Produces: `state.adjudications[] { phase, cycle, reviewer, decision: 'overruled'|'upheld', by, reason, at }`; prints `adjudication recorded: <phase> cycle <n> <reviewer> <decision> (by <tier>)`; `status` prints `adjudications: <n> overruled, <m> upheld`.

- [ ] **Step 1: Write the failing tests**

Create `tests/review-overrule.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readState, writeSkillsConfig } from '../scripts/lib/state.mjs';

const CLI = new URL('../scripts/state-cli.mjs', import.meta.url).pathname;
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-overrule-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}
function cli(repo, args) {
  try { return { status: 0, out: execFileSync('node', [CLI, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, SENIOR_DEV_OFFLINE: '1' } }) }; }
  catch (e) { return { status: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}
const review = (repo, reviewer, verdict, cycle = 1, phase = 'implement') =>
  cli(repo, ['review', '--phase', phase, '--reviewer', reviewer, '--verdict', verdict, '--cycle', String(cycle)]);
const OVER = ['review', '--phase', 'implement', '--reviewer', 'codex', '--cycle', '1', '--overrule', '--reason', 'concern targets a file outside the diff'];

test('overrule records an adjudication, clears the gate, defaults --by to the adjudicate tier', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 't', '--type', 'quick-fix']);
  review(repo, 'codex', 'NEEDS_REVISION');
  review(repo, 'claude', 'APPROVED');
  assert.ok(cli(repo, ['status']).out.includes('review:implement=NEEDS_REVISION'));
  const r = cli(repo, OVER);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.out.trim(), 'adjudication recorded: implement cycle 1 codex overruled (by fable)');
  const a = readState(repo).adjudications;
  assert.equal(a.length, 1);
  assert.deepEqual({ ...a[0], at: undefined }, { phase: 'implement', cycle: 1, reviewer: 'codex', decision: 'overruled', by: 'fable', reason: 'concern targets a file outside the diff', at: undefined });
  assert.ok(a[0].at);
  const s = cli(repo, ['status']).out;
  assert.ok(!s.includes('review:implement=NEEDS_REVISION'), s);
  assert.ok(s.includes('adjudications: 1 overruled, 0 upheld'), s);
});

test('--by is validated and honours a configured adjudicate tier', () => {
  const repo = makeRepo();
  writeSkillsConfig(repo, { version: 3, source: 'superpowers', shared: false, models: { steps: { adjudicate: { claude: 'opus' } } } });
  cli(repo, ['init', '--task', 't', '--type', 'quick-fix']);
  review(repo, 'codex', 'NEEDS_REVISION');
  review(repo, 'claude', 'APPROVED');
  assert.ok(cli(repo, OVER).out.includes('(by opus)'));
  cli(repo, ['review', '--phase', 'implement', '--reviewer', 'codex', '--verdict', 'NEEDS_REVISION', '--cycle', '2']);
  assert.equal(cli(repo, [...OVER.slice(0, 6), '2', '--overrule', '--reason', 'x', '--by', 'gpt']).status, 1);
});

test('overrule preconditions: latest rejection at that cycle, other reviewer approved, a reason', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 't', '--type', 'quick-fix']);
  assert.equal(cli(repo, OVER).status, 1);                       // no reviews at all
  review(repo, 'codex', 'NEEDS_REVISION');
  assert.equal(cli(repo, OVER).status, 1);                       // claude has no verdict
  review(repo, 'claude', 'NEEDS_REVISION');
  assert.equal(cli(repo, OVER).status, 1);                       // both rejected: nothing to adjudicate
  review(repo, 'claude', 'APPROVED', 2);
  assert.equal(cli(repo, [...OVER.slice(0, -2)]).status, 1);     // missing --reason
  assert.equal(cli(repo, [...OVER, '--uphold']).status, 1);      // not both
  review(repo, 'codex', 'NEEDS_REVISION', 2);
  assert.equal(cli(repo, OVER).status, 1);                       // cycle 1 is no longer codex's latest
  assert.equal(cli(repo, [...OVER.slice(0, 6), '2', '--overrule', '--reason', 'ok']).status, 0);
  assert.equal(readState(repo).adjudications.length, 1);
});

test('uphold needs only the latest rejection and never clears the gate', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 't', '--type', 'quick-fix']);
  review(repo, 'codex', 'NEEDS_REVISION');
  const r = cli(repo, ['review', '--phase', 'implement', '--reviewer', 'codex', '--cycle', '1', '--uphold', '--reason', 'valid: missing null guard']);
  assert.equal(r.status, 0, r.out);
  assert.equal(readState(repo).adjudications[0].decision, 'upheld');
  const s = cli(repo, ['status']).out;
  assert.ok(s.includes('review:implement=NEEDS_REVISION'));
  assert.ok(s.includes('adjudications: 0 overruled, 1 upheld'));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-reporter=tap tests/review-overrule.test.mjs 2>&1 | grep -E '^(not ok|# (pass|fail))'`
Expected: `# fail 4` (today `review` requires `--verdict` and rejects the call).

- [ ] **Step 3: Add the adjudication branch at the top of `case 'review'`**

Directly after `const state = requireSession(repoRoot);` and before the existing `requireValues('review', ...)`:

```js
    if (flags.overrule !== undefined || flags.uphold !== undefined) {
      if (flags.overrule !== undefined && flags.uphold !== undefined) fail('review takes --overrule or --uphold, not both');
      if (flags.overrule !== undefined && flags.overrule !== true) fail('review --overrule does not take a value');
      if (flags.uphold !== undefined && flags.uphold !== true) fail('review --uphold does not take a value');
      const decision = flags.overrule === true ? 'overruled' : 'upheld';
      const flagName = decision === 'overruled' ? '--overrule' : '--uphold';
      requireValues('review', flags, ['phase', 'reviewer', 'cycle', 'reason', 'by']);
      if (!flags.phase) fail('review needs --phase <name>');
      if (!['codex', 'claude'].includes(flags.reviewer)) fail('review needs --reviewer codex|claude');
      if (!/^[0-9]+$/.test(String(flags.cycle ?? ''))) fail('review needs --cycle <n>');
      const cycle = parseInt(flags.cycle, 10);
      if (typeof flags.reason !== 'string' || !flags.reason.trim()) fail(`review ${flagName} needs --reason "<text>"`);
      const latestOf = (reviewer) => (state.reviews || [])
        .filter((r) => r.phase === flags.phase && r.reviewer === reviewer)
        .reduce((a, b) => (!a || (b.cycle ?? 1) >= (a.cycle ?? 1) ? b : a), null);
      const mine = latestOf(flags.reviewer);
      if (!mine || (mine.cycle ?? 1) !== cycle || mine.verdict !== 'NEEDS_REVISION') {
        fail(`no NEEDS_REVISION from ${flags.reviewer} at cycle ${cycle} is the latest verdict for '${flags.phase}'`);
      }
      if (decision === 'overruled') {
        const other = flags.reviewer === 'codex' ? 'claude' : 'codex';
        const theirs = latestOf(other);
        if (!theirs || theirs.verdict !== 'APPROVED') fail(`nothing to adjudicate: ${other}'s latest verdict for '${flags.phase}' is not APPROVED`);
      }
      const by = typeof flags.by === 'string'
        ? flags.by
        : (resolveModel(readSkillsConfig(repoRoot), state.type, 'adjudicate').claude || 'fable');
      if (!CLAUDE_TIERS.includes(by)) fail(`--by must be one of: ${CLAUDE_TIERS.join(', ')}`);
      state.adjudications = state.adjudications || [];
      state.adjudications.push({
        phase: flags.phase, cycle, reviewer: flags.reviewer, decision, by,
        reason: flags.reason.trim(), at: new Date().toISOString(),
      });
      writeState(repoRoot, state);
      console.log(`adjudication recorded: ${flags.phase} cycle ${cycle} ${flags.reviewer} ${decision} (by ${by})`);
      break;
    }
```

In `case 'status'`, directly after the `models used` lines from Task 3 add:

```js
    const adj = state.adjudications || [];
    if (adj.length) {
      const n = adj.filter((a) => a.decision === 'overruled').length;
      console.log(`adjudications: ${n} overruled, ${adj.length - n} upheld`);
    }
```

- [ ] **Step 4: Run the new tests and the full suite**

Expected: `# pass 4`; full suite 165 pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/state-cli.mjs tests/review-overrule.test.mjs
git commit -m "feat: review --overrule/--uphold record operator-confirmed adjudications"
```

---

### Task 6: Guard bundle honours split verdicts and overrules

**Files:**
- Modify: `tests/guard.test.mjs` (append two tests; no production change expected)

**Interfaces:**
- Consumes: `blockedState`, `cli`, `hook`, `makeRepo` helpers already in the file; Task 4 resolution copied into the bundle by `guard install`; Task 5 `review --overrule`.
- Produces: proof that `.senior-dev/guard/state-lib.mjs` carries the new resolution.

- [ ] **Step 1: Append the tests**

At the end of `tests/guard.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the guard tests**

Run: `node --test --test-reporter=tap tests/guard.test.mjs 2>&1 | grep -E '^(not ok|# (pass|fail))'`
Expected: all pass (the bundle is a copy of the fixed `state.mjs`). If the first new test passes only because `verify`/`docs` are incomplete, the fixture is wrong: every non-review blocker in `blockedState` must be satisfied so the review verdict alone decides.

- [ ] **Step 3: Run the full suite and commit**

Expected: 167 pass.

```bash
git add tests/guard.test.mjs
git commit -m "test: guard bundle blocks split verdicts and honours an overrule"
```

---

### Task 7: Conductor prose, Codex review prompt, skills command, smoke items

**Files:**
- Modify: `skills/conductor/SKILL.md` (sections "Model economy", "## 3. Review phase", and the status mention in "## 5. Finish" step 5)
- Create: `skills/conductor/references/codex-review-prompt.md`
- Modify: `commands/skills.md`
- Modify: `tests/SMOKE.md` (append items 21 and 22)

**Interfaces:**
- Consumes: the exact CLI output formats from Tasks 2, 3, 5.
- Produces: the operator-facing behaviour; no code.

- [ ] **Step 1: Replace the "## Model economy" section of `skills/conductor/SKILL.md` with**

```markdown
## Model economy

Tiers come from config, not memory. Before EVERY subagent dispatch run
`state-cli dispatch --phase <phase>` and pass the printed `claude=` tier as
`model:` on the Agent call. The printed tier is a floor: to raise it, name
one of the SDD complexity signals and record it —
`state-cli dispatch --phase <phase> --claude <tier> --reason "<signal>"` —
where the signals are: multi-file integration, debugging, design judgement,
a subtle or risky diff, or fix-loop escalation at rounds 4–5. Never pass a
tier below the floor; the CLI refuses it. Brainstorm, plan, worktree,
verify, docs, and investigate run inline on the controller and are never
dispatched. `state-cli models --phase <phase>` is the read-only lookup
(use it for the Codex effort and the adjudicate tier). Show and change the
table with `/senior-dev:skills` and `state-cli skills-config set-models`.

Every dispatch still carries a fully scoped brief — complete requirements,
exact interfaces and file paths, verification commands, and a report
contract. A fresh subagent inherits nothing.
```

- [ ] **Step 2: Replace step 2 of "## 3. Review phase" with**

```markdown
2. Codex pass (READ-ONLY, never `--write`):
   - Capture `git status --porcelain` and `git log -1 --format=%H` BEFORE.
   - Read the effort: `state-cli models --phase <phase>` → `codex=<effort>`.
   - Run `node <codex-plugin>/scripts/codex-companion.mjs task --fresh --effort <effort> "<prompt>"`
     with the prompt built from `references/codex-review-prompt.md` (fill
     the diff range and phase). It asks for the JSON verdict as the only
     reply and tells Codex to check any repo document or policy the diff
     touches.
   - Reply isn't the exact JSON contract? Re-ask ONCE for JSON-only. Still
     not JSON → record `NEEDS_REVISION` and tell the operator.
   - Re-run the two git commands AFTER. Any difference = Codex wrote to the
     repo: stop everything and tell the operator immediately.
   - Record: `state-cli review --phase <phase> --reviewer codex --verdict <V> --cycle <n>`
```

- [ ] **Step 3: Insert a new step 3a after step 3 of "## 3. Review phase"**

```markdown
3a. **Adjudication (split verdict).** When the two reviewers' latest
   verdicts for the phase differ, do not start cycle `n+1` yet:
   - `state-cli models --phase adjudicate` → the adjudicator tier.
   - Dispatch ONE subagent on that tier with: the rejecting reviewer's
     concerns verbatim, the diff range, the approving reviewer's reasoning
     if any, and this reply contract as the only permitted output:
     `{"concerns":[{"id":"<n>","decision":"uphold"|"overrule","reason":"<text>"}]}`
     Record the dispatch: `state-cli dispatch --phase adjudicate`.
   - Non-JSON reply → treat every concern as upheld and say so.
   - Upheld concerns → the fix loop; re-review at cycle `n+1`.
   - Overruled concerns → ask the operator ONE question listing each
     concern with the adjudicator's reason. On yes:
     `state-cli review --phase <phase> --reviewer <rejecting> --cycle <n> --overrule --reason "<operator's words>"`
     — the phase now counts as approved. On no → the fix loop.
   - Optionally record upheld ones for the audit trail:
     `state-cli review ... --cycle <n> --uphold --reason "<why>"`.
   Adjudication consumes no review cycle. You never arm an overrule
   yourself; only the operator's yes clears a block.
```

- [ ] **Step 4: Create `skills/conductor/references/codex-review-prompt.md`**

```markdown
# Codex review prompt (read-only, JSON-first)

Fill `<RANGE>` (e.g. `v0.2.1..HEAD` or `<sha>..HEAD`) and `<PHASE>`, then pass
the whole block as the single prompt argument of
`codex-companion.mjs task --fresh --effort <effort>`.

---
READ-ONLY code review for phase <PHASE>. Do NOT modify, create, or delete
any file, and do not run any command that writes. You may run only:
`git diff <RANGE>`, `git log <RANGE> --oneline`, `git show`, and read-only
inspection (cat, rg, ls) of files in this repository.

Review the diff for correctness, missed cases, and regressions. Read any
repository document or policy the change could affect (README, CHANGELOG,
PRIVACY, docs/, the plugin manifest) and flag any claim the diff makes
false.

Reply with ONLY this JSON object, no prose, no code fence:
{"verdict":"APPROVED"|"NEEDS_REVISION","concerns":[{"id":"1","file":"<path>","line":<n>,"text":"<concern>"}],"missedCases":[],"suggestions":[]}
Use NEEDS_REVISION only for a concrete defect you can point to. Suggestions
never change the verdict.
---
```

- [ ] **Step 5: Extend `commands/skills.md`**

Replace the body with:

```markdown
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/state-cli.mjs" skills-config resolve --lane $ARGUMENTS`

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/state-cli.mjs" skills-config models --lane $ARGUMENTS`

Present both tables above to the operator verbatim. Then offer the
per-phase picker from the `senior-dev:conductor` skill ("Skill source
resolution" section): for any phase they want to change, collect their pick
and record it with
`state-cli skills-config set-lane <lane> --steps 'phase=skill|fallback,...'`.
For model tiers, record picks with
`state-cli skills-config set-models [--lane <lane>] --steps 'phase=<claude>[/<codex>],...'`
(a value of `/<codex>` sets the Codex effort only).
```

Keep the frontmatter unchanged.

- [ ] **Step 5b: Extend "## 5. Finish" step 5 of `skills/conductor/SKILL.md`**

Change the step to read:

```markdown
5. Report to the operator with the sweep evidence pasted verbatim — actual
   command output, never assertions — and the `models used:` and
   `adjudications:` lines from `state-cli status` when present.
```

- [ ] **Step 6: Append to `tests/SMOKE.md`**

```markdown
21. [ ] Split verdict: stage claude APPROVED + codex NEEDS_REVISION on
    `implement` with verify/docs done → `git push` BLOCKED by gate and by
    the hook → `review --overrule` with a reason → push ALLOWED; `status`
    shows `adjudications: 1 overruled, 0 upheld`.
22. [ ] `dispatch --phase implement --claude haiku` refuses ("never lowers");
    `--claude opus` without `--reason` refuses; with `--reason` records and
    `status` shows `models used:` with the raise.
```

- [ ] **Step 7: Verify and commit**

Run: `grep -n 'state-cli dispatch\|codex-review-prompt\|--overrule' skills/conductor/SKILL.md | wc -l` — expected ≥ 4.
Run the full suite once more (unchanged, 167 pass).

```bash
git add skills/conductor/SKILL.md skills/conductor/references/codex-review-prompt.md commands/skills.md tests/SMOKE.md
git commit -m "docs: conductor uses dispatch floors, JSON-first Codex task pass, and adjudication; skills command prints models"
```

---

### Task 8: README, CHANGELOG, version 0.3.0, validate

**Files:**
- Modify: `README.md` (commands table ~line 140-150; the skills.json example; add a "Models" section after the skills section)
- Modify: `CHANGELOG.md` (new top entry)
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (`0.2.1` → `0.3.0`, marketplace has two occurrences)

**Interfaces:**
- Consumes: CLI names and formats from Tasks 2, 3, 5; SKILL.md prose from Task 7.

- [ ] **Step 1: README commands table** — add these rows next to the existing `/senior-dev:skills` row (keep the table's column shape):

```markdown
| `state-cli skills-config models [--lane <lane>]` | Resolved model tiers per phase (Claude tier + Codex effort) with the winning layer |
| `state-cli skills-config set-models [--lane <lane>] --steps 'phase=<claude>[/<codex>],...'` | Set tiers; `/<codex>` sets the effort only |
| `state-cli dispatch --phase <p> [--claude <tier> --reason "<signal>"]` | Record a subagent dispatch; raises need a reason, lowering is refused |
| `state-cli review ... --overrule --reason "<text>"` | Operator-confirmed overrule of one reviewer's rejection after adjudication |
```

- [ ] **Step 2: README "Models" section** — insert after the skills section:

```markdown
## Models

Every phase has a floor: a Claude tier for subagent dispatch and a Codex
effort for its review pass. Defaults (Balanced): implement sonnet; review
sonnet + Codex medium; debug opus; finish opus + Codex high; adjudicate
fable. Brainstorm, plan, worktree, verify, docs and investigate run on the
controller. The conductor may raise a tier on a named complexity signal and
records why; it never lowers. `status` reports the tiers a run used.

```json
"models": {
  "steps": { "review": { "claude": "sonnet", "codex": "medium" } },
  "lanes": { "feature": { "finish": { "claude": "fable", "codex": "xhigh" } } }
}
```

A split verdict (one reviewer approves, the other rejects) goes to an
adjudicator one tier up with only the disputed concerns. Upheld concerns
enter the fix loop. Overruled ones come to you as one yes or no; your yes
is recorded and is the only thing that clears the block.
```

Update the existing skills.json example in the README to `"version": 3` with the `models` block above.

- [ ] **Step 3: CHANGELOG** — insert at the top:

```markdown
## 0.3.0 — 2026-09-14

- Per-phase model map in `skills.json` (schema v3, optional `models`
  block): a Claude tier and a Codex effort per phase, per-field precedence
  lane → steps → built-in Balanced defaults. New `skills-config models`,
  `skills-config set-models`, `models --phase`, and a `dispatch` ledger
  that refuses to lower a floor and requires a reason to raise one.
  `status` reports the tiers used.
- Review adjudication: a split verdict goes to an adjudicator one tier up;
  `review --overrule` records the operator's confirmed overrule (and
  `--uphold` the audit trail). Nothing but the operator's yes clears a
  block.
- Gate fix: verdicts now resolve per reviewer. Previously the last review
  recorded for a phase decided it, so an approval recorded after another
  reviewer's rejection passed the gate.
- Conductor: Codex passes run through the plugin's `task --fresh --effort`
  lane with a stored read-only, JSON-first prompt.
- Compatibility: a v3 `skills.json` is treated as absent by plugin 0.2.x
  (it asks the skill-source question again); files that never set models
  stay at v2.
```

- [ ] **Step 4: Version bumps and validation**

```bash
sed -i '' 's/"version": "0.2.1"/"version": "0.3.0"/' .claude-plugin/plugin.json .claude-plugin/marketplace.json
grep -c '0.3.0' .claude-plugin/plugin.json .claude-plugin/marketplace.json
claude plugin validate .
```

Expected: `1` and `2`, then `Validation passed`.

- [ ] **Step 5: Full suite, then commit**

Expected: 167 pass.

```bash
git add README.md CHANGELOG.md .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "docs: README models section and rows, CHANGELOG 0.3.0, version bump"
```

---

## Self-review

**Spec coverage.** §3 schema → Task 1. §4 CLI rows → Tasks 2 (models, set-models), 3 (models --phase, dispatch), 5 (--overrule/--uphold), status lines → Tasks 3 and 5. §5 conductor → Task 7. §6 verdict fix → Task 4, bundle proof → Task 6. §7 failure modes → asserted in Tasks 2, 3, 5 tests (bad tiers, no session, lower/raise rules, overrule preconditions), non-JSON adjudicator → Task 7 prose. §8 tests → Tasks 1–6 (the spec's `models-cli.test.mjs` is split into `models-cli` and `dispatch-cli` so each task owns its file). §9 out of scope → nothing here implements those. §10 docs → Tasks 7 and 8. §11 success criteria → Task 2 test 1, Task 3 test 4, Task 6 tests, and the suite counts.

**Placeholders.** None: every code step carries the code; every run step carries the command and expected output.

**Type consistency.** `resolveModel` returns `{claude, codex, via:{claude, codex}}` in Tasks 1, 2, 3, 5. `MODEL_PHASES` is an array (`.includes`) everywhere. Adjudication records use `decision: 'overruled'|'upheld'` in Tasks 4, 5, 6. `state.dispatches` entries `{phase, claude, floor, reason, at}` in Task 3 and its status line. Test counts: 141 → 147 → 152 → 156 → 161 → 165 → 167.
