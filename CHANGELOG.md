# Changelog

## 0.5.0 — 2026-10-08

A native package for Codex and the ChatGPT app.

- `.codex-plugin/plugin.json`: the Codex manifest, with the app's card
  (display name, descriptions, Developer Tools category, three starter
  prompts, website and privacy links).
- `scripts/build-codex-package.mjs` writes `dist/codex-marketplace/`: an
  `.agents/plugins/marketplace.json` and a copy of the runtime files in
  `plugins/senior-dev/`. The seven slash commands become skills (the Codex
  format has none); `${CLAUDE_PLUGIN_ROOT}` in skill text becomes `<plugin>`
  with a note, and Claude Code's `` !`cmd` `` lines become instructions to run
  the command. The build deletes its output first, so it only writes outside
  the repo or under its `dist/`, compares real paths (symlinks, case), and
  only empties a folder that is its own previous build (our marketplace name,
  nothing else inside).
- The guard's version stamp reads `.codex-plugin/plugin.json` when the
  Claude manifest is absent, so a packaged guard can report itself stale.
- Version 0.5.0 in all three manifests; a test keeps them in step.
- Known limit: in Codex and the ChatGPT app the SessionStart bootstrap fires
  but the commit and stop gates do not (Codex's shell tool is not `Bash`);
  the universal guard enforces commit/merge/push there.

## 0.4.2 — 2026-10-02

Hardening pass on the 0.4 test runner, plus a runner for reviews.

- Command classifier: `$(...)`, backticks, `<(...)` / `>(...)`,
  substitutions inside double quotes (when the substitution has no nested
  double quotes) and tokens split by parentheses are now seen as the
  commands they run, so a guarded push hidden in one is no longer missed.
- `openItems` is shared by status, finish, the stop gate and the
  session-start banner, and fails closed: if evaluating the test rules of a
  valid tests config throws, the item stays open with
  `tests: could not evaluate the test rules (...)` instead of reading as met.
  A corrupt or unreadable `skills.json` still reads as "no tests config"
  (`readSkillsConfig` returns null).
- `skills-config set-tests` is refused once the active session has test
  runs, unless `--by-operator` (the operator's yes); such a change is logged
  to `state.testsConfigChanges` and `status` prints
  `tests config changed mid-session (N)`.
- The stop gate and the session-start banner now list open test items too.
- `test --affected` compares the full run's tree with the current
  would-commit tree (tree to tree). An untracked file already present at
  the full run (and still present) no longer reads as deleted or forces a
  full run; a file created after the full run is affected, as it should be.
  The base is the full run's `tree`, else its `head`, else a full run (only
  when both are unusable).
- New `scripts/review-run.mjs` runs one read-only review (Codex, or headless
  `claude -p` for the Codex app) and prints the JSON verdict. Exit codes:
  0 verdict, 2 usage, 3 degrade (prints the `state-cli degrade` line), 4 the
  reviewer wrote to the repo. It runs async in a detached process group,
  sends SIGTERM on timeout and SIGKILL after a 2 s grace, and handles
  signals. The write check is status + HEAD + diff hash + would-commit tree
  and fails closed (exit 3) on a snapshot error or any root-discovery error
  except git's own "fatal: not a git repository" diagnosis (at the start of
  a stderr line), which runs the review with no write check. Auth failures are read from
  stderr. `SENIOR_DEV_REVIEW_RUN` stands down the stop gate and the
  session-start banner while a runner review is live (honoured by those two
  only).
- PRIVACY.md discloses that review-run.mjs hands the repository to your installed Codex or claude CLI.
- The review prompt is renamed `review-prompt.md`. The conductor routes
  Codex passes, and the Codex-app Claude pass (`--skill claude-headless`),
  through the runner.

## 0.4.1 — 2026-10-01

Fix found by SMOKE 25 on a real vitest project: in 0.4.0, once a
pre-existing failure sat among the affected tests, every `test --affected`
run was red, so the commit gate could never be satisfied in debug/implement
and a push could never be covered, even with the failure proven and
`/senior-dev:ship` armed.

- A scoped run (`--affected`, `--one`) that is red only on failures proven
  pre-existing against the latest full run now counts as green: it prints
  `counts as green` and satisfies the commit gate (no `ship` needed). With
  `ship` armed, such an `--affected` run also covers its tree at push (a
  `--one` run never covers a push). Every failure must have failed in that
  full run and have a proof from the same file; a failing test that is not
  proven pre-existing keeps the run red (proof is by test identity - see
  spec §9).
- Proofs record the test's file and runs record each failure's file; the
  full-run waiver uses the same same-file match. A proof recorded before
  0.4.1 has no file, so it is refused wherever the run it is matched
  against records one - re-prove.
