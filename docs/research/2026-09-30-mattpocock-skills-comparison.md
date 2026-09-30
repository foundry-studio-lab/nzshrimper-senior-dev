# senior-dev vs mattpocock/skills — comparison

Date: 2026-09-30. Compared against senior-dev 0.3.1 (`f2c315f`) and
[mattpocock/skills](https://github.com/mattpocock/skills) v1.3 (`d81f3a1`,
cloned to `~/code/mattpocock-skills`). Evidence, not a decision: anything we
adopt goes through a spec.

## 1. What each one is

**senior-dev enforces a process and owns almost none of its content.** One
skill (`conductor`), a state CLI, three hooks (SessionStart, PreToolUse commit
gate, Stop gate) and optional git-hook guards. It classifies a task into one of
six lanes, walks a fixed phase spine, and fills each phase with someone else's
skill (superpowers by default, or `own` / `combo` / `suggest`). What it adds on
top is machinery: recorded phases, commit/push/PR gates, a read-only Codex
review with a JSON verdict, adjudication of split verdicts, a 3-cycle cap,
per-phase model tiers, a docs gate, a hygiene sweep, and logged bypasses.

**mattpocock/skills is content and deliberately no enforcement.** About 27
small, composable skills; no hooks, no state, no gates. The README positions
it *against* process owners ("GSD, BMAD, Spec-Kit … take away your control").
It relies on per-repo config written once by `/setup-matt-pocock-skills`
(`docs/agents/issue-tracker.md`, `triage-labels.md`, `domain.md`) and on a
living domain model (`GLOSSARY.md` + `docs/adr/`). The human is the
orchestrator; `/ask-matt` is a router that tells them which skill to type next.

Main flow: `grill-with-docs → (prototype) → to-spec → to-tickets →
implement | implement-spec (drives tdd) → code-review → pr → retro`.
On-ramps: `triage` (incoming issues), `diagnosing-bugs` (hard bugs),
`wayfinder` (efforts bigger than one session).

| | senior-dev | mattpocock/skills |
|---|---|---|
| Shape | 1 orchestrator skill + CLI + hooks | ~27 independent skills |
| Control | Gates block git actions; stop gate challenges "done" | None; human drives |
| State | `.senior-dev/state.json`, history archive | Repo artefacts only (tracker, GLOSSARY, ADRs) |
| Planning artefact | Committed spec + plan files | Spec + tickets on the issue tracker, with blocking edges |
| Review | Claude `/code-review` + Codex, JSON verdict, adjudicator | Two-axis (Standards / Spec) parallel subagents |
| Cross-model | Yes (Codex) | No |
| Context management | Model tiers per phase | Phase-boundary tree (continue / clear / handoff / subagent / compact) |
| Close-out | Docs gate + hygiene sweep + archive | `pr` body shape + `retro` on the environment |
| Distribution | Own marketplace | Official Claude Code marketplace (`mattpocock-skills`) or skills.sh copies |

## 2. Phase-by-phase mapping

| senior-dev phase | Fills it today | Matt equivalent | Callable by the conductor? |
|---|---|---|---|
| brainstorm | `superpowers:brainstorming` | `grill-with-docs` = `grilling` + `domain-modeling` | the two parts: yes; the wrapper: no |
| plan | `superpowers:writing-plans` | `to-spec` + `to-tickets` | no |
| worktree | `superpowers:using-git-worktrees` | inside `implement-spec` (one worktree per implementer) | no |
| implement | `subagent-driven-development` / `executing-plans` | `implement` (one ticket) / `implement-spec` (task-graph frontier, parallel implementers, integration branch) | no |
| TDD | `superpowers:test-driven-development` | `tdd` (seams agreed with the user before any test) | yes |
| debug | `superpowers:systematic-debugging` | `diagnosing-bugs` (tight, red-capable loop first; 3–5 falsifiable hypotheses; tagged debug logs) | yes |
| review | `superpowers:requesting-code-review` + `/code-review` + Codex | `code-review` (Standards + Fowler smell baseline, and Spec) | yes |
| verify | built-in `verify` + `verification-before-completion` | none (evidence lives in `pr`) | — |
| docs | spec / plan / handover / affectedDocs gate | `domain-modeling` (GLOSSARY + ADR), `handoff` | modeling: yes; handoff: no |
| finish | `finishing-a-development-branch` + sweep | `pr` (summary visual, before/after evidence, one-way/two-way door, blast radius) | yes |
| investigation lane | inline | `research` (background agent, cited file) | yes |

**Only senior-dev has:** enforcement gates, session state, the cross-model
Codex pass, adjudication, model tiers, the hygiene sweep, the bypass audit
trail, and git-level guards that hold outside Claude Code.

**Only Matt has:**
- `retro`: improves the agent's *environment* after a session (mechanical
  mistakes → automated checks, judgement calls → `CODING_STANDARDS.md`).
- `triage`: issue state machine, agent briefs, `.out-of-scope/` memory.
- `wayfinder`: decision-ticket map for efforts too big for one session.
- `prototype`: throwaway logic (single HTML file) or UI (variants behind `?variant=`).
- `codebase-design` / `improve-codebase-architecture`: deep-module vocabulary
  and an HTML report of deepening candidates.
- Phase-boundary guidance (`ask-matt/PHASE-BOUNDARIES.md`).
- `wizard` (human-only setup steps as a bash script), `to-questionnaire`,
  `writing-for-agents` (how to write skills/CLAUDE.md), `teach`, `wait-what`.

## 3. Why the conductor can't start most of the flow skills

Every skill in Matt's set is one of two kinds, set in its frontmatter:

- **Model-invoked** (no flag): the description sits in the agent's context and
  the Skill tool can fire it, from the model or from another skill.
