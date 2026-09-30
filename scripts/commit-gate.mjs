#!/usr/bin/env node
// PreToolUse(Bash) gate. Worktree commits need green tests during
// implement/debug; integration (merge/push/PR) needs approved reviews,
// verification, and a full docs gate. Fail open on any error.
import { pathToFileURL } from 'node:url';
import { realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  findRepoRoot, readState, hasActiveSession, currentPhase,
  integrationBlockers, consumeBypass, readSkillsConfig, headTree,
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
  // Heredocs BEFORE quotes: the delimiter may itself be quoted (<<'EOF'),
  // and quote-stripping first would erase the delimiter while leaving the
  // body lines behind as apparent commands. The canonical
  // `git commit -m "$(cat <<'EOF' ... EOF)"` form survives this order: the
  // body and terminator are dropped, then the remaining double-quoted span
  // (still containing the marker) is stripped, leaving `git commit -m`.
  const noHeredocs = stripHeredocBodies(command);
  const stripped = noHeredocs.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '');
  const segments = stripped.split(/&&|\|\||;|\n|\|/);

  let commit = false;
  let integration = false;

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
    while (i < rest.length && rest[i].startsWith('-')) {
      if (VALUE_FLAGS.has(rest[i])) i += 2;
      else i += 1;
    }
    if (i >= rest.length) continue;

    if (head === 'git') {
      const sub = rest[i];
      if (sub === 'commit') {
        commit = true;
      } else if (sub === 'push' || sub === 'merge') {
        integration = true;
      } else if (sub === 'subtree' && rest.slice(i + 1).includes('push')) {
        integration = true;
      }
    } else {
      // gh
      if (rest[i] === 'pr' && (rest[i + 1] === 'create' || rest[i + 1] === 'merge')) {
        integration = true;
      }
    }
  }

  return { commit, integration };
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
    const { commit: isCommit, integration: isIntegration } = classifyCommand(command);
    if (!isIntegration && !isCommit) process.exit(0);

    const repoRoot = findRepoRoot(data.cwd || process.cwd());
    if (!repoRoot) process.exit(0);
    const state = readState(repoRoot);
    if (!hasActiveSession(state)) process.exit(0);

    // Compute the decision BEFORE touching any armed bypass: an action that
    // was never going to be blocked must not spend the operator's one-shot
    // bypass token.
    let blockMsg = null;

    if (isIntegration) {
      const blockers = integrationBlockers(state, {
        tree: headTree(data.cwd || process.cwd()), tests: readSkillsConfig(repoRoot)?.tests,
      });
      if (blockers.length) {
        blockMsg = `integration blocked (${blockers.length} item${blockers.length > 1 ? 's' : ''}):\n- ${blockers.join('\n- ')}`;
      }
    }

    if (!blockMsg && isCommit) {
      const cur = currentPhase(state);
      if (cur && TEST_GATED_PHASES.has(cur) && !state.phases?.[cur]?.testsGreenAt) {
        blockMsg = `commit blocked: phase '${cur}' has no green test run recorded. Run the tests, then: node "$CLAUDE_PLUGIN_ROOT/scripts/state-cli.mjs" tests-green (conductor skill shows the exact call).`;
      }
    }

    // A consumed bypass allows the action but must still fall through to the
    // token write below - the guard's fresh evaluation would re-find the same
    // blockers, and the spent bypass cannot cover them twice.
    if (blockMsg && !consumeBypass(repoRoot, state, command.slice(0, 120))) {
      block(blockMsg);
    }

    // Allowed. If this was a gated action (integration or commit) and the
    // universal guard is installed, leave a single-use pass token so the
    // git hook does not re-evaluate (and cannot double-consume a bypass).
    // Best-effort. A command that is somehow both (`git commit && git push`)
    // gets the 'integration' token - it is the stricter, later-firing hook.
    if (isIntegration || isCommit) {
      try {
        if (readSkillsConfig(repoRoot)?.guard === 'installed') {
          const dir = join(repoRoot, '.senior-dev', 'guard');
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'pass.json'), JSON.stringify({
            type: isIntegration ? 'integration' : 'commit',
            commandHash: createHash('sha256').update(command).digest('hex'),
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
