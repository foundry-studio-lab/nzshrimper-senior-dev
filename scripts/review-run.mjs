#!/usr/bin/env node
// Runs one read-only review (Codex via its companion script, or headless
// Claude via `claude -p`) and prints the JSON verdict. Exit codes: 0 verdict
// printed, 2 usage error, 3 degrade (prints the `state-cli degrade` line to
// record), 4 the reviewer wrote to the repo. Never writes senior-dev state.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { wouldCommitTree } from './lib/test-runner.mjs';
import { findRepoRoot, statePath } from './lib/state.mjs';

const MIN = 60_000;
const TIER_MIN = { low: 15, medium: 15, haiku: 15, sonnet: 15, high: 25, opus: 25, fable: 25, xhigh: 40 };
const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const MODELS = ['haiku', 'sonnet', 'opus', 'fable'];
const CLAUDE_TOOLS = 'Read,Grep,Glob,Bash(git diff:*),Bash(git show:*),Bash(git log:*)';
const AUTH = /not logged in|log ?in|authenticat/i;
const PROMPT_FILE = fileURLToPath(new URL('../skills/conductor/references/review-prompt.md', import.meta.url));

// The prompt is the text between the template's two `---` lines.
export function buildPrompt(template, { range, phase, spec }) {
  const body = template.split(/^---$/m)[1].trim();
  return body.replaceAll('<RANGE>', range).replaceAll('<PHASE>', phase).replaceAll('<SPEC>', spec);
}

// Last stdout line that is a verdict object; reviewers often add prose or a
// stray code fence around it.
export function parseVerdict(stdout) {
  const lines = String(stdout).split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let v;
    try { v = JSON.parse(lines[i]); } catch { continue; }
    if (v && typeof v === 'object' && ['APPROVED', 'NEEDS_REVISION'].includes(v.verdict) && Array.isArray(v.concerns)) return v;
  }
  return null;
}

// SENIOR_DEV_REVIEW_TIMEOUT_MS is a hidden test hook; --timeout is minutes.
export function timeoutMs({ reviewer, effort, model, timeout }, env) {
  if (env.SENIOR_DEV_REVIEW_TIMEOUT_MS) return Number(env.SENIOR_DEV_REVIEW_TIMEOUT_MS);
  if (timeout !== undefined) return Number(timeout) * MIN;
  return TIER_MIN[reviewer === 'codex' ? effort : model] * MIN;
}

// `ls ~/.claude/plugins/cache/*/codex/*/scripts/codex-companion.mjs | tail -1`.
// ponytail: lexical sort like tail -1, so 1.0.10 sorts before 1.0.9; set
// SENIOR_DEV_CODEX_COMPANION if that ever picks the wrong one.
export function findCompanion(env, home) {
  if (env.SENIOR_DEV_CODEX_COMPANION) return env.SENIOR_DEV_CODEX_COMPANION;
  const cache = join(home, '.claude/plugins/cache');
  const ls = (d) => { try { return readdirSync(d); } catch { return []; } };
  const found = [];
  for (const m of ls(cache)) for (const v of ls(join(cache, m, 'codex'))) {
    const p = join(cache, m, 'codex', v, 'scripts/codex-companion.mjs');
    if (existsSync(p)) found.push(p);
  }
  return found.sort().at(-1) ?? null;
}

const git = (cwd, args) => {
  try { return execFileSync('git', args, { cwd, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 30 }); }
  catch { return Buffer.alloc(0); } // no HEAD yet: '' on both sides compares equal
};
const sha = (b) => createHash('sha256').update(b).digest('hex');
const tryOr = (f, d) => { try { return f(); } catch { return d; } };
// The diff hash catches an edit to a file that was already dirty, which
// leaves `status --porcelain` unchanged; the would-commit tree catches an
// edit to an already-untracked file. The senior-dev state file (in the main
// checkout, git-ignored) is hashed too; other ignored paths stay blind.
const snapshot = (root) => ({
  status: git(root, ['status', '--porcelain']).toString(),
  head: git(root, ['rev-parse', 'HEAD']).toString().trim(),
  diff: sha(git(root, ['diff', 'HEAD', '--binary'])),
  tree: tryOr(() => wouldCommitTree(root), ''),
  state: tryOr(() => sha(readFileSync(statePath(findRepoRoot(root)))), ''),
});