- An unchanged tree since a full run that is green or red only on proven
  failures is nothing to run, checked before escalation to the full suite
  (no `related` command, a deletion), so it no longer reruns forever.
  Explicitly named `--affected` files always run.

## 0.4.0 — 2026-10-01

Friction pass. An audit of 441 archived sessions found the bypasses
clustering in five places; each is now a first-class, logged operation.

- Test runner (optional `tests` block in `skills.json`, schema v4, written
  by `skills-config set-tests`). `state-cli test` runs `--affected`, `--one`,
  `--full`, `--build` and records every run with the tree it covered. The
  integration gate wants ONE green full run, then only affected tests for
  later changes, checked at push / PR creation (not at local merge). A repo
  with no `tests` config, or `set-tests --none`, behaves exactly as 0.3.1.
- A run's tree fingerprint keeps the real index's mtime on its temporary
  copy, so a same-size edit made just after the last index write is not
  recorded as the old content (git's racily-clean check stays in force).
- `test --affected` works before a repo's first commit (every file counts as
  affected; the empty tree is asked of git, so SHA-256 repos work too), and
  after a full run taken before it, when it diffs against the tree that run
  tested, so deletions still force the full suite (or runs the full suite if
  that tree has been pruned).
- `test --affected` runs the full suite when any file was deleted (or
  renamed away) since the base, and whenever its file list is empty at a
  tree the latest full run did not cover. Explicit files add to the
  changed-file list instead of replacing it.
- `finish` and `status` apply the test rules too: a local merge of an
  untested tree can no longer be finished and pushed later with the session
  gone. A coverage blocker names uncommitted changes when that is the cause.
- The gate classifier keeps quoted flag values in place (`git -C "/a b"
  push`, `git -c 'k=v' push`, `gh --repo "o/r" pr create`); a `-C` holding a
  command substitution or variable fails coverage closed in the cwd's
  session (the gate cannot expand it; see spec §9 — use literal `-C` paths),
  and `git -C <repo> push` is judged by that repo's session (the `-C` target
  wins over cwd's repo). The quoted-value fix applies to repos without a
  tests config too and only blocks more (those commands used to slip past
  the review, verify and docs gates); the target-wins rule means a push into
  a repo with no session is no longer judged by the cwd's session.
- A command touching several repos (`git push && git -C /repo/B push`) is
  judged per repo: each repo's pushes against its own session, tests config
  and bypass, blocked if any repo blocks, with each blocking repo named. A
  bypass armed in one repo never waives another.
- `set-tests` warns when `--report` points inside the repo at a path that is
  not git-ignored.
- `test --preexisting <id>` proves a failure also fails on the session's base
  commit (temporary worktree, JUnit report required). Never proven by a crash,
  nor when two testcases in either report share the id (node's reporter uses
  classname `test` for every file, so same-named tests collide), nor when the
  failure comes from a different file on base than on HEAD. A red full run
  whose failing ids repeat, or whose report passed no tests (a misconfigured
  runner), cannot be waived. A proof counts only for the full run it was made
  against; a later red full run needs its failures re-proved.
- `CONTRADICTION` stop: a test that fails, passes, then fails again in a
  phase halts the fix loop until the operator answers (`test --resolve`).
- `/senior-dev:ship <reason>` (operator-only) waives proven pre-existing
  failures for the session. Reviews, verify and the docs gate still apply.
- `state-cli reclassify --type <t> --reason` changes lane in the same
  session, replacing the force-open escalation. It needs no operator only when
  the new lane's rank is same-or-higher and it removes no docs-gate key the
  current lane has; lowering, or dropping gate items (refactor to bug-fix
  drops spec, plan), needs `--by-operator`. `init` records `baseHead`/`baseRefs`.
- Review cycle 4 records only a confirming APPROVED. `finish --no-change
  "<reason>"` closes a session that changed nothing, after the CLI checks
  HEAD, branches, tags, the stash, the working tree and worktrees against the
  baseline taken at `init`.
- `state-cli review --skill <name>` records which Claude review skill ran.
- The conductor names only skills that exist: `superpowers:verification-before-completion`
  for verify, `superpowers:requesting-code-review` for the Claude pass
  (`/code-review` only when that exact skill is listed), and checks phase
  skills against the visible list once at engage. Review prompts gain a
  spec axis (`<SPEC>` in the Codex prompt).

Upgrade note: existing universal-guard installs keep the old pre-push shim
until it is refreshed. The version bump makes `state-cli guard status`
report `stale`, which the conductor's resume step refreshes with
`state-cli guard install`; run it yourself to pick up the new pre-push shim
(it buffers stdin so a chained prior hook and the guard both see the pushed
refs).

