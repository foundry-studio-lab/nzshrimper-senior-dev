# Privacy Policy

**Plugin:** senior-dev (a Claude Code plugin)
**Publisher:** Foundry Studio (Chris Bennett)
**Last updated:** 2026-10-04

## The short version

senior-dev collects nothing and stores nothing off your machine. It runs
locally, inside your own Claude Code environment. Its own one outbound
request is a version lookup, described below, which carries no data about you.
Its review runner hands your repository to the Codex or `claude` CLI you
installed, which sends it to that provider under its own terms (see
"Third-party tools you invoke").

## What the plugin does with data

Everything senior-dev touches stays on your computer:

- **Session state.** It reads and writes `.senior-dev/state.json` and
  `.senior-dev/skills.json` in the repository you are working in, and archives
  closed sessions to `.senior-dev/history/`. These are plain local files.
- **Your session transcript.** The stop gate reads the local Claude Code
  transcript file to check whether a turn claims completion. It reads it in
  place; it never copies or transmits it.
- **Local commands.** It runs local `git` and `node` commands (the state CLI)
  and reads your working tree. senior-dev itself uploads nothing. The one
  exception is the review runner, which hands your repository to a reviewer
  CLI you installed (see "Third-party tools you invoke").

## What it does not do

- No telemetry, analytics, tracking, or usage reporting.
- No network requests of its own, with one disclosed exception: when the
  Codex CLI is installed, `status` fetches the latest published version from
  `https://registry.npmjs.org/@openai/codex/latest` so it can warn you when
  your CLI is behind. It is a plain GET with no payload, no identifier, and
  no data about you or your repository; the response is compared and
  discarded. It is capped at 1.5 seconds and fails silently. Set
  `SENIOR_DEV_OFFLINE=1` to disable it. senior-dev itself contacts no other
  server and does not phone home; the reviewer CLIs it launches (below)
  make their own connections.
- No collection of personal data, code, credentials, or environment variables.

## Third-party tools you invoke

senior-dev can suggest running tools you have installed separately — for
example a read-only Codex review, or a `find-skills` search of the public
skills directory. Those tools run under their own terms and privacy policies;
senior-dev does not send them anything beyond the actions you choose to take.

The review runner (`scripts/review-run.mjs`) itself launches your installed
Codex CLI (through the Codex plugin's companion) or `claude -p`. Those tools
send the review prompt and the repository content they read to OpenAI or
Anthropic respectively, under those companies' own terms, using the account
you are logged into. senior-dev sends nothing itself; the runner hands your
repository to the reviewer CLI you installed.

## Changes

Any change to this policy will be committed to this repository with a new
"Last updated" date.

## Contact

Questions about privacy: nzshrimper@gmail.com — https://foundrystudio.app
