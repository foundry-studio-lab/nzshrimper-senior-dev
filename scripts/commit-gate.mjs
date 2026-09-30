#!/usr/bin/env node
// PreToolUse(Bash) gate. Worktree commits need green tests during
// implement/debug; integration (merge/push/PR) needs approved reviews,
// verification, and a full docs gate. Fail open on any error.
import { pathToFileURL } from 'node:url';
import { realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import {
  findRepoRoot, readState, hasActiveSession, currentPhase,
  integrationBlockers, consumeBypass, readSkillsConfig, headTree, headCommit,
} from './lib/state.mjs';

const TEST_GATED_PHASES = new Set(['implement', 'debug']);

// Flags that consume a following value token (when given as a separate
// token rather than `--flag=value`). Applies to both `git` and `gh`.
const VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '-R', '--repo']);

// Remove heredoc bodies: on a line containing <<[-]['"]?WORD['"]?, drop
// everything after that line up to and including the terminator line
// (^\s*WORD\s*$), or to the end of input when unterminated. The marker line
// itself is kept, so `git push <<EOF` still classifies while the body's
// free text never does.
function stripHeredocBodies(command) {
  const lines = command.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const m = lines[i].match(/<<-?\s*(['"]?)(\w+)\1/);
    if (m) {
      const terminator = new RegExp(`^\\s*${m[2]}\\s*$`);
      let j = i + 1;
      while (j < lines.length && !terminator.test(lines[j])) j++;
      i = j; // skip body and terminator (or everything, if unterminated)
    }
  }
  return out.join('\n');
}

// Command-aware classifier: replaces the old regex match (defeatable by
// `git -C <path> push`, quoted strings, `commit-graph`/`commit-tree`, etc).
// Strips heredoc bodies and quoted spans, splits into shell segments, and
// only classifies a segment when its first token (after leading NAME=value
// env assignments) is exactly `git` or `gh`, walking past leading flags
// (and their values) to find the real subcommand.
export function classifyCommand(command) {
  const { commit, integration } = parseCommand(command);
  return { commit, integration };
}

// The integration segments: [{kind: push|merge|pr-create|pr-merge, dir}].
export function integrationTargets(command) {
  return parseCommand(command).integrations;
}

// A `-C` value the gate cannot know (command substitution, variable): the
// NUL makes every git call on it fail, so headTree is null and coverage
// fails closed.
const UNRESOLVED = '\0unresolved';

// The literal path a token stands for, or null when the shell would expand
// it. Placeholders map back to their quoted spans; single quotes are literal.
function literalToken(token, quoted) {
  if (/[$`]/.test(token.replace(/\0\d+\0/g, ''))) return null;
  let bad = false;
  const out = token.replace(/\0(\d+)\0/g, (_, n) => {
    const q = quoted[n];
    const body = q.slice(1, -1);
    if (q[0] === "'") return body;
    if (/[$`]/.test(body)) bad = true;
    return body.replace(/\\(["\\\n])/g, '$1');
  });
  return bad ? null : out;
}

function parseCommand(command) {
  // Heredocs BEFORE quotes: the delimiter may itself be quoted (<<'EOF'),
  // and quote-stripping first would erase the delimiter while leaving the
  // body lines behind as apparent commands. The canonical
  // `git commit -m "$(cat <<'EOF' ... EOF)"` form survives this order: the
  // body and terminator are dropped, then the remaining double-quoted span
  // (still containing the marker) becomes one placeholder token.
  // Each quoted span becomes ONE placeholder token (\0<n>\0), so a quoted
  // flag value still occupies its position (`-C "/a b" push`); the
  // contents stay in `quoted` for resolving `-C`.
  const noHeredocs = stripHeredocBodies(command);
  const quoted = [];
  const stripped = noHeredocs.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (m) => `\0${quoted.push(m) - 1}\0`);
  const segments = stripped.split(/&&|\|\||;|\n|\|/);

  let commit = false;
  let integration = false;
  // Each integration segment: {kind: push|merge|pr-create|pr-merge, dir}
  // where dir is the git segment's `-C` path(s), joined, or null.
  const integrations = [];

  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    // Skip leading NAME=value env assignments (HUSKY=0 git commit ...).
    let t = 0;
    while (t < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[t])) t++;
    if (t >= tokens.length) continue;
    const head = tokens[t];
    const rest = tokens.slice(t + 1);
    if (head !== 'git' && head !== 'gh') continue;

    let i = 0;
    const dirs = [];
    while (i < rest.length && rest[i].startsWith('-')) {
      if (head === 'git' && rest[i] === '-C' && i + 1 < rest.length) dirs.push(literalToken(rest[i + 1], quoted));
      if (VALUE_FLAGS.has(rest[i])) i += 2;
      else i += 1;
    }
    if (i >= rest.length) continue;
    // Later -C values are relative to earlier ones; an absolute one resets.
    const dir = !dirs.length ? null : dirs.includes(null) ? UNRESOLVED
      : dirs.reduce((a, d) => (isAbsolute(d) ? d : join(a, d)));
    const add = (kind) => { integration = true; integrations.push({ kind, dir }); };

    if (head === 'git') {
      const sub = rest[i];
      if (sub === 'commit') {
        commit = true;
      } else if (sub === 'push' || sub === 'merge') {
        add(sub);
      } else if (sub === 'subtree' && rest.slice(i + 1).includes('push')) {
        add('push');
      }
    } else {
      // gh
      if (rest[i] === 'pr' && (rest[i + 1] === 'create' || rest[i + 1] === 'merge')) {
        add(`pr-${rest[i + 1]}`);
      }
    }
  }

  return { commit, integration, integrations };
}

