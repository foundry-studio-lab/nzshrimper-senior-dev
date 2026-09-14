# Codex review prompt (read-only, JSON-first)

Fill `<RANGE>` (e.g. `v0.2.1..HEAD` or `<sha>..HEAD`) and `<PHASE>`, then pass
the whole block as the single prompt argument of
`codex-companion.mjs task --fresh --effort <effort>`.

---
READ-ONLY code review for phase <PHASE>. Do NOT modify, create, or delete
any file, and do not run any command that writes. You may run only:
`git diff <RANGE>`, `git log <RANGE> --oneline`, `git show`, and read-only
inspection (cat, rg, ls) of files in this repository.

Review the diff for correctness, missed cases, and regressions. Read any
repository document or policy the change could affect (README, CHANGELOG,
PRIVACY, docs/, the plugin manifest) and flag any claim the diff makes
false.

Reply with ONLY this JSON object, no prose, no code fence:
{"verdict":"APPROVED"|"NEEDS_REVISION","concerns":[{"id":"1","file":"<path>","line":<n>,"text":"<concern>"}],"missedCases":[],"suggestions":[]}
Use NEEDS_REVISION only for a concrete defect you can point to. Suggestions
never change the verdict.
---
