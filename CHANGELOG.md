# Changelog

## 0.3.0 — 2026-09-14

- Per-phase model map in `skills.json` (schema v3, optional `models`
  block): a Claude tier and a Codex effort per phase, per-field precedence
  lane → steps → built-in Balanced defaults. New `skills-config models`,
  `skills-config set-models`, `models --phase`, and a `dispatch` ledger
  that refuses to lower a floor and requires a reason to raise one.
  `status` reports the tiers used.
- Review adjudication: a split verdict goes to an adjudicator one tier up;
  `review --overrule` records the operator's confirmed overrule (and
  `--uphold` the audit trail). Nothing but the operator's yes clears a
  block.
- Gate fix: verdicts now resolve per reviewer. Previously the last review
  recorded for a phase decided it, so an approval recorded after another
  reviewer's rejection passed the gate.
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
