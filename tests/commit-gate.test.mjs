import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeState, readState, CHAINS, DOCS_GATE } from '../scripts/lib/state.mjs';
import { classifyCommand } from '../scripts/commit-gate.mjs';

const SCRIPT = new URL('../scripts/commit-gate.mjs', import.meta.url).pathname;

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-cg-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

function gate(repo, command, toolName = 'Bash') {
  try {
    execFileSync('node', [SCRIPT], {
      encoding: 'utf8',
      input: JSON.stringify({ tool_name: toolName, tool_input: { command }, cwd: repo }),
    });
    return { blocked: false, msg: '' };
  } catch (e) {
    return { blocked: e.status === 2, msg: e.stderr || '' };
  }
}

function featureState(overrides = {}) {
  return {
    version: 1, task: 't', type: 'feature', startedAt: 'x',
    chain: CHAINS['feature'], phases: {}, reviews: [],
    docsGate: { ...DOCS_GATE['feature'] }, degradations: [], bypasses: [],
    scratchFiles: [], stopGate: { lastSnapshotHash: null }, ...overrides,
  };
}

test('no active session: everything allowed', () => {
  const repo = makeRepo();
  assert.equal(gate(repo, 'git commit -m x').blocked, false);
  assert.equal(gate(repo, 'git push').blocked, false);
});

test('non-git and non-Bash calls always allowed', () => {
  const repo = makeRepo();
  writeState(repo, featureState());
  assert.equal(gate(repo, 'ls -la').blocked, false);
  assert.equal(gate(repo, 'git commit -m x', 'Grep').blocked, false);
});

test('commit free outside implement/debug phases', () => {
  const repo = makeRepo();
  writeState(repo, featureState()); // current phase = brainstorm
  assert.equal(gate(repo, 'git commit -m "docs: spec"').blocked, false);
});

test('commit blocked during implement without green tests, allowed with', () => {
  const repo = makeRepo();
  const phases = { brainstorm: { status: 'done' }, worktree: { status: 'done' }, plan: { status: 'done' } };
  writeState(repo, featureState({ phases: { ...phases, implement: { status: 'in_progress' } } }));
  const r = gate(repo, 'git commit -m wip');
  assert.equal(r.blocked, true);
  assert.ok(r.msg.includes('tests-green'));
  writeState(repo, featureState({
    phases: { ...phases, implement: { status: 'in_progress', testsGreenAt: 'now' } },
  }));
  assert.equal(gate(repo, 'git commit -m ok').blocked, false);
});

test('integration blocked with blockers, allowed when clear', () => {
  const repo = makeRepo();
  writeState(repo, featureState());
  for (const cmd of ['git push origin main', 'git merge feat', 'gh pr create --fill']) {
    const r = gate(repo, cmd);
    assert.equal(r.blocked, true, cmd);
    assert.ok(r.msg.includes('/senior-dev:status'), cmd);
  }
  writeState(repo, featureState({
    reviews: [{ phase: 'implement', reviewer: 'codex', verdict: 'APPROVED', cycle: 1 }],
    phases: { verify: { status: 'done' } },
    docsGate: { spec: true, plan: true, handover: true, affectedDocs: true },
  }));
  assert.equal(gate(repo, 'git push origin main').blocked, false);
});

test('armed bypass allows one gated action and is consumed', () => {
  const repo = makeRepo();
  writeState(repo, featureState({ bypassArmed: { reason: 'hotfix', at: 'x' } }));
  assert.equal(gate(repo, 'git push').blocked, false);
  const s = readState(repo);
  assert.equal(s.bypassArmed, undefined);
  assert.equal(s.bypasses[0].reason, 'hotfix');
  assert.equal(gate(repo, 'git push').blocked, true); // consumed - blocks again
});

test('corrupt stdin: fail open', () => {
  try {
    execFileSync('node', [SCRIPT], { encoding: 'utf8', input: '{{{' });
    assert.ok(true);
  } catch {
    assert.fail('should not exit non-zero on corrupt stdin');
  }
});

// --- classifyCommand unit tests: command-aware classifier ---

test('classifyCommand: plain git commit/push/merge/subcommands', () => {
  assert.deepEqual(classifyCommand('git commit -m x'), { commit: true, integration: false });
  assert.deepEqual(classifyCommand('git push origin main'), { commit: false, integration: true });
  assert.deepEqual(classifyCommand('git merge feat'), { commit: false, integration: true });
  assert.deepEqual(classifyCommand('gh pr create --fill'), { commit: false, integration: true });
});

