import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateNotice, codexUpdateNotice } from '../scripts/lib/codex-check.mjs';

const okJson = (body) => async () => ({ ok: true, json: async () => body });

test('updateNotice names both versions and codex update when behind', () => {
  const n = updateNotice('0.151.0', '0.154.0');
  assert.ok(n.includes('0.151.0') && n.includes('0.154.0') && n.includes('codex update'));
});

test('updateNotice is null when current, ahead, or unparsable', () => {
  assert.equal(updateNotice('0.154.0', '0.154.0'), null);
  assert.equal(updateNotice('0.155.0', '0.154.0'), null);
  assert.equal(updateNotice('0.9.0', '0.10.0') !== null, true); // numeric, not lexical
  assert.equal(updateNotice('garbage', '0.154.0'), null);
  assert.equal(updateNotice('0.154.0', null), null);
});

test('codexUpdateNotice returns notice from injected exec + fetch', async () => {
  const exec = () => 'codex-cli 0.151.0\n';
  const n = await codexUpdateNotice({ env: {}, exec, fetchFn: okJson({ version: '0.154.0' }) });
  assert.ok(n.includes('0.154.0'));
});

test('codexUpdateNotice fails open: codex absent, fetch failing, non-ok response', async () => {
  const throwing = () => { throw new Error('ENOENT'); };
  assert.equal(await codexUpdateNotice({ env: {}, exec: throwing, fetchFn: okJson({ version: '9.9.9' }) }), null);
  const exec = () => 'codex-cli 0.151.0';
  assert.equal(await codexUpdateNotice({ env: {}, exec, fetchFn: async () => { throw new Error('offline'); } }), null);
  assert.equal(await codexUpdateNotice({ env: {}, exec, fetchFn: async () => ({ ok: false }) }), null);
});

test('SENIOR_DEV_OFFLINE skips the check without touching codex or the network', async () => {
  let touched = false;
  const exec = () => { touched = true; return 'codex-cli 0.1.0'; };
  const fetchFn = async () => { touched = true; return { ok: true, json: async () => ({ version: '9.9.9' }) }; };
  assert.equal(await codexUpdateNotice({ env: { SENIOR_DEV_OFFLINE: '1' }, exec, fetchFn }), null);
  assert.equal(touched, false);
});
