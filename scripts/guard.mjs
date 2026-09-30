#!/usr/bin/env node
// senior-dev universal guard. Runs from the repo bundle at
// .senior-dev/guard/ (installed by `state-cli guard install`), invoked by
// the git hook shims: node guard.mjs <pre-commit|pre-push|pre-merge-commit>.
// Same policies as the Claude Code PreToolUse gate; fails open on any error.
import { readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findRepoRoot, readState, hasActiveSession, currentPhase,
  integrationBlockers, consumeBypass, readSkillsConfig, headTree,
} from './state-lib.mjs';

const TEST_GATED_PHASES = new Set(['implement', 'debug']);
const INTEGRATION_HOOKS = new Set(['pre-push', 'pre-merge-commit']);

function warnOpen(msg) {
  console.error(`senior-dev guard: ${msg} - failing open`);
  process.exit(0);
}

try {
  const hookName = process.argv[2] || '';
  const repoRoot = findRepoRoot(process.cwd());
  if (!repoRoot) process.exit(0);
  const state = readState(repoRoot);
  if (!hasActiveSession(state)) process.exit(0);

  // Pass token: written by the Claude Code gate when it ALLOWED a gated
  // action (integration or commit). Hook invocations carry no original
  // command string, so we match on type + freshness only; single-use,
  // purged on sight - even when its type doesn't match this hook, so a
  // token meant for one hook can never be replayed against another later.
  const expectedTokenType = INTEGRATION_HOOKS.has(hookName) ? 'integration'
    : hookName === 'pre-commit' ? 'commit' : null;
  if (expectedTokenType) {
    const tokenPath = join(dirname(fileURLToPath(import.meta.url)), 'pass.json');
    try {
      const raw = readFileSync(tokenPath, 'utf8');
      unlinkSync(tokenPath); // single-use, consumed (or purged) on sight - even corrupt
      const tok = JSON.parse(raw);
      if (tok.type === expectedTokenType && new Date(tok.expiresAt) > new Date()) {
        process.exit(0);
      }
    } catch {}
  }

  let blockMsg = null;
  if (INTEGRATION_HOOKS.has(hookName)) {
    const blockers = integrationBlockers(state, {
      tree: headTree(process.cwd()), tests: readSkillsConfig(repoRoot)?.tests,
    });
    if (blockers.length) {
      blockMsg = `integration blocked (${blockers.length} item${blockers.length > 1 ? 's' : ''}):\n- ${blockers.join('\n- ')}`;
    }
  } else if (hookName === 'pre-commit') {
    const cur = currentPhase(state);
    if (cur && TEST_GATED_PHASES.has(cur) && !state.phases?.[cur]?.testsGreenAt) {
      blockMsg = `commit blocked: phase '${cur}' has no green test run recorded. Run the tests, then record tests-green (the conductor skill shows the exact call).`;
    }
  }

  if (blockMsg) {
    if (consumeBypass(repoRoot, state, `git hook ${hookName}`)) process.exit(0);
    console.error(`senior-dev gate: ${blockMsg}\nSee /senior-dev:status for detail, or /senior-dev:bypass <reason> to waive (logged).`);
    process.exit(1);
  }
  process.exit(0);
} catch (e) {
  warnOpen(`internal error (${e?.message || e})`);
}
