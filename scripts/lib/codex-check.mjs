// Warns when the Codex CLI on PATH is behind the latest release. Every
// review lane rides whatever `codex` binary is installed - nothing pins a
// version - so a stale CLI silently degrades reviews. Fails open on every
// path: no codex, no network, odd output => no notice.
import { execFileSync } from 'node:child_process';

const SEMVER = /(\d+)\.(\d+)\.(\d+)/;
const LATEST_URL = 'https://registry.npmjs.org/@openai/codex/latest';

export function updateNotice(installed, latest) {
  const a = SEMVER.exec(installed || ''), b = SEMVER.exec(latest || '');
  if (!a || !b) return null;
  for (let i = 1; i <= 3; i++) {
    if (+a[i] < +b[i]) return `codex: ${a[0]} installed, ${b[0]} available - run \`codex update\` (reviews use whatever CLI is on PATH)`;
    if (+a[i] > +b[i]) return null;
  }
  return null;
}

export async function codexUpdateNotice({ env = process.env, exec = execFileSync, fetchFn = fetch } = {}) {
  if (env.SENIOR_DEV_OFFLINE) return null;
  let installed;
  try {
    installed = exec('codex', ['--version'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
  try {
    const res = await fetchFn(LATEST_URL, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    return updateNotice(installed, (await res.json()).version);
  } catch { return null; }
}
