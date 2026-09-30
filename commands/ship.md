---
description: Waive test failures proven to pre-exist on the base commit (operator-only, reason required, logged) · Foundry Studio
argument-hint: '<reason>'
allowed-tools: Bash(node:*)
---

The operator wants to ship past test failures that already fail on the base commit. Their reason: $ARGUMENTS

If the reason is empty, ask for one - a ship without a reason is refused.

Run:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/state-cli.mjs" ship --reason-stdin <<'SENIOR_DEV_EOF'
$ARGUMENTS
SENIOR_DEV_EOF
```

If it refuses, relay the refusal verbatim; do not work around it.

Confirm to the operator: this waives ONLY test failures proven pre-existing
on the base commit. Reviews, verify and the docs gate still gate, every new
commit still needs affected-test coverage, and the reason is logged in
session state and shown in the finish summary.
