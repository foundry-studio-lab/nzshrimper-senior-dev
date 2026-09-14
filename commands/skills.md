---
description: Show and customise which skills fill each process phase · Foundry Studio
argument-hint: '[lane]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/state-cli.mjs" skills-config resolve --lane $ARGUMENTS`

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/state-cli.mjs" skills-config models --lane $ARGUMENTS`

Present both tables above to the operator verbatim. Then offer the
per-phase picker from the `senior-dev:conductor` skill ("Skill source
resolution" section): for any phase they want to change, collect their pick
and record it with
`state-cli skills-config set-lane <lane> --steps 'phase=skill|fallback,...'`.
For model tiers, record picks with
`state-cli skills-config set-models [--lane <lane>] --steps 'phase=<claude>[/<codex>],...'`
(a value of `/<codex>` sets the Codex effort only).
