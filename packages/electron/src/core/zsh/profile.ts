import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { appConfigDir } from '../config/platform.js';

export interface ZshProfile {
  zshrc: string;
  plugins: string;
  theme: string;
}

export interface PluginSpec {
  owner: string;
  repo: string;
  ref: string;
  name: string;
}

export const DEFAULT_ZSHRC = `HISTFILE=~/.zsh_history
HISTSIZE=50000
SAVEHIST=50000
setopt share_history hist_ignore_dups hist_ignore_space auto_cd interactive_comments

bindkey -e

autoload -Uz colors && colors
PROMPT='%F{cyan}%n@%m%f %F{yellow}%~%f %# '

alias ll='ls -lah'
alias la='ls -A'

source ~/.zsh/plugins.zsh
`;

export const DEFAULT_PLUGINS = `zsh-users/zsh-completions
zsh-users/zsh-autosuggestions
zsh-users/zsh-syntax-highlighting
`;

export const DEFAULT_PROFILE: ZshProfile = { zshrc: DEFAULT_ZSHRC, plugins: DEFAULT_PLUGINS, theme: '' };

export function zshProfileDir(): string {
  return join(appConfigDir(), 'zsh');
}

export function zshCacheDir(dir: string = zshProfileDir()): string {
  return join(dir, 'cache');
}

export function zshHomeDir(dir: string = zshProfileDir()): string {
  return join(dir, 'home');
}

const FILES = { zshrc: 'zshrc', plugins: 'plugins.txt', theme: 'theme.txt' } as const;

async function readOr(path: string, fallback: string): Promise<string> {
  return existsSync(path) ? readFile(path, 'utf-8') : fallback;
}

export async function loadZshProfile(dir: string = zshProfileDir()): Promise<ZshProfile> {
  return {
    zshrc: await readOr(join(dir, FILES.zshrc), DEFAULT_PROFILE.zshrc),
    plugins: await readOr(join(dir, FILES.plugins), DEFAULT_PROFILE.plugins),
    theme: (await readOr(join(dir, FILES.theme), DEFAULT_PROFILE.theme)).trim()
  };
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, 'utf-8');
  await rename(tmp, path);
}

export async function saveZshProfile(profile: ZshProfile, dir: string = zshProfileDir()): Promise<void> {
  parsePluginList(profile.plugins);
  if (profile.theme.trim()) parsePluginSpec(profile.theme);
  await mkdir(dir, { recursive: true });
  await mkdir(zshHomeDir(dir), { recursive: true });
  await writeAtomic(join(dir, FILES.zshrc), profile.zshrc.replace(/\r\n/g, '\n'));
  await writeAtomic(join(dir, FILES.plugins), profile.plugins.replace(/\r\n/g, '\n'));
  await writeAtomic(join(dir, FILES.theme), `${profile.theme.trim()}\n`);
}

const NAME = /^[A-Za-z0-9._-]+$/;
const REF = /^[A-Za-z0-9._\/-]+$/;

export function parsePluginSpec(raw: string): PluginSpec {
  const line = raw.trim();
  const match = /^(?:https?:\/\/github\.com\/)?([^/@\s]+)\/([^/@\s]+?)(?:\.git)?\/?(?:@(\S+))?$/.exec(line);
  if (!match) throw new Error(`"${line}" is not a GitHub plugin — write it as owner/repo or owner/repo@branch`);
  const [, owner, repo, ref] = match;
  if (!NAME.test(owner) || !NAME.test(repo) || repo === '.' || repo === '..') {
    throw new Error(`"${line}" is not a valid GitHub repository name`);
  }
  if (ref !== undefined && (!REF.test(ref) || ref.includes('..'))) throw new Error(`"${ref}" is not a valid branch or tag`);
  return { owner, repo, ref: ref ?? 'HEAD', name: repo };
}

export function parsePluginList(text: string): PluginSpec[] {
  const specs: PluginSpec[] = [];
  const seen = new Set<string>();
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const spec = parsePluginSpec(line);
    if (seen.has(spec.name)) throw new Error(`two plugins are named "${spec.name}" — keep only one of them`);
    seen.add(spec.name);
    specs.push(spec);
  }
  return specs;
}

export function pluginArchiveUrl(spec: PluginSpec): string {
  return `https://github.com/${spec.owner}/${spec.repo}/archive/${spec.ref}.tar.gz`;
}

export function pluginCacheName(spec: PluginSpec): string {
  return `${spec.owner}__${spec.repo}__${spec.ref.replace(/\//g, '_')}.tar.gz`;
}

export function pluginLoader(plugins: PluginSpec[], theme: PluginSpec | undefined): string {
  const all = theme ? [theme, ...plugins.filter((p) => p.name !== theme.name)] : plugins;
  const names = all.map((p) => `  ${p.name}`).join('\n');
  return `_remoty_zsh_plugins=(
${names}
)

for _remoty_p in $_remoty_zsh_plugins; do
  _remoty_d="$HOME/.zsh/plugins/$_remoty_p"
  [[ -d $_remoty_d/src ]] && fpath+=("$_remoty_d/src")
  [[ -d $_remoty_d/functions ]] && fpath+=("$_remoty_d/functions")
  fpath+=("$_remoty_d")
done

if (( ! $+functions[compdef] )); then
  autoload -Uz compinit && compinit -i
fi

for _remoty_p in $_remoty_zsh_plugins; do
  _remoty_d="$HOME/.zsh/plugins/$_remoty_p"
  for _remoty_f in "$_remoty_d/$_remoty_p.plugin.zsh" "$_remoty_d/$_remoty_p.zsh-theme" "$_remoty_d/$_remoty_p.zsh" \\
    "$_remoty_d"/*.plugin.zsh(N) "$_remoty_d"/*.zsh-theme(N) "$_remoty_d/init.zsh"; do
    if [[ -r $_remoty_f ]]; then
      source "$_remoty_f"
      break
    fi
  done
done

unset _remoty_p _remoty_d _remoty_f _remoty_zsh_plugins
`;
}

export function finalZshrc(zshrc: string): string {
  const text = zshrc.replace(/\r\n/g, '\n');
  const body = text.endsWith('\n') || text === '' ? text : `${text}\n`;
  return /\.zsh\/plugins\.zsh/.test(body) ? body : `${body}\nsource ~/.zsh/plugins.zsh\n`;
}

export async function listHomeFiles(dir: string = zshHomeDir()): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'))
    .sort();
}
