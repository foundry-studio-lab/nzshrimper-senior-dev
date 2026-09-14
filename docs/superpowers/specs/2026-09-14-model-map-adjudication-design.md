# senior-dev v0.3 — Per-phase Model Map + Review Adjudication — Design Spec

**Date:** 2026-09-14
**Status:** Approved design, pre-implementation
**Owner:** Chris Bennett
**Repo:** `~/code/nzshrimper-senior-dev` (marketplace `nzshrimper-senior-dev`)

## 1. Purpose

Two features, one release:

1. **Per-phase model map.** The conductor tiers subagents from prose in its
   Model economy section and from the operator's memory. v0.3 moves the tiers
   into `skills.json`: each phase names a Claude tier for subagent dispatch
   and a Codex effort for its review pass. The conductor reads the pair from
   the CLI, passes `model:` on every dispatch, and records each dispatch so
   the finish report shows the models a run actually used.
2. **Review adjudication.** Today a split verdict (one reviewer APPROVED, the
   other NEEDS_REVISION) triggers a full re-review cycle. v0.3 hands only the
   disputed concerns to an adjudicator on the configured `adjudicate` tier
   (fable by default, above every default reviewer tier). Upheld concerns
   enter the fix loop. Overruled concerns come to the operator as a
   single yes or no; only that yes clears the block.

The work also fixes a latent gate bug found while reading the verdict code
(section 6).

## 2. Operator decisions (locked)

| Decision | Choice |
|---|---|
| Map scope | Claude tier + Codex **effort** per phase. Codex **model** stays in `~/.codex/config.toml`; the plugin never carries OpenAI model names. |
| Adjudication | Adjudicator recommends, operator confirms each overrule. No automatic overrule. |
| Default tiers | Balanced: implement sonnet; review sonnet + Codex medium; debug opus; finish opus + Codex high; adjudicate fable. Brainstorm, plan, worktree, verify, docs, investigate: controller inline, no dispatch. |
| Floor semantics | Configured tiers are floors. The conductor may raise on the SDD complexity signals and must record the reason. It never lowers. |
| Codex pass | Switch from the plugin's built-in `review` lane (no effort control) to `task --fresh --effort <x>` with a stored read-only, JSON-first prompt. Before/after write detection stays. |
| Dispatch ledger | Yes: every subagent dispatch is recorded with phase, tier, floor, and reason. |

## 3. skills.json schema v3

v3 adds one optional block. v1 and v2 files keep working; a file without
`models` resolves every phase to the built-in defaults.

```json
{
  "version": 3,
  "source": "superpowers",
  "shared": false,
  "guard": "installed",
  "steps": { "review": "code-review" },
  "lanes": { "feature": { "plan": ["own:planner", "superpowers:writing-plans"] } },
  "models": {
    "steps": {
      "implement":  { "claude": "sonnet" },
      "review":     { "claude": "sonnet", "codex": "medium" },
      "debug":      { "claude": "opus" },
      "finish":     { "claude": "opus",   "codex": "high" },
      "adjudicate": { "claude": "fable" }
    },
    "lanes": {
      "feature": { "finish": { "codex": "xhigh" } }
    }
  }
}
```

Validation (`readSkillsConfig` returns `null` on any breach, as today):

- `version` is 1, 2, or 3.
- `models`, when present, is an object with optional `steps` and `lanes`.
- Every phase entry is an object with optional `claude` in
  `['haiku', 'sonnet', 'opus', 'fable']` and optional `codex` in
  `['low', 'medium', 'high', 'xhigh']`. Any other key or value is a breach.
- Phase keys must be a phase name from any chain, or `adjudicate`.
- `models.lanes` keys must be lane types from `CHAINS`.

Built-in defaults live in `lib/state.mjs` as `DEFAULT_MODELS`, the Balanced
table above. Tier order for floor checks: `haiku < sonnet < opus < fable`.

**Resolution** (`resolveModel(cfg, laneType, phase)`) merges per field, so a
lane entry that sets only `codex` keeps the `claude` from `steps` or the
default: `lanes[lane][phase].<field>` → `steps[phase].<field>` →
`DEFAULT_MODELS[phase].<field>` → absent. It returns
`{ claude, codex, via: { claude, codex } }` where each `via` is `lane`,
`steps`, `default`, or `none`.

## 4. Component: CLI

All commands run from the target repo through `state-cli.mjs`.