Compatibility: `skills.json` becomes version 4 only when it has a `tests`
block (including `set-tests --none`). senior-dev 0.3.x reads a v4 file as
absent, so a SHARED, committed v4 skills.json looks unconfigured to a
teammate still on 0.3.x until they upgrade.

Known ceilings are listed in the spec (section 9).

## 0.3.1 — 2026-09-14

Hygiene pass over the 0.3.0 CLI: the inputs below used to be dropped or
merged silently and are now refused with a message, and nothing is written
on a refusal.

- `skills-config set-models` and `set-lane` refuse an empty `--steps` and a
  `--steps` that names the same phase twice; `set-models` also refuses an
  entry with more than one `/`.
- `dispatch --reason` is refused unless a tier is being raised, so the
  dispatch ledger never records a reason it threw away.
- `models --json` refuses a value (`--json true` used to print the text
  form).
- `review --overrule` and `--uphold` refuse a `--verdict` beside them.
- `skills-config models` with no `--lane` and no session defaults to the
  `feature` lane, the same as `resolve`, so `/senior-dev:skills` shows both
  tables at one scope (it used to print a flat view of every phase).
- Internal: one `latestReview(state, phase, reviewer)` helper in the state
  library defines a reviewer's latest verdict; the gates and the
  adjudication CLI both read through it. Gate behaviour is unchanged; an
  installed guard bundle reports `stale` until `/senior-dev:guard install`
  re-runs, and the conductor refreshes it at the next engage.
- Tests: a split verdict through the commit gate (upheld and wrong-cycle
  adjudications still block, an overrule clears), and a lane-level model
  floor outranking the steps floor only in its own lane.

## 0.3.0 — 2026-09-14

- Per-phase model map in `skills.json` (schema v3, optional `models`
  block): a Claude tier and a Codex effort per phase, per-field precedence
  lane → steps → built-in Balanced defaults. New `skills-config models`,
  `skills-config set-models`, `models --phase`, and a `dispatch` ledger
  that refuses to lower a floor and requires a reason to raise one.
  `status` reports the tiers used.
- Review adjudication: a split verdict goes to an adjudicator on the
  configured `adjudicate` tier (fable by default); `review --overrule`
  records the operator's confirmed overrule (and `--uphold` the audit
  trail). Nothing but the operator's yes clears a block.
- Gate fix: verdicts now resolve per reviewer. Previously the last review
  recorded for a phase decided it, so an approval recorded after another
  reviewer's rejection passed the gate. Already-installed guard bundles keep
  the old rule until `/senior-dev:guard install` re-runs; the conductor
  refreshes a `stale` bundle automatically at the next engage or resume.
- `review` refuses a second verdict for the same reviewer, phase and cycle;
  record the next cycle or an overrule instead.
- Conductor: Codex passes run through the plugin's `task --fresh --effort`
  lane with a stored read-only, JSON-first prompt.
- Compatibility: a v3 `skills.json` is treated as absent by plugin 0.2.x
  (it asks the skill-source question again); files that never set models
  stay at v2.

## 0.2.1 — 2026-09-14

- `status` (and so every conductor engage and `/senior-dev:status`) warns when
  the Codex CLI on PATH is behind the latest release, with the `codex update`
  fix. Nothing in the plugin pins a Codex version or model: review lanes ride
  whatever `codex` is installed and whatever `~/.codex/config.toml` selects,
  so a stale CLI was invisible. Fails open (no codex, no network, or
  `SENIOR_DEV_OFFLINE=1` => silent); 1.5s network cap. PRIVACY.md discloses
  the lookup.

## 0.2.0 — 2026-07-08

- Universal guard: git-hook enforcement (`pre-commit`, `pre-push`,
  `pre-merge-commit`) from a self-contained bundle — the gates now hold in
  Cowork, Codex, and plain terminals. Consent asked once per repo; existing
  hooks chained; uninstall restores them; fails open with warnings.
- Pass-token handshake so the Claude Code gate and the git hook never
  double-block or double-spend a bypass.
- skills.json schema v2: per-lane skill maps and ordered fallback lists
  (v1 files keep working). Interactive per-phase picker; new
  `/senior-dev:skills` and `/senior-dev:guard` commands;
  `skills-config set-lane` and `resolve` CLI subcommands.

## 0.1.2 — 2026-07-04

- Skill-source selection: every run opens with a four-way choice (own /
  superpowers / combo / suggest), saved per-repo in `.senior-dev/skills.json`
  (private by default, one-question share opt-in).
- `find-skills` wired in as a proposal engine for domain-skill gaps; a curated
  `skill-sources.md` gives exact install commands for missing chain plugins,
  with assisted install and the restart caveat stated.
- New `state-cli` subcommands: `skills-config` (show/set/share/unshare) and
  `skill-source`; status and finish now surface the chosen source.
- The process spine and all hard gates are unchanged.
