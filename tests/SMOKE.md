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
       recorded via state-cli review; cycle 4 refused by CLI.
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
