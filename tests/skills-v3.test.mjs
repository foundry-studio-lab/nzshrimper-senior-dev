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
  assert.equal(cli(repo, ['guard', 'uninstall']).status, 0);
  c = readSkillsConfig(repo);
  assert.equal(c.version, 3);
  assert.deepEqual(c.models, V3().models);
  assert.equal(c.guard, 'declined');
});