async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function block(msg) {
  console.error(`senior-dev gate: ${msg}\nSee /senior-dev:status for detail, or /senior-dev:bypass <reason> to waive (logged).`);
  process.exit(2);
}

async function main() {
  try {
    const data = JSON.parse(await readStdin());
    if (data.tool_name !== 'Bash') process.exit(0);
    const command = data.tool_input?.command || '';
    const { commit: isCommit, integration: isIntegration, integrations } = parseCommand(command);
    if (!isIntegration && !isCommit) process.exit(0);

    const cwd = data.cwd || process.cwd();
    const cwdRoot = findRepoRoot(cwd);
    // Each segment is judged by the repo it targets: a resolved `-C` dir
    // inside a repo is that repo's action (`git -C /repo/B push` from A is
    // B's), anything else is cwd's repo. Commits stay on cwd's repo. One
    // group per repo, each with its own state and tests config.
    const groups = new Map();
    const group = (root) => {
      if (!groups.has(root)) groups.set(root, { root, integrations: [], commit: false });
      return groups.get(root);
    };
    for (const x of integrations) {
      const root = (x.dir && x.dir !== UNRESOLVED && findRepoRoot(resolve(cwd, x.dir))) || cwdRoot;
      if (root) group(root).integrations.push(x);
    }
    if (isCommit && cwdRoot) group(cwdRoot).commit = true;
    const many = groups.size > 1;

    // Compute every decision BEFORE touching any armed bypass: an action
    // that was never going to be blocked must not spend the operator's
    // one-shot bypass token.
    const gated = [];
    for (const g of groups.values()) {
      g.state = readState(g.root);
      if (!hasActiveSession(g.state)) continue; // no session: ungated
      gated.push(g);
      g.blockMsg = null;
      if (g.integrations.length) {
        // Coverage (§3.3 rule 3) only where code ships: push and gh pr
        // create, checked against the target checkout's HEAD (a `-C` dir,
        // else cwd). A merge's tree does not exist yet: rules 1-2 only.
        const shipping = g.integrations.filter((x) => x.kind === 'push' || x.kind === 'pr-create');
        const targets = shipping.map((x) => resolve(cwd, x.dir ?? '.'));
        const blockers = integrationBlockers(g.state, {
          tests: readSkillsConfig(g.root)?.tests,
          trees: shipping.length ? targets.map((d) => headTree(d)) : undefined,
          heads: targets.map((d) => headCommit(d)),
        });
        if (blockers.length) {
          g.blockMsg = `integration blocked (${blockers.length} item${blockers.length > 1 ? 's' : ''}):\n- ${blockers.join('\n- ')}`;
        }
      }
      if (!g.blockMsg && g.commit) {
        const cur = currentPhase(g.state);
        if (cur && TEST_GATED_PHASES.has(cur) && !g.state.phases?.[cur]?.testsGreenAt) {
          g.blockMsg = `commit blocked: phase '${cur}' has no green test run recorded. Run the tests, then: node "$CLAUDE_PLUGIN_ROOT/scripts/state-cli.mjs" tests-green (conductor skill shows the exact call).`;
        }
      }
      if (g.blockMsg && many) g.blockMsg = `${g.root}: ${g.blockMsg}`;
    }

    // Each blocking repo needs its OWN armed bypass (one armed in A never
    // waives B). Spend none unless all are armed, so a still-blocked action
    // costs nobody their token. A consumed bypass allows the action but
    // still falls through to the token write below - the guard's fresh
    // evaluation would re-find the same blockers.
    const blocking = gated.filter((g) => g.blockMsg);
    if (blocking.some((g) => !g.state.bypassArmed)) block(blocking.map((g) => g.blockMsg).join('\n'));
    for (const g of blocking) g.bypassed = !!consumeBypass(g.root, g.state, command.slice(0, 120));

    // Allowed. In each gated repo with the universal guard installed, leave
    // a single-use pass token so the git hook does not re-evaluate (and
    // cannot double-consume a bypass). pre-push still checks test coverage
    // of the pushed shas unless the token says a bypass was consumed.
    // Best-effort. A group that is somehow both (`git commit && git push`)
    // gets the 'integration' token - it is the stricter, later-firing hook.
    for (const g of gated) {
      try {
        if (readSkillsConfig(g.root)?.guard === 'installed') {
          const dir = join(g.root, '.senior-dev', 'guard');
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'pass.json'), JSON.stringify({
            type: g.integrations.length ? 'integration' : 'commit',
            commandHash: createHash('sha256').update(command).digest('hex'),
            bypassed: !!g.bypassed,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }));
        }
      } catch {}
    }
    process.exit(0);
  } catch {
    process.exit(0);
  }
}

// Only run the PreToolUse hook body when this file is executed directly
// (as the hook script). When it's `import`-ed (e.g. by tests pulling in
// `classifyCommand`), evaluating the module must NOT block on stdin.
//
// argv[1] keeps the as-invoked path while Node realpaths import.meta.url,
// so realpath argv[1] before comparing — a naive equality check silently
// disables the ENTIRE gate whenever the invocation path crosses a symlink
// or alias (macOS /tmp -> /private/tmp, symlinked plugin/skill installs).
// If the comparison itself fails for any reason, default to RUNNING the
// hook: main() has its own fail-open logic, but a guard failure must fail
// INTO the gate, never silently off.
let isMainModule;
try {
  isMainModule = pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
} catch {
  isMainModule = true;
}
if (isMainModule) {
  await main();
}