test('classifyCommand: gh pr merge is integration, same as gh pr create', () => {
  assert.deepEqual(classifyCommand('gh pr merge 12 --squash'), { commit: false, integration: true });
  assert.deepEqual(classifyCommand('gh pr merge --auto'), { commit: false, integration: true });
});

test('gh pr merge is blocked when integration blockers exist', () => {
  const repo = makeRepo();
  writeState(repo, featureState());
  const r = gate(repo, 'gh pr merge 12 --squash');
  assert.equal(r.blocked, true);
  assert.ok(r.msg.includes('/senior-dev:status'));
});

test('classifyCommand: global-flag skipping (-C, -c, --git-dir, --work-tree, -R, --repo)', () => {
  assert.deepEqual(classifyCommand('git -C /tmp/x push origin main'), { commit: false, integration: true });
  assert.deepEqual(classifyCommand('git -c user.name=x commit -m x'), { commit: true, integration: false });
  assert.deepEqual(classifyCommand('git --git-dir /tmp/x/.git push'), { commit: false, integration: true });
  assert.deepEqual(classifyCommand('git --work-tree /tmp/x commit -m x'), { commit: true, integration: false });
  assert.deepEqual(classifyCommand('git --no-pager commit -m x'), { commit: true, integration: false });
  assert.deepEqual(classifyCommand('gh -R o/r pr create'), { commit: false, integration: true });
  assert.deepEqual(classifyCommand('gh --repo o/r pr create --fill'), { commit: false, integration: true });
});

test('classifyCommand: quoted text is not classified', () => {
  assert.deepEqual(classifyCommand('echo "remember to git push later"'), { commit: false, integration: false });
  assert.deepEqual(classifyCommand('git commit -m "note: git push later"'), { commit: true, integration: false });
});

test('classifyCommand: commit-graph/commit-tree are not commits', () => {
  assert.deepEqual(classifyCommand('git commit-graph write --reachable'), { commit: false, integration: false });
  assert.deepEqual(classifyCommand('git commit-tree -m x HEAD^{tree}'), { commit: false, integration: false });
});

test('classifyCommand: subtree push is integration, other subtree ops are not', () => {
  assert.deepEqual(classifyCommand('git subtree push --prefix=dist origin gh-pages'), { commit: false, integration: true });
  assert.deepEqual(classifyCommand('git subtree pull --prefix=dist origin gh-pages'), { commit: false, integration: false });
});

test('classifyCommand: segment splitting on shell operators, command can be both', () => {
  assert.deepEqual(classifyCommand('git commit -m prep && git push'), { commit: true, integration: true });
  assert.deepEqual(classifyCommand('git commit -m a; git push'), { commit: true, integration: true });
  assert.deepEqual(classifyCommand('git commit -m a | cat'), { commit: true, integration: false });
  assert.deepEqual(classifyCommand('git commit -m a\ngit push'), { commit: true, integration: true });
});

// --- scenario tests: real bypass holes and false blocks, closed ---

test('git -C <path> push is classified integration and blocked when blockers exist', () => {
  const repo = makeRepo();
  writeState(repo, featureState());
  const r = gate(repo, 'git -C /tmp/x push origin main');
  assert.equal(r.blocked, true);
  assert.ok(r.msg.includes('/senior-dev:status'));
});

test('git --no-pager commit is classified commit and blocked during implement without green tests', () => {
  const repo = makeRepo();
  const phases = { brainstorm: { status: 'done' }, worktree: { status: 'done' }, plan: { status: 'done' } };
  writeState(repo, featureState({ phases: { ...phases, implement: { status: 'in_progress' } } }));
  const r = gate(repo, 'git --no-pager commit -m x');
  assert.equal(r.blocked, true);
  assert.ok(r.msg.includes('tests-green'));
});

test('gh --repo o/r pr create is classified integration and blocked when blockers exist', () => {
  const repo = makeRepo();
  writeState(repo, featureState());
  const r = gate(repo, 'gh --repo o/r pr create --fill');
  assert.equal(r.blocked, true);
  assert.ok(r.msg.includes('/senior-dev:status'));
});

