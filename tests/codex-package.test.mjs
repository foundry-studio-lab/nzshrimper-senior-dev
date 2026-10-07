import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildCodexPackage } from '../scripts/build-codex-package.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const BUILD = join(root, 'scripts', 'build-codex-package.mjs');
const NOTE = "`<plugin>` is this plugin's folder; the senior-dev session-start banner prints the state CLI's exact path.";
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const built = () => { const out = join(tmp('sd-cx-'), 'mkt'); buildCodexPackage({ repoRoot: root, out }); return out; };
const plug = (out) => join(out, 'plugins', 'senior-dev');
// Every file path under dir, relative.
const walk = (dir, base = dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = join(dir, e.name);
  return e.isDirectory() ? walk(p, base) : [p.slice(base.length + 1)];
});
// The frontmatter fields of a SKILL.md (values JSON-decoded when quoted).
const front = (text) => Object.fromEntries(text.split('\n---\n')[0].replace(/^---\n/, '').split('\n').map((l) => {
  const i = l.indexOf(':'); const v = l.slice(i + 1).trim();
  return [l.slice(0, i), v.startsWith('"') ? JSON.parse(v) : v];
}));
// A minimal repo copy the build can run against.
const fixture = () => {
  const f = tmp('sd-cx-fix-');
  for (const p of ['.codex-plugin', 'skills', 'scripts', 'hooks', 'commands', 'LICENSE', 'README.md', 'PRIVACY.md', 'CHANGELOG.md']) cpSync(join(root, p), join(f, p), { recursive: true });
  return f;
};
const MARKETPLACE = {
  name: 'nzshrimper-senior-dev',
  interface: { displayName: 'Foundry Studio' },
  plugins: [{ name: 'senior-dev', source: { source: 'local', path: './plugins/senior-dev' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Developer Tools' }],
};

test('codex manifest carries the spec fields', () => {
  const m = JSON.parse(read('.codex-plugin/plugin.json'));
  assert.equal(m.name, 'senior-dev');
  assert.equal(m.skills, './skills/');
  assert.equal(m.hooks, './hooks/hooks.json');
  assert.equal(m.license, 'MIT');
  assert.equal(m.interface.displayName, 'senior-dev');
  assert.equal(m.interface.category, 'Developer Tools');
  assert.equal(m.interface.developerName, 'Foundry Studio');
  assert.equal(m.interface.privacyPolicyURL, 'https://github.com/foundry-studio-lab/nzshrimper-senior-dev/blob/main/PRIVACY.md');
  assert.deepEqual(m.interface.defaultPrompt, ['Start a senior-dev session for this task', 'Show the senior-dev session status', 'Finish and close this senior-dev session']);
  assert.ok(m.interface.defaultPrompt.every((p) => p.length < 128));
});

test('all three manifests agree on 0.5.0', () => {
  const c = JSON.parse(read('.claude-plugin/plugin.json'));
  const k = JSON.parse(read('.claude-plugin/marketplace.json'));
  const x = JSON.parse(read('.codex-plugin/plugin.json'));
  assert.deepEqual([c.version, k.metadata.version, k.plugins[0].version, x.version], ['0.5.0', '0.5.0', '0.5.0', '0.5.0']);
});

test('build: marketplace file is exactly the spec entry', () => {
  const out = built();
  assert.deepEqual(JSON.parse(readFileSync(join(out, '.agents', 'plugins', 'marketplace.json'), 'utf8')), MARKETPLACE);
});

test('build: the plugin folder holds only the runtime files', () => {
  const p = plug(built());
  assert.deepEqual(readdirSync(p).sort(), ['.codex-plugin', 'CHANGELOG.md', 'LICENSE', 'PRIVACY.md', 'README.md', 'hooks', 'scripts', 'skills']);
  assert.ok(existsSync(join(p, 'scripts', 'lib', 'state.mjs')));
  assert.ok(!walk(p).some((f) => /(^|\/)(tests|docs|\.senior-dev|dist|\.claude|\.git)\//.test(f)));
  assert.equal(readFileSync(join(p, 'hooks', 'hooks.json'), 'utf8'), read('hooks/hooks.json'));
});

test('build: each command becomes a skill with valid frontmatter', () => {
  const p = plug(built());
  const skills = readdirSync(join(p, 'skills')).sort();
  assert.deepEqual(skills, ['bypass', 'conductor', 'finish', 'guard', 'ship', 'skills', 'start', 'status']);
  for (const name of skills.filter((s) => s !== 'conductor')) {
    const text = readFileSync(join(p, 'skills', name, 'SKILL.md'), 'utf8');
    const f = front(text);
    const cmd = read(`commands/${name}.md`);
    const desc = cmd.match(/^description:\s*(.*)$/m)[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    assert.equal(f.name, name);
    assert.equal(f.description, `senior-dev: ${desc}`);
    assert.ok(f.description.length <= 1024);
    const body = cmd.split('\n---\n').slice(1).join('\n---\n').replaceAll('${CLAUDE_PLUGIN_ROOT}', '<plugin>')
      .replace(/^!`(.+)`[ \t]*$/gm, 'Run this command and use its output: `$1`');
    assert.ok(text.includes(body.trim()), `${name}: command body carried over`);
  }
});

test('build: ${CLAUDE_PLUGIN_ROOT} becomes <plugin>, with the note, in every skill that had it', () => {
  const p = plug(built());
  let rewritten = 0;
  for (const name of readdirSync(join(p, 'skills'))) {
    const text = readFileSync(join(p, 'skills', name, 'SKILL.md'), 'utf8');
    assert.ok(!text.includes('${CLAUDE_PLUGIN_ROOT}'), name);
    const src = name === 'conductor' ? read('skills/conductor/SKILL.md') : read(`commands/${name}.md`);
    if (src.includes('${CLAUDE_PLUGIN_ROOT}')) { rewritten++; assert.ok(text.includes('<plugin>') && text.includes(NOTE), name); }
    else assert.ok(!text.includes(NOTE), name);
  }
  assert.ok(rewritten >= 6);
});

test('build: a rebuild into the same folder removes stale files', () => {
  const out = built();
  writeFileSync(join(plug(out), 'stale.txt'), 'x');
  buildCodexPackage({ repoRoot: root, out });
  assert.ok(!existsSync(join(plug(out), 'stale.txt')));
});

test('build: refuses another project that hosts a Codex marketplace, and a former build with extra files', () => {
  const other = tmp('sd-cx-other-');
  mkdirSync(join(other, '.agents', 'plugins'), { recursive: true });
  writeFileSync(join(other, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: 'someone-else', plugins: [] }));
  writeFileSync(join(other, 'src.js'), 'keep');
  assert.throws(() => buildCodexPackage({ repoRoot: root, out: other }), /refusing/);
  assert.equal(readFileSync(join(other, 'src.js'), 'utf8'), 'keep');
  const out = built();
  writeFileSync(join(out, 'notes.md'), 'mine');
  assert.throws(() => buildCodexPackage({ repoRoot: root, out }), /refusing/);
  assert.equal(readFileSync(join(out, 'notes.md'), 'utf8'), 'mine');
});

test('build CLI: runs from another cwd and prints the codex:// deeplink', () => {
  const out = join(tmp('sd-cx-cli-'), 'mkt');
  const r = spawnSync('node', [BUILD, '--out', out], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const real = join(realpathSync(dirname(out)), 'mkt', '.agents', 'plugins', 'marketplace.json');
  assert.ok(r.stdout.includes(`codex://plugins/senior-dev?marketplacePath=${encodeURIComponent(real)}`), r.stdout);
});

// Safety cases run against a scratch copy only: a broken guard must never be able to delete this repo.
test('build: refuses any out dir in the repo except dist/, or above it, and leaves everything in place', () => {
  const f = fixture();
  for (const d of ['docs', '.git', '.claude-plugin', 'tests']) mkdirSync(join(f, d), { recursive: true });
  writeFileSync(join(f, 'docs', 'keep.md'), 'x');
  const count = () => walk(f).length;
  const before = count();
  for (const bad of [f, dirname(f), join(f, 'skills', 'x'), join(f, 'scripts'), join(f, 'docs'), join(f, '.git'), join(f, '.claude-plugin'), join(f, 'tests'), join(f, 'README.md'), join(f, 'new-folder')]) {
    assert.throws(() => buildCodexPackage({ repoRoot: f, out: bad }), /refusing/, bad);
  }
  assert.equal(count(), before);
  buildCodexPackage({ repoRoot: f, out: join(f, 'dist', 'codex-marketplace') });
  assert.ok(existsSync(join(f, 'docs', 'keep.md')));
});

test('build: a case-variant or /tmp-alias spelling of the repo is still refused', () => {
  const f = fixture();
  const before = walk(f).length;
  const upper = join(dirname(f), basename(f).toUpperCase());
  if (existsSync(upper)) assert.throws(() => buildCodexPackage({ repoRoot: f, out: upper }), /refusing/); // case-insensitive volume
  const real = realpathSync(f);
  const alias = real.startsWith('/private/') ? real.slice('/private'.length) : null;
  if (alias && existsSync(alias)) {
    assert.throws(() => buildCodexPackage({ repoRoot: f, out: real }), /refusing/);
    assert.throws(() => buildCodexPackage({ repoRoot: real, out: alias }), /refusing/);
    assert.throws(() => buildCodexPackage({ repoRoot: real, out: join(alias, 'skills') }), /refusing/);
  }
  assert.equal(walk(f).length, before);
});

test('build CLI: refuses a non-empty folder that is not a previous build, and keeps its files', () => {
  const user = tmp('sd-cx-user-');
  writeFileSync(join(user, 'thesis.docx'), 'precious');
  const r = spawnSync('node', [BUILD, '--out', user], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /refusing/);
  assert.equal(readFileSync(join(user, 'thesis.docx'), 'utf8'), 'precious');
});

test('build: no skill keeps a Claude-only !`command` line; it becomes an instruction to run it', () => {
  const p = plug(built());
  for (const name of readdirSync(join(p, 'skills'))) {
    const text = readFileSync(join(p, 'skills', name, 'SKILL.md'), 'utf8');
    assert.ok(!/^!`/m.test(text), name);
  }
  assert.match(readFileSync(join(p, 'skills', 'status', 'SKILL.md'), 'utf8'), /Run this command and use its output: `node "<plugin>\/scripts\/state-cli\.mjs" status`/);
});

test('the packaged guard stamps the real version (the package has no .claude-plugin)', () => {
  const p = plug(built());
  const repo = tmp('sd-cx-guard-');
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const r = spawnSync('node', [join(p, 'scripts', 'state-cli.mjs'), 'guard', 'install'], { cwd: repo, encoding: 'utf8', env: { ...process.env, SENIOR_DEV_OFFLINE: '1' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(repo, '.senior-dev', 'guard', 'version'), 'utf8').trim(), '0.5.0');
});

test('build: a command without a description fails, naming the file', () => {
  const f = fixture();
  writeFileSync(join(f, 'commands', 'status.md'), '---\nargument-hint: x\n---\nbody\n');
  assert.throws(() => buildCodexPackage({ repoRoot: f, out: join(f, 'dist', 'm') }), /status\.md/);
});

test('build: a description with a colon and quotes survives as valid frontmatter', () => {
  const f = fixture();
  writeFileSync(join(f, 'commands', 'status.md'), '---\ndescription: a: "quoted" thing\n---\nbody\n');
  const out = join(f, 'dist', 'm');
  buildCodexPackage({ repoRoot: f, out });
  assert.equal(front(readFileSync(join(plug(out), 'skills', 'status', 'SKILL.md'), 'utf8')).description, 'senior-dev: a: "quoted" thing');
});

test('build: .DS_Store files are never copied', () => {
  const f = fixture();
  writeFileSync(join(f, 'skills', '.DS_Store'), 'x');
  writeFileSync(join(f, 'scripts', '.DS_Store'), 'x');
  const out = join(f, 'dist', 'm');
  buildCodexPackage({ repoRoot: f, out });
  assert.ok(!walk(out).some((x) => x.endsWith('.DS_Store')));
});
