# senior-dev smoke checklist

Run after every install/update, in a THROWAWAY repo (scratchpad), with the
plugin installed and Claude Code restarted.

Setup: `mkdir -p <scratch>/sd-smoke && cd <scratch>/sd-smoke && git init && git commit --allow-empty -m init`

1. [ ] New Claude session in the throwaway repo -> bootstrap context mentions
       senior-dev:conductor. In a non-git dir -> no mention.
2. [ ] /senior-dev:status -> "no active session".
3. [ ] /senior-dev:start add a hello script (quick-fix lane expected) ->
       state file created, .git/info/exclude contains .senior-dev/.
4. [ ] During implement with no tests-green: `git commit` -> BLOCKED with
       tests-green message. After state-cli tests-green -> commit passes.
5. [ ] `git push` before review/verify/docs -> BLOCKED listing blockers.
6. [ ] Claim "all done" with open items -> stop gate returns checklist once;
       identical second stop -> allowed through.
7. [ ] Waiting-state check: `state-cli waiting --on "<reason>"` -> claim
       "all done" with open items still open -> stop allowed (gate stands
       down); `state-cli finish` while the wait is armed -> refused, even
       with `--force-open`. `state-cli waiting --clear` -> next identical
       claim -> stop gate re-arms and challenges again.
8. [ ] /senior-dev:bypass testing the escape hatch -> next push allowed,
       bypass visible in /senior-dev:status.
9. [ ] Codex absent/unauthed simulation (or real /codex:review) -> verdict
       recorded via state-cli review; cycle 4 NEEDS_REVISION and any cycle
       >= 5 refused by CLI; cycle 4 APPROVED accepted as the confirmation.
10. [ ] /senior-dev:finish -> sweep evidence printed, state archived to
        .senior-dev/history/, /senior-dev:status -> "no active session".
11. [ ] Delete throwaway repo. Zero leftovers on the machine.
12. [ ] Skill-source (fresh repo): first `/senior-dev:start` asks the four-way
        source question, superpowers marked default. Answer `own`/`combo` ->
        `.senior-dev/skills.json` written; `state-cli skills-config show`
        reflects it; a second run confirms the saved default in one beat
        instead of re-asking.
13. [ ] Share opt-in: `state-cli skills-config share` -> skills.json no longer
        in `.git/info/exclude`; `unshare` re-hides it.
14. [ ] Chosen-but-missing chain plugin (simulate: pick superpowers where a
        step skill is absent) -> conductor prints the exact install command,
        offers to run it, states the restart caveat, and offers
        proceed-on-fallback vs install-restart-resume.
15. [ ] Guard consent: fresh repo run asks once; decline is remembered
        (state-cli guard status -> declined); /senior-dev:guard install works
        later.
16. [ ] Plain-terminal block: with guard installed and open gates staged,
        `git push` in a NON-agent terminal is blocked with the gate message.
17. [ ] Token flow (Claude Code): clear all gates, push via the session ->
        allowed once, no double block, no leftover pass.json.
18. [ ] Uninstall: prior hook restored byte-identical; guard status -> declined.
19. [ ] Codex re-test: sd-demo fixture push now BLOCKED in Codex.
20. [ ] Cowork re-test: sd-demo fixture push now BLOCKED in Cowork.
21. [ ] Picker: choose combo -> customise implement with a fallback list ->
        /senior-dev:skills shows it; skills.json is v2.
22. [ ] Production-mileage note: bypass consumption, degrade fallback, and
        quick-fix escalation have passed smoke but not a real production
        firing - treat their first real-world use with a skeptical eye and
        verify state afterwards.
23. [ ] Split verdict: stage claude APPROVED + codex NEEDS_REVISION on
        `implement` with verify/docs done -> `git push` BLOCKED by gate and
        by the hook -> `review --overrule` with a reason -> push ALLOWED;
        `status` shows `adjudications: 1 overruled, 0 upheld`.
24. [ ] `dispatch --phase implement --claude haiku` refuses ("never lowers");
        `--claude opus` without `--reason` refuses; with `--reason` records
        and `status` shows `models used:` with the raise.
25. [x] Test runner + ship on a REAL vitest repo (needs `junit` reporter):
        `skills-config set-tests` with full/related/one/report -> start a
        bug-fix, `test --affected` after an edit, `test --full` once; make a
        test fail on the base commit too -> `test --preexisting <id>` PROVEN
        -> `/senior-dev:ship <reason>` accepted, `status` shows the ship
        line; a failure caused by the diff -> ship refused naming it. A
        later commit without affected coverage -> `git push` BLOCKED.
        PASSED 24/24 on 2026-10-01 (vitest 3.2.6, scratch project with a
        nested `describe`, `setup` symlinking node_modules into the proof
        worktree, guard installed, real pushes to a bare origin). The first
        run on 0.4.0 FAILED: with the proven failure among the affected
        tests every scoped run was red, so commits and push coverage were
        impossible - fixed in 0.4.1 (`counts as green`); the same script
        fails 11 checks on 0.4.0.
        Re-run 2026-10-02 against 0.4.2: PASSED 24/24. One expectation changed
        by design (§3.4): after a later commit that touches only
        test/other.test.js, --affected now runs only that file (green) instead
        of re-running the unchanged math tests red on the proven failure.
26. [x] Reclassify: quick-fix session -> `state-cli reclassify --type
        bug-fix --reason "grew"` -> same session, phases kept, `status`
        shows the history; `--type docs-only` refused without `--by-operator`.
        PASSED 13/13 on 2026-10-01 against the installed 0.4.1 (scratch
        repo): chain becomes bug-fix with `implement` still done and its
        artefact kept, reviews and true docs items kept, no bypass, status
        line `reclassified: quick-fix -> bug-fix (grew)`, current phase
        `debug`; docs-only refused without the operator, accepted with
        `--by-operator`; `--type constructor` refused.
27. [x] `finish --no-change "<reason>"` on an untouched session -> archived
        with outcome no-change; after a commit -> refused. Cycle 4 accepts
        only `--verdict APPROVED`.
        PASSED 11/11 on 2026-10-01 against the installed 0.4.1 (real
        commits, branch, stash, tag in scratch repos): untouched -> archived
        `outcome: no-change` with the reason and no bypass; a commit ->
        `HEAD moved`; a stash -> `ref refs/stash changed`; a branch with a
        commit -> `branch side changed`; a lightweight tag at the base ->
        accepted; cycle 4 NEEDS_REVISION and cycle 5 refused, cycle 4
        APPROVED accepted and clears the gate.
28. [x] Test runner + ship with node's own runner (`node --test
        --test-reporter=junit --test-reporter-destination=report.xml
        'test/*.test.mjs'`), passed 14/14 on 2026-10-01 in scratch repos:
        pre-existing failure proven and shipped; diff-caused failure refused;
        same-named tests in two files refused as ambiguous; a narrowed `one`
        command still refused at ship (repeated failing ids); a test deleted
        on base and re-added in another file refused as a different test; a
        directory instead of a glob (`test/`) refused as "passed no tests".
        Re-run after any change to the proof, `parseJUnit` or `testBlockers`.
        Re-run 2026-10-02 against 0.4.2: PASSED (all checks).
29. [x] Live `review-run.mjs` on a scratch repo with a planted off-by-one:
        PASSED 6/6 on 2026-10-02. Headless claude (sonnet): exit 0,
        NEEDS_REVISION naming the bug, 11 s. Codex lane (effort low): exit 0,
        NEEDS_REVISION, 25 s. `git status` and HEAD unchanged for both. The
        runner also ran this branch's own Codex reviews live (cycles 1-4).
