#!/usr/bin/env node
// Stop gate: refuse to let a session that claims completion stop while gate
// items are open. Three loop protections: stop_hook_active short-circuit,
// once-per-snapshot blocking, and a claim heuristic. Fail open on any error.
import { readFileSync } from 'node:fs';
import {
  findRepoRoot, readState, writeState, hasActiveSession, currentPhase,
  openItems, snapshotHash,
} from './lib/state.mjs';

// Deliberately loose - overfires on phrases like "one item done"; bounded by
// the snapshot hash (one block per distinct state) and stop_hook_active.
const CLAIMS = /\b(done|complete|completed|finished|shipped|ready to merge|all set|task is finished)\b/i;

function lastAssistantText(transcriptPath) {
  try {
    const lines = readFileSync(transcriptPath, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry;
      try { entry = JSON.parse(lines[i]); } catch { continue; }
      if (entry.type !== 'assistant') continue;
      const content = entry.message?.content;
      if (Array.isArray(content)) {
        return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      }
      if (typeof content === 'string') return content;
    }
  } catch {}
  return '';
}

async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

try {
  const data = JSON.parse(await readStdin());
  if (data.stop_hook_active) process.exit(0);

  const repoRoot = findRepoRoot(data.cwd || process.cwd());
  if (!repoRoot) process.exit(0);
  const state = readState(repoRoot);
  if (!hasActiveSession(state)) process.exit(0);

  // A recognised wait (external review, CI, etc.) is a legitimate reason to
  // stop - the session is parked, not abandoned. Exit before touching the
  // once-per-snapshot hash so the next genuine stop (post-clear) still gets
  // a fresh challenge instead of reading as "already seen".
  if (state.waiting) process.exit(0);

  const items = openItems(repoRoot, state);
  if (!items.length) process.exit(0);

  const finishing = currentPhase(state) === 'finish';
  const claims = CLAIMS.test(lastAssistantText(data.transcript_path));
  if (!finishing && !claims) process.exit(0);

  const hash = snapshotHash(items);
  if (state.stopGate?.lastSnapshotHash === hash) process.exit(0); // already challenged this exact state

  state.stopGate = { lastSnapshotHash: hash };
  writeState(repoRoot, state);
  console.error(`senior-dev stop gate: the session is not finished. Open gate items:\n- ${items.join('\n- ')}\nResolve them (conductor skill shows how), run /senior-dev:finish, or /senior-dev:bypass <reason>.`);
  process.exit(2);
} catch {
  process.exit(0);
}