| Command | Session needed | Behaviour |
|---|---|---|
| `skills-config models [--lane <lane>]` | no | Prints the resolved table for every phase in the lane's chain plus `adjudicate`, with `via` per field. Without `--lane` it uses the active session's type, else `feature` (the same default as `skills-config resolve`, so `/senior-dev:skills` shows both tables at one scope; changed in 0.3.1 from a flat `steps` view). |
| `skills-config set-models [--lane <lane>] --steps '<phase>=<claude>[/<codex>],...'` | no | Writes `models.steps` (no `--lane`) or `models.lanes[lane]`. A value of `/<codex>` sets effort only. Bumps `version` to 3 and preserves every other field (the v0.2 `set` regression must not recur). Validates tiers and efforts; rejects unknown phases. |
| `models --phase <phase> [--json]` | yes | Read-only lookup for the active lane: prints one line `claude=<tier|none> codex=<effort|none>`. |
| `dispatch --phase <phase> [--claude <tier> --reason "<why>"]` | yes | Records a subagent dispatch and prints the pair to use. Without `--claude` it records the floor. With `--claude` above the floor, `--reason` is required; `--reason` without a raise is refused (0.3.1), so the ledger never records a dropped reason. Below the floor it fails: `dispatch never lowers the configured floor`. Appends `{ phase, claude, floor, reason, at }` to `state.dispatches`. |
| `review --phase <p> --reviewer <r> --cycle <n> --overrule --reason "<text>"` | yes | Records an operator-confirmed overrule. Preconditions: a review for `{phase, reviewer, cycle}` with `NEEDS_REVISION` exists, it is that reviewer's latest verdict for the phase, and the other reviewer's latest verdict for the phase (any cycle) is `APPROVED`. Appends `{ phase, cycle, reviewer, decision: 'overruled', by, reason, at }` to `state.adjudications`. `--by <tier>` defaults to the resolved `adjudicate` tier. |
| `review ... --uphold --reason "<text>"` | yes | Same record with `decision: 'upheld'`. Informational; the fix loop runs as today. |

`status` gains two lines when the arrays are non-empty:
`models used: sonnet×3, opus×1 (raised: implement "multi-file integration")`
and `adjudications: 1 overruled, 0 upheld`. `finish` carries them into the
archived state; the finish report quotes them.

## 5. Component: conductor changes

**Model economy** becomes mechanical. Before every subagent dispatch the
conductor runs `state-cli dispatch --phase <phase>` and passes the printed
tier as `model:`. To raise above the floor it names one of the SDD
complexity signals (multi-file integration, debugging, design judgement,
subtle or risky diff, fix-loop escalation at rounds 4–5) in `--reason`. It
never lowers. Brainstorm, plan, worktree, verify, docs, and investigate run
inline on the controller.

**Codex pass (§3 step 2)** runs
`node <codex-plugin>/scripts/codex-companion.mjs task --fresh --effort <codex>`
where `<codex>` comes from `state-cli models --phase review` (per-phase
passes) or `--phase finish` (final pass). The prompt is
the template at `skills/conductor/references/codex-review-prompt.md`: the
diff range, an instruction to read only, an instruction to check any repo
document or policy the diff touches, and the JSON verdict contract as the
only permitted reply. `--write` is never passed. The before/after
`git status --porcelain` and `git log -1` check stays. A non-JSON reply is
re-asked once, as today. `/codex:adversarial-review` stays available to the
operator directly.

**Adjudication (§3 step 3a)** triggers when the two reviewers' latest
verdicts for a phase differ, whatever cycle each was recorded at. The
conductor:

1. Runs `state-cli models --phase adjudicate` and dispatches one subagent on
   that tier with: the disputed concerns verbatim, the diff range, the
   approving reviewer's reasoning if any, and this reply contract only:
   `{"concerns":[{"id":"<n>","decision":"uphold"|"overrule","reason":"<text>"}]}`.
2. Any upheld concern → the fix loop; no overrule is recorded for that cycle
   (an overrule is reviewer-wide).
3. Every concern overruled → one operator question; on yes `review --overrule`
   per reviewer with the operator's reason; on no, the fix loop.
4. A non-JSON adjudicator reply counts as all upheld. The conductor says so.

Adjudication consumes no review cycle. The cycle cap of 3 is unchanged.
Nothing but the operator's yes clears a block; the conductor never arms an
overrule itself.

## 6. Verdict resolution fix

`latestVerdicts(state)` today keeps the last review recorded for a phase,
whichever reviewer wrote it. A Claude approval recorded after a Codex
rejection therefore passes the gate. v0.3 resolves per reviewer:

- For each phase, take each reviewer's latest-cycle verdict.
- The phase is `NEEDS_REVISION` if any such verdict is `NEEDS_REVISION`
  without a matching `overruled` adjudication for `{phase, reviewer, cycle}`.
- Otherwise the phase is `APPROVED`.

