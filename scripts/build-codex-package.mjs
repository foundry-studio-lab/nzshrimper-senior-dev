#!/usr/bin/env node
// Builds the local Codex marketplace the ChatGPT app and the Codex CLI install
// senior-dev from: <out>/.agents/plugins/marketplace.json plus a copy of the
// runtime files in <out>/plugins/senior-dev. The Codex plugin format has no
// slash commands, so each commands/*.md becomes a skill. Zero dependencies.
import { cpSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RUNTIME = ['.codex-plugin', 'skills', 'scripts', 'hooks', 'LICENSE', 'README.md', 'PRIVACY.md', 'CHANGELOG.md'];
const ROOT_VAR = '${CLAUDE_PLUGIN_ROOT}';
const NOTE = "`<plugin>` is this plugin's folder; the senior-dev session-start banner prints the state CLI's exact path.";
const ARGS_NOTE = 'Arguments: `$ARGUMENTS` means the text the user gave with this request.';
const MARKETPLACE = {
  name: 'nzshrimper-senior-dev',
  interface: { displayName: 'Foundry Studio' },
  plugins: [{
    name: 'senior-dev',
    source: { source: 'local', path: './plugins/senior-dev' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Developer Tools',
  }],
};

const inside = (child, parent) => child === parent || child.startsWith(parent + sep);

// The on-disk spelling of a path, even one that does not exist yet: the
// nearest existing ancestor through realpath (resolves symlinks such as
// /tmp -> /private/tmp, and the true case on a case-insensitive volume),
// then the missing tail as given.
function canonical(p) {
  let head = resolve(p);
  const tail = [];
  while (!existsSync(head)) {
    tail.unshift(basename(head));
    head = dirname(head);
  }
  return join(realpathSync.native(head), ...tail);
}

// The build deletes its output first, so it only ever writes to a folder
// outside the repository or under the repository's dist/, and never empties
// a non-empty folder that is not a previous build.
function checkOut(repoRoot, out) {
  if (inside(repoRoot, out)) throw new Error(`refusing --out ${out}: it contains the repository`);
  if (inside(out, repoRoot) && !inside(out, join(repoRoot, 'dist')) || out === join(repoRoot, 'dist')) {
    throw new Error(`refusing --out ${out}: inside the repository only dist/<folder> may be written`);
  }
  if (existsSync(out) && readdirSync(out).length && !previousBuild(out)) {
    throw new Error(`refusing --out ${out}: it is a non-empty folder that is not a previous senior-dev build`);
  }
}

// A previous build holds only .agents/ and plugins/, and its marketplace is
// ours: another project's Codex marketplace, or a build someone added files
// to, is never emptied.
function previousBuild(out) {
  const only = (dir, allowed) => !existsSync(join(out, dir)) || readdirSync(join(out, dir)).every((e) => allowed.includes(e));
  if (!only('', ['.agents', 'plugins']) || !only('.agents', ['plugins'])
    || !only(join('.agents', 'plugins'), ['marketplace.json']) || !only('plugins', ['senior-dev'])) return false;
  try {
    return JSON.parse(readFileSync(join(out, '.agents', 'plugins', 'marketplace.json'), 'utf8')).name === MARKETPLACE.name;
  } catch { return false; }
}

// Split a markdown file into its leading `---` frontmatter block and the rest.
function splitFront(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  return m ? { front: m[1], body: text.slice(m[0].length) } : { front: '', body: text };
}

// Codex does not substitute Claude Code's plugin-root variable in skill text,
// nor run Claude Code's !`command` lines: those become instructions to run it.
function rewriteRoot(body) {
  body = body.replace(/^!`(.+)`[ \t]*$/gm, 'Run this command and use its output: `$1`');
  return body.includes(ROOT_VAR) ? `${NOTE}\n\n${body.replaceAll(ROOT_VAR, '<plugin>')}` : body;
}

// The frontmatter `description`: a plain or quoted one-liner, or a YAML block
// scalar (`>`, `|`, with an optional chomping sign) whose indented lines are
// joined with spaces, since a skill description is a single line.
function readDescription(front) {
  const lines = front.split('\n');
  const i = lines.findIndex((l) => /^description:/.test(l));
  if (i < 0) return '';
  const value = lines[i].slice('description:'.length).trim();
  if (!/^[>|][+-]?$/.test(value)) return value.replace(/^(['"])(.*)\1$/, '$2');
  const block = [];
  for (const l of lines.slice(i + 1)) {
    if (!/^[ \t]/.test(l)) break;
    block.push(l.trim());
  }
  return block.filter(Boolean).join(' ');
}

function commandSkill(file, name) {
  const { front, body } = splitFront(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
  const raw = readDescription(front);
  if (!raw) throw new Error(`${file}: no description in its frontmatter`);
  const description = `senior-dev: ${raw}`;
  if (description.length > 1024) throw new Error(`${file}: description over 1024 characters`);
  let text = rewriteRoot(body.replace(/^\n+/, ''));
  if (text.includes('$ARGUMENTS')) text = `${ARGS_NOTE}\n\n${text}`;
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${text}`;
}

export function buildCodexPackage({ repoRoot, out }) {
  repoRoot = canonical(repoRoot);
  out = canonical(out);
  checkOut(repoRoot, out);
  rmSync(out, { recursive: true, force: true });
  const plugin = join(out, 'plugins', 'senior-dev');
  mkdirSync(plugin, { recursive: true });
  for (const p of RUNTIME) {
    cpSync(join(repoRoot, p), join(plugin, p), { recursive: true, filter: (src) => !src.endsWith(`${sep}.DS_Store`) });
  }
  // Skill text: rewrite the plugin-root variable after the frontmatter.
  for (const name of readdirSync(join(plugin, 'skills'))) {
    const f = join(plugin, 'skills', name, 'SKILL.md');
    if (!existsSync(f)) continue;
    const text = readFileSync(f, 'utf8');
    const { front, body } = splitFront(text);
    if (body.includes(ROOT_VAR)) writeFileSync(f, `---\n${front}\n---\n\n${rewriteRoot(body.replace(/^\n+/, ''))}`);
  }
  for (const file of readdirSync(join(repoRoot, 'commands')).filter((f) => f.endsWith('.md')).sort()) {
    const name = file.slice(0, -3);
    if (existsSync(join(plugin, 'skills', name))) throw new Error(`commands/${file} has the same name as the skill skills/${name}/: rename one of them`);
    mkdirSync(join(plugin, 'skills', name), { recursive: true });
    writeFileSync(join(plugin, 'skills', name, 'SKILL.md'), commandSkill(join(repoRoot, 'commands', file), name));
  }
  const marketplacePath = join(out, '.agents', 'plugins', 'marketplace.json');
  mkdirSync(dirname(marketplacePath), { recursive: true });
  writeFileSync(marketplacePath, JSON.stringify(MARKETPLACE, null, 2) + '\n');
  return { out, marketplacePath, skills: readdirSync(join(plugin, 'skills')).sort() };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    let out = join(repoRoot, 'dist', 'codex-marketplace');
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const v = a === '--out' ? args[++i] : a.startsWith('--out=') ? a.slice('--out='.length) : undefined;
      if (a !== '--out' && !a.startsWith('--out=')) throw new Error(`unknown argument ${a} (usage: build-codex-package.mjs [--out <dir>])`);
      if (!v || v.startsWith('--')) throw new Error('--out needs a folder (usage: --out <dir> or --out=<dir>)');
      out = resolve(v);
    }
    const r = buildCodexPackage({ repoRoot, out });
    console.log(`built ${r.out} (skills: ${r.skills.join(', ')})`);
    console.log(`codex://plugins/senior-dev?marketplacePath=${encodeURIComponent(r.marketplacePath)}`);
  } catch (e) {
    console.error(`build-codex-package: ${e.message}`);
    process.exit(1);
  }
}