- **User-invoked** (`disable-model-invocation: true`): Claude Code drops it
  from the Skill tool entirely. Only a human typing `/name` runs it. No skill
  can call it, including the conductor.

Matt makes this choice deliberately (`.agents/invocation.md`,
`writing-for-agents/SKILL-MECHANICS.md`): a user-invoked skill costs zero
context tokens, because its description is never loaded, and it keeps the human
as the orchestrator. His own rule is "a user-invoked skill can never be reached
this way, full stop."

**User-invoked (the conductor cannot call them):** `ask-matt`, `grill-me`,
`grill-with-docs`, `setup-matt-pocock-skills`, `to-spec`, `to-tickets`,
`implement`, `implement-spec`, `triage`, `wayfinder`,
`improve-codebase-architecture`, `retro`, `handoff`, `teach`,
`to-questionnaire`, `wait-what`.

**Model-invoked (callable):** `grilling`, `domain-modeling`, `tdd`,
`diagnosing-bugs`, `code-review`, `pr`, `prototype`, `research`,
`codebase-design`, `wizard`, `writing-for-agents`.

Observed on this machine, 2026-09-30: a session opened in `tyrelab-website`,
which has the whole set installed as project skills. Its Skill tool listing
contained `grilling`, `tdd`, `diagnosing-bugs`, `research`, `prototype` and the
other model-invoked skills. None of `to-spec`, `to-tickets`, `implement`,
`triage`, `wayfinder` or `handoff` appeared, although their files were there.

### What we could do if we want their functions

Ranked roughly from lightest to heaviest:

1. **Compose the model-invoked parts.** Several wrappers are thin:
   `grill-with-docs` is literally "call grilling, then domain-modeling";
   `implement` is "tdd at agreed seams, then code-review, then commit". The
   conductor can call the parts directly. Costs nothing and is upstream-safe.
   It covers brainstorm, implement, debug, review and finish.
2. **Hand the step to the operator.** At the phase, the conductor says
   "type `/to-tickets` now", waits, then records the phase from the artefact
   it produced. This matches Matt's intent (human-in-the-loop steps like the
   `to-tickets` quiz or `triage` are meant to be human-driven). Costs one
   manual keystroke per phase.
3. **Read-and-follow.** The conductor `Read`s the installed `SKILL.md`
   (plugin cache or `.claude/skills/`) and follows it as instructions, the
   same way it already locates the Codex companion script by path. Works for
   any skill, but it goes around the author's invocation choice, depends on
   the install path and version, and a missing file has to be recorded as a
   degrade.
4. **Vendor adapted copies into senior-dev.** MIT licence allows it with
   attribution (e.g. a `senior-dev:to-tickets`). Full control, but we own the
   drift from upstream, and it contradicts senior-dev's rule that it
   "duplicates none of them".
5. **Flip the flag locally.** A skills.sh install is editable files, so
   deleting `disable-model-invocation` makes them callable. Fine for one
   machine; not shippable to senior-dev users, and `npx skills update`
   overwrites it.

Initial recommendation: **1** wherever a wrapper decomposes, **2** for steps
that are human checkpoints by design (to-tickets, triage, wayfinder), and
**3** only as an opt-in fallback behind a degrade record. Avoid 4 and 5.

## 4. Collisions found on this machine

- **`code-review` name clash.** `~/.claude/skills/code-review` points to
  Matt's two-axis review (`~/.agents/skills/code-review`). The conductor's
  "built-in `/code-review`" may therefore be running Matt's skill, not
  Anthropic's; the official plugin also ships `code-review:code-review`. The
  review phase should name exactly which one it means.
- **Duplicate installs.** `tyrelab-website` carries Matt's set twice
  (`.claude/skills/` and `.agents/skills/`, from skills.sh) at an older
  version: no `implement-spec`, `pr` or `retro`. Matt's README warns plugin
  and skills.sh installs duplicate each other.

## 5. Candidate improvements (for discussion, not decided)

1. **Spec axis in review.** senior-dev review, including the Codex prompt,
   checks correctness and doc claims but never whether the diff matches the
   committed spec. Add Matt's Spec axis (missing / scope creep / wrong) and
   the smell baseline as a judgement-only Standards layer.
2. **`retro` at finish.** A closing step that turns this run's mistakes into
   automated checks or standards. It fits the zero-leftovers ethos.
   Operator-typed (option 2), or a light built-in equivalent.
3. **Red-loop gate on debug.** Record `diagnosing-bugs`' completion
   criterion: one command, already run, that goes red on the reported symptom,
   before `debug → implement`. Mirrors `tests-green`.
4. **Seams in the plan.** Make "test seams agreed with the operator" a plan
   artefact item (Matt's `tdd` / `to-spec` rule).
5. **`pr` body at PR creation.** The finish step writes the PR with summary
   visual, before/after evidence, and merge-danger door + blast radius.
6. **Phase-boundary context advice.** At each recorded phase transition,
   apply the continue / clear / handoff / subagent / compact tree, not only
   model tiers.
7. **A `matt` skill source.** Add `mattpocock-skills` to
   `references/skill-sources.md` and a `matt` (or combo) phase map, using the
   callable/uncallable split in §3.
8. **Tickets as a planning option.** For multi-session features, plan as
   `to-spec` + `to-tickets` with blocking edges, and let implement work the
   frontier (`implement-spec` pattern) with senior-dev's gates on the
   integration branch.
9. **Audit the conductor with `writing-for-agents`.** It is long and leans
   on negation-style rules ("never …"); the skill's context-load, no-op and
   leading-word guidance would likely shorten it.
10. **Philosophy guard.** senior-dev is exactly the "process owner" Matt
    argues against. Whatever we adopt should keep his skills usable
    standalone and never force his flow; bypass and `own` sources already
    point that way.