A phase with one reviewer's approval and no other verdict stays `APPROVED`,
which keeps docs-only lanes (no Codex pass) working. The return shape
`{ phase: verdict }` is unchanged, so `status`, `openGateItems`,
`integrationBlockers`, and the guard bundle need no call-site changes. The
guard bundle copies `lib/state.mjs` at install; the version stamp already
reports `stale` after a plugin bump, and `guard install` refreshes it. The
review CLI refuses a second record for the same reviewer, phase and cycle; a
verdict changes only at the next cycle or by an overrule.

## 7. Failure modes

| Situation | Behaviour |
|---|---|
| v3 file read by a v0.2 plugin | `readSkillsConfig` returns `null` (unknown version); the conductor treats the config as absent and asks the four-way question. Documented in CHANGELOG. |
| Unknown tier or effort in config or flags | Config: `null` (as any schema breach). Flags: fail with the allowed list. |
| `models` or `dispatch` without a session | Fail: `no active senior-dev session`. |
| `dispatch --claude` below the floor | Fail; nothing recorded. |
| `dispatch --claude` above the floor without `--reason` | Fail; nothing recorded. |
| `dispatch --reason` without a raise (no `--claude`, or `--claude` at the floor) | Fail; nothing recorded (0.3.1). |
| `models --json <value>` | Fail: `--json` takes no value (0.3.1). |
| `--overrule` without a matching `NEEDS_REVISION`, or when the other reviewer also rejected | Fail; nothing recorded. |
| `--overrule` or `--uphold` beside `--verdict` | Fail; nothing recorded (0.3.1). |
| `set-models` / `set-lane` with an empty `--steps`, a phase named twice, or (`set-models`) more than one `/` in an entry | Fail; nothing written (0.3.1). |
| Adjudicator returns non-JSON | All concerns upheld; fix loop; conductor reports it. |
| Codex `task` lane writes to the repo | Existing write-detection: stop, tell the operator. |

## 8. Testing

Node tests, no frameworks, in `tests/`:

- `skills-v3.test.mjs`: v3 read/write; v1 and v2 files still parse; every
  validation breach returns `null`; field-level resolution precedence
  (lane → steps → default → none) including a lane entry that sets only
  `codex`.
- `models-cli.test.mjs`: `skills-config models` table; `set-models` writes
  steps and lanes, bumps to v3, preserves `source`, `shared`, `guard`,
  `steps`, `lanes`; rejects bad phases, tiers, efforts; `models --phase`
  output; `dispatch` records the floor, requires a reason above it, refuses
  below it.
- `verdicts.test.mjs`: split verdicts in every recording order resolve to
  `NEEDS_REVISION`; a later approval by the rejecting reviewer resolves to
  `APPROVED`; a single-reviewer approval resolves to `APPROVED`; an
  overruled adjudication clears the block; `integrationBlockers` follows.
- `review-overrule.test.mjs`: the preconditions in section 4; the record
  shape; `--by` default.
- `guard.test.mjs` (extend): after `guard install`, the bundle blocks a push
  on a split verdict and allows it after an overrule.
- All existing tests stay green; the CLI test helpers keep
  `SENIOR_DEV_OFFLINE=1`.

## 9. Out of scope (v0.3)

- Codex model per phase.
- A picker UI for models; `set-models` is CLI only, `/senior-dev:skills`
  prints the resolved models table beneath the skills table.
- Automatic overrule.
- A skills-used ledger; the dispatch ledger records models only.
- Routing for the Workflow tool.
- Cost estimates in the ledger.

## 10. Versioning and docs

- Version 0.3.0 in both `.claude-plugin/plugin.json` and
  `.claude-plugin/marketplace.json` (0.3.1 after the hygiene pass that
  added the refusals noted in §4 and §7).
- README: skills.json v3 example; commands table rows for `models`,
  `set-models`, `dispatch`, `review --overrule`; a short "Models" section
  after "Skills".
- CHANGELOG 0.3.0 entry, including the v0.2-reads-v3 note.
- `skills/conductor/SKILL.md`: Model economy rewritten; §3 step 2 Codex
  command; §3 step 3a adjudication; status lines.
- New `skills/conductor/references/codex-review-prompt.md`.
- `commands/skills.md`: also prints `skills-config models`.
- `tests/SMOKE.md`: item 21, split verdict → adjudication → overrule
  confirmed → push allowed; item 22, `dispatch` refuses a lower tier.
- PRIVACY.md unchanged: nothing new touches the network.

## 11. Success criteria

- A fresh repo with no `models` block resolves the Balanced defaults for
  every phase, and `skills-config models --lane feature` prints them.
- Every subagent dispatch in a run appears in `state.dispatches`, and
  `status` reports the tier counts.
- A staged split verdict blocks `git push` through both the PreToolUse gate
  and the git hook; one operator-confirmed overrule unblocks it; the
  adjudication is visible in `status` and in the archived state.
- The full suite is green with the CLI helpers offline.