// One reviewer attempt in its own process group, so a timeout kills the
// reviewer's children too. Resolves after the group's stdio closes.
// ponytail: output past 64 MB is dropped, not an error; the verdict must
// come before that.
function attempt(cmd, args, { cwd, env, ms }) {
  return new Promise((done) => {
    const out = [], err = [];
    let size = 0, timedOut = false, error = null;
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (buf) => (d) => { if ((size += d.length) <= 64 << 20) buf.push(d); };
    child.stdout.on('data', keep(out));
    child.stderr.on('data', keep(err));
    const group = (sig) => { try { process.kill(-child.pid, sig); } catch { /* group gone */ } };
    let grace;
    const timer = setTimeout(() => {
      timedOut = true;
      group('SIGTERM');
      grace = setTimeout(() => group('SIGKILL'), 2000);
    }, ms);
    const finish = (status) => {
      clearTimeout(timer); clearTimeout(grace);
      if (timedOut) group('SIGKILL'); // anything that shrugged off SIGTERM
      done({ status, error: timedOut ? { code: 'ETIMEDOUT' } : error,
        stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    };
    child.on('error', (e) => { error = e; if (child.pid === undefined) finish(null); });
    child.on('close', (status) => { if (child.pid !== undefined) finish(status); });
  });
}

// Exits unwind as a thrown value so stdout drains before the process ends
// (process.exit can truncate a piped stdout on macOS).
class Exit { constructor(code, out, err = '') { Object.assign(this, { code, out, err }); } }
const usage = (msg) => { throw new Exit(2, '', `review-run: ${msg}\nusage: review-run.mjs --reviewer codex|claude --phase <p> --range <a..b> [--spec <path>|none] [--effort <e>] [--model <m>] [--timeout <min>]\n`); };

async function main(argv, env) {
  let o;
  try {
    o = parseArgs({ args: argv, strict: true, options: Object.fromEntries(
      ['reviewer', 'phase', 'range', 'spec', 'effort', 'model', 'timeout'].map((k) => [k, { type: 'string' }])) }).values;
  } catch (e) { usage(e.message); }
  if (!['codex', 'claude'].includes(o.reviewer)) usage('--reviewer must be codex or claude');
  if (!o.phase) usage('--phase is required');
  if (!o.range) usage('--range is required');
  if (o.reviewer === 'codex' && !EFFORTS.includes(o.effort)) usage(`--effort is required for codex: ${EFFORTS.join('|')}`);
  if (o.reviewer === 'claude' && !MODELS.includes(o.model)) usage(`--model is required for claude: ${MODELS.join('|')}`);
  if (o.timeout !== undefined && !(Number(o.timeout) > 0)) usage('--timeout must be a positive number of minutes');

  const degrade = (reason) => {
    throw new Exit(3, `state-cli degrade --wanted "${o.reviewer} review (phase ${o.phase})" --used none --reason "${reason}"\n`);
  };
  // Anything unexpected past the usage checks (an unreadable prompt template,
  // say) is a degrade, not a stack trace.
  try { await review(o, env, degrade); } catch (e) {
    if (e instanceof Exit) throw e;
    degrade(`unexpected error: ${String(e?.message ?? e).replaceAll('"', "'").replace(/\s+/g, ' ')}`);
  }
}

async function review(o, env, degrade) {
  const label = o.reviewer === 'claude' ? 'claude CLI' : 'codex';
  const prompt = buildPrompt(readFileSync(PROMPT_FILE, 'utf8'), { range: o.range, phase: o.phase, spec: o.spec ?? 'none' });
  let cmd, args;
  if (o.reviewer === 'codex') {
    const companion = findCompanion(env, homedir());
    if (!companion || !existsSync(companion)) degrade('codex companion script not found');
    [cmd, args] = [process.execPath, [companion, 'task', '--fresh', '--effort', o.effort, prompt]];
  } else {
    [cmd, args] = [env.SENIOR_DEV_CLAUDE_BIN || 'claude', ['-p', '--model', o.model, '--permission-mode', 'plan',
      '--allowedTools', CLAUDE_TOOLS, '--output-format', 'text', prompt]];
  }
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).toString().trim() || process.cwd();
  const ms = timeoutMs(o, env);

  const mins = ms / MIN;
  const failures = [];
  for (let i = 0; i < 2; i++) {
    const before = snapshot(root);
    const r = await attempt(cmd, args, { cwd: root, env, ms });
    const after = snapshot(root);
    const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
    if (changed.length) {
      const detail = changed.includes('status') ? `status before:\n${before.status}status after:\n${after.status}` : '';
      throw new Exit(4, `WRITE DETECTED: ${o.reviewer} changed the repo during a read-only review\nchanged: ${changed.join(', ')}\n${detail}`);
    }
    if (r.error && r.error.code === 'ENOENT') degrade(`${label} not found`);
    if (r.error && r.error.code !== 'ETIMEDOUT') degrade(`${label} failed to start (${r.error.code})`);
    if (r.error) { failures.push('timed out'); continue; }
    // A login failure wins over any verdict-shaped line printed before it.
    if (r.status !== 0 && AUTH.test(`${r.stdout}\n${r.stderr}`)) degrade(`${label} not logged in`);
    const verdict = parseVerdict(r.stdout);
    if (verdict) throw new Exit(0, JSON.stringify(verdict) + '\n');
    failures.push('no JSON verdict');
  }
  const [a, b] = failures;
  const one = (f) => (f === 'timed out' ? `timed out (${mins} min)` : f);
  degrade(a !== b ? `${one(a)}, then ${one(b)}` : a === 'timed out' ? `timed out twice (${mins} min each)` : `${a} twice`);
}

const self = (() => { try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; } })();
if (self) {
  main(process.argv.slice(2), process.env).catch((e) => {
    if (!(e instanceof Exit)) throw e;
    process.stdout.write(e.out); process.stderr.write(e.err); process.exitCode = e.code;
  });
}
