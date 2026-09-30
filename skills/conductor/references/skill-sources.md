# Chain-plugin sources

Read this on a **chain-plugin gap** — a named `superpowers:*` / `codex:*`
process skill the run needs is not installed. `find-skills` / `npx skills`
target the skills.sh ecosystem and cannot reliably locate Claude Code
*plugins*, so these installs are curated here. Give the operator the exact
commands; offer to run them (assisted install — operator yes required; see the
conductor's "Skill source resolution"); never install without a yes.

| Skill family | Install commands | Notes |
|---|---|---|
| `superpowers:*` (brainstorming, writing-plans, using-git-worktrees, test-driven-development, subagent-driven-development, executing-plans, systematic-debugging, requesting-code-review, verification-before-completion, finishing-a-development-branch) | `claude plugin marketplace add obra/superpowers` then `claude plugin install superpowers@superpowers-marketplace` | The canonical process chain. One install covers every `superpowers:*` step. |
| `codex:*` review lanes (`/codex:review`, `/codex:adversarial-review`) | `claude plugin marketplace add openai/codex` then `claude plugin install codex@codex` | Read-only review lanes only. Never the write-capable `codex-rescue`. |
| Built-ins (`/code-review`, `/review`) | none — ship with Claude Code | If absent on an older build, degrade to `superpowers:requesting-code-review` for review. The verify phase is `superpowers:verification-before-completion`. |

**Restart caveat:** a newly installed plugin's skills and hooks load on the
**next Claude Code restart** — they are not usable in the current session even
after a successful install. Offer the operator: (a) proceed this run on the
built-in fallback (degrade recorded), or (b) install now, restart, and resume
(the session is resumable from state).

Verify the marketplace slugs against the operator's environment if an install
fails; these are the known-good defaults as of 2026-07.