test('echo mentioning git push in quotes is not gated', () => {
  const repo = makeRepo();
  writeState(repo, featureState()); // blockers exist, active session
  assert.equal(gate(repo, 'echo "remember to git push later"').blocked, false);
});

test('quoted text inside a real commit does not trigger the integration policy', () => {
  const repo = makeRepo();
  writeState(repo, featureState()); // brainstorm phase - commit is free, but blockers exist for integration
  assert.equal(gate(repo, 'git commit -m "note: git push later"').blocked, false);
});

test('git commit-graph write is not classified as a commit', () => {
  const repo = makeRepo();
  const phases = { brainstorm: { status: 'done' }, worktree: { status: 'done' }, plan: { status: 'done' } };
  writeState(repo, featureState({ phases: { ...phases, implement: { status: 'in_progress' } } }));
  assert.equal(gate(repo, 'git commit-graph write --reachable').blocked, false);
});

test('git subtree push is classified integration and blocked when blockers exist', () => {
  const repo = makeRepo();
  writeState(repo, featureState());
  const r = gate(repo, 'git subtree push --prefix=dist origin gh-pages');
  assert.equal(r.blocked, true);
  assert.ok(r.msg.includes('/senior-dev:status'));
});

test('commit+push chain during implement with no green tests is blocked via the commit rule even when integration blockers are empty', () => {
  const repo = makeRepo();
  writeState(repo, featureState({
    type: 'docs-only',
    chain: CHAINS['docs-only'],
    phases: { implement: { status: 'in_progress' } },
    docsGate: { handover: true },
    reviews: [],
  }));
  // sanity: integration side of this session has no open blockers
  const r = gate(repo, 'git commit -m prep && git push');
  assert.equal(r.blocked, true);
  assert.ok(r.msg.includes('tests-green'), r.msg);
});

// --- re-review fixes: symlink-safe main guard, env prefixes, heredoc bodies ---

test('classifyCommand: leading env assignments are skipped', () => {
  assert.deepEqual(classifyCommand('HUSKY=0 git commit -m x'), { commit: true, integration: false });
  assert.deepEqual(classifyCommand('GIT_PAGER=cat git push'), { commit: false, integration: true });
  assert.deepEqual(classifyCommand('FOO=1 BAR=two gh pr create --fill'), { commit: false, integration: true });
  assert.deepEqual(classifyCommand('FOO=1'), { commit: false, integration: false });
});

test('classifyCommand: heredoc bodies are not classified, marker line still is', () => {
  const heredocWrite = "cat > notes.md <<'EOF'\nReminder list:\ngit push origin main\nEOF";
  assert.deepEqual(classifyCommand(heredocWrite), { commit: false, integration: false });
  // marker line itself is still live shell text
  assert.deepEqual(classifyCommand('git push <<EOF\nnot a command\nEOF'), { commit: false, integration: true });
  // unterminated heredoc: body stripped to end of input, marker line still classified
  assert.deepEqual(classifyCommand('git push <<EOF\ngit merge feat'), { commit: false, integration: true });
});

test('classifyCommand: canonical heredoc commit-message form still classifies as commit', () => {
  const cmd = 'git commit -m "$(cat <<\'EOF\'\nfix: something\n\ngit push is mentioned here\nEOF\n)"';
  assert.deepEqual(classifyCommand(cmd), { commit: true, integration: false });
});

test('env-prefixed commit is gated: HUSKY=0 git commit blocked during implement without green tests', () => {
  const repo = makeRepo();
  const phases = { brainstorm: { status: 'done' }, worktree: { status: 'done' }, plan: { status: 'done' } };
  writeState(repo, featureState({ phases: { ...phases, implement: { status: 'in_progress' } } }));
  const r = gate(repo, 'HUSKY=0 git commit -m x');
  assert.equal(r.blocked, true);
  assert.ok(r.msg.includes('tests-green'));
});

test('env-prefixed push is gated: FOO=1 git push blocked when blockers exist', () => {
  const repo = makeRepo();
  writeState(repo, featureState());
  const r = gate(repo, 'FOO=1 git push');
  assert.equal(r.blocked, true);
  assert.ok(r.msg.includes('/senior-dev:status'));
});

test('heredoc body mentioning git push does not block the write', () => {
  const repo = makeRepo();
  writeState(repo, featureState()); // blockers exist, active session
  const cmd = "cat > notes.md <<'EOF'\nReminder list:\ngit push origin main\nEOF";
  assert.equal(gate(repo, cmd).blocked, false);
});

