# Changelog

## 0.4.0 — 2026-09-30

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
- `test --affected` runs the full suite when any file was deleted (or
  renamed away) since the base, and whenever its file list is empty at a
  tree the latest full run did not cover. Explicit files add to the
  changed-file list instead of replacing it.
- `finish` and `status` apply the test rules too: a local merge of an
  untested tree can no longer be finished and pushed later with the session
  gone. A coverage blocker names uncommitted changes when that is the cause.
- The gate classifier keeps quoted flag values in place (`git -C "/a b"
  push`, `git -c 'k=v' push`, `gh --repo "o/r" pr create`); a `-C` holding a
  command substitution or variable fails coverage closed, and `git -C
  <repo> push` finds that repo's session (the `-C` target wins over cwd's
  repo). This fix applies to repos without a tests config too: it only blocks
  more (such commands used to slip past the review, verify and docs gates).
- A command touching several repos (`git push && git -C /repo/B push`) is
  judged per repo: each repo's pushes against its own session, tests config
  and bypass, blocked if any repo blocks, with each blocking repo named. A
  bypass armed in one repo never waives another.
- `set-tests` warns when `--report` points inside the repo at a path that is
  not git-ignored.
- `test --preexisting <id>` proves a failure also fails on the session's base
  commit (temporary worktree, JUnit report required). Never proven by a crash,
  nor when two testcases in either report share the id (node's reporter uses
  classname `test` for every file, so same-named tests collide). A red full
  run whose report passed no tests (a misconfigured runner) cannot be waived.
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
  "<reason>"` closes a session that changed nothing, after the CLI checks it.
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
