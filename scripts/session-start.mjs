#!/usr/bin/env node
// SessionStart bootstrap: in a git repo, tell the session the conductor
// exists (and whether a session is in flight). Outside a repo: silence.
// Fail open: any error -> exit 0, no output.
import { fileURLToPath } from 'node:url';
import {
  findRepoRoot, readState, hasActiveSession, currentPhase, openItems,
} from './lib/state.mjs';

// state-cli.mjs is a sibling of this file (both live in scripts/); resolve
// it from our own location so the operator always has a working path even
// when $CLAUDE_PLUGIN_ROOT is unset in their shell.
const STATE_CLI_PATH = fileURLToPath(new URL('./state-cli.mjs', import.meta.url));

const BOOTSTRAP = `<IMPORTANT>
This repo is under senior-dev orchestration.
Before starting ANY coding task (feature, bug fix, refactor, quick fix, docs change), you MUST invoke the 'senior-dev:conductor' skill. It classifies the task, selects the mandatory skill chain from the installed skills, and records phase state. Commit/integration and session-stop gates are armed while a session is active.
Commands: /senior-dev:start [task] | /senior-dev:status | /senior-dev:bypass <reason> | /senior-dev:finish
State CLI: node ${STATE_CLI_PATH} (use this exact path; $CLAUDE_PLUGIN_ROOT may be unset in your shell)
</IMPORTANT>`;

async function readStdin() {
  let data = '';
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) data += chunk;
  } catch {}
  return data;
}

try {
  let cwd = process.cwd();
  try {
    const parsed = JSON.parse(await readStdin());
    if (parsed && typeof parsed.cwd === 'string') cwd = parsed.cwd;
  } catch {}

  const repoRoot = findRepoRoot(cwd);
  if (!repoRoot) process.exit(0);

  let ctx = BOOTSTRAP;
  const state = readState(repoRoot);
  if (hasActiveSession(state)) {
    const open = openItems(repoRoot, state);
    // state.waiting may be corrupt (hand-edited state.json, partial write) -
    // guard every property access rather than trust the shape; fail open by
    // just omitting the line if it doesn't look right.
    const w = state && typeof state.waiting === 'object' && state.waiting !== null ? state.waiting : null;
    const waitingLine = (w && typeof w.on === 'string' && typeof w.at === 'string')
      ? `\nWAITING on: ${w.on} (since ${w.at}) — the previous session parked itself pending external work; check whether it completed before starting anything new.`
      : '';
    ctx += `\n\n<IMPORTANT>RESUME: a senior-dev session is in flight in this repo.
task: [${state.type}] ${state.task}
current phase: ${currentPhase(state) || '(all phases done)'}
open gate items: ${open.length ? open.join(', ') : 'none'}${waitingLine}
Run /senior-dev:status for detail, then invoke 'senior-dev:conductor' to resume where it left off. Do not restart completed phases.</IMPORTANT>`;
  }

  console.log(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx },
  }));
} catch {}
process.exit(0);