test('canonical heredoc commit-message form is still gated as a commit', () => {
  const repo = makeRepo();
  const phases = { brainstorm: { status: 'done' }, worktree: { status: 'done' }, plan: { status: 'done' } };
  writeState(repo, featureState({ phases: { ...phases, implement: { status: 'in_progress' } } }));
  const cmd = 'git commit -m "$(cat <<\'EOF\'\nfix: something\n\ndetail line\nEOF\n)"';
  const r = gate(repo, cmd);
  assert.equal(r.blocked, true);
  assert.ok(r.msg.includes('tests-green'));
});

test('gate still blocks when the hook script is invoked via a symlinked path', () => {
  const repo = makeRepo();
  writeState(repo, featureState()); // blockers exist
  const linkDir = mkdtempSync(join(tmpdir(), 'sd-cg-link-'));
  const link = join(linkDir, 'commit-gate-link.mjs');
  symlinkSync(SCRIPT, link);
  let status = 0;
  let stderr = '';
  try {
    execFileSync('node', [link], {
      encoding: 'utf8',
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: repo }),
    });
  } catch (e) {
    status = e.status;
    stderr = e.stderr || '';
  }
  assert.equal(status, 2, 'symlinked invocation must still run the gate');
  assert.ok(stderr.includes('/senior-dev:status'));
});

test('bypass is consumed only by an action that would otherwise be blocked', () => {
  const repo = makeRepo();
  writeState(repo, featureState({ bypassArmed: { reason: 'hotfix', at: 'x' } })); // brainstorm phase, blockers exist
  // free commit during brainstorm: would not have been blocked -> bypass must not be spent
  assert.equal(gate(repo, 'git commit -m free').blocked, false);
  let s = readState(repo);
  assert.ok(s.bypassArmed, 'bypass should still be armed after an action that was never blocked');
  // now a push that would be blocked: consumes the still-armed bypass
  assert.equal(gate(repo, 'git push').blocked, false);
  s = readState(repo);
  assert.equal(s.bypassArmed, undefined);
  assert.equal(s.bypasses[0].reason, 'hotfix');
  // bypass now spent - next blocked action blocks for real
  assert.equal(gate(repo, 'git push').blocked, true);
});

test('commit-gate blocks from inside a linked worktree when the main checkout has a must-block state', () => {
  const repo = makeRepo();
  writeFileSync(join(repo, 'README.md'), 'x');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: repo });
  writeState(repo, featureState()); // active session with open blockers
  const wtParent = mkdtempSync(join(tmpdir(), 'sd-cg-wt-'));
  const wt = join(wtParent, 'wt');
  execFileSync('git', ['worktree', 'add', wt, '-b', 'wtbranch'], { cwd: repo });
  const r = gate(wt, 'git push origin main');
  assert.equal(r.blocked, true);
  assert.ok(r.msg.includes('/senior-dev:status'));
});

test('split verdict blocks integration until that rejection is overruled; an upheld one keeps blocking', () => {
  const repo = makeRepo();
  const base = featureState({
    phases: { verify: { status: 'done' } },
    docsGate: { spec: true, plan: true, handover: true, affectedDocs: true },
    reviews: [
      { phase: 'implement', reviewer: 'claude', verdict: 'APPROVED', cycle: 1 },
      { phase: 'implement', reviewer: 'codex', verdict: 'NEEDS_REVISION', cycle: 1 },
    ],
  });
  writeState(repo, base);
  const r = gate(repo, 'git push origin main');
  assert.equal(r.blocked, true);
  assert.ok(r.msg.includes("review for 'implement' is NEEDS_REVISION"), r.msg);
  writeState(repo, { ...base, adjudications: [{ phase: 'implement', reviewer: 'codex', cycle: 1, decision: 'upheld' }] });
  assert.equal(gate(repo, 'git push origin main').blocked, true);
  writeState(repo, { ...base, adjudications: [{ phase: 'implement', reviewer: 'codex', cycle: 2, decision: 'overruled' }] });
  assert.equal(gate(repo, 'git push origin main').blocked, true);   // wrong cycle
  writeState(repo, { ...base, adjudications: [{ phase: 'implement', reviewer: 'codex', cycle: 1, decision: 'overruled' }] });
  assert.equal(gate(repo, 'git push origin main').blocked, false);
});
