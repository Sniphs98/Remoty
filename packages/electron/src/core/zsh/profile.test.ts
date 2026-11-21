import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_PROFILE,
  finalZshrc,
  listHomeFiles,
  loadZshProfile,
  parsePluginList,
  parsePluginSpec,
  pluginArchiveUrl,
  pluginCacheName,
  pluginLoader,
  saveZshProfile
} from './profile.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'remoty-zsh-profile-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('parsePluginSpec', () => {
  it('reads owner/repo, a branch, and a GitHub URL', () => {
    expect(parsePluginSpec('zsh-users/zsh-autosuggestions')).toEqual({
      owner: 'zsh-users',
      repo: 'zsh-autosuggestions',
      ref: 'HEAD',
      name: 'zsh-autosuggestions'
    });
    expect(parsePluginSpec('romkatv/powerlevel10k@v1.20.0')).toMatchObject({ repo: 'powerlevel10k', ref: 'v1.20.0' });
    expect(parsePluginSpec('https://github.com/zsh-users/zsh-completions.git')).toMatchObject({
      owner: 'zsh-users',
      repo: 'zsh-completions',
      ref: 'HEAD'
    });
    expect(parsePluginSpec('  https://github.com/a/b/  ')).toMatchObject({ owner: 'a', repo: 'b' });
  });

  it('refuses anything that is not a GitHub repository', () => {
    expect(() => parsePluginSpec('just-a-name')).toThrow(/owner\/repo/);
    expect(() => parsePluginSpec('https://gitlab.com/a/b')).toThrow();
    expect(() => parsePluginSpec('a/b c')).toThrow();
    expect(() => parsePluginSpec('a/..')).toThrow();
    expect(() => parsePluginSpec('a/b@../x')).toThrow();
    expect(() => parsePluginSpec("a/b@x';rm")).toThrow();
  });
});

describe('parsePluginList', () => {
  it('skips blank lines and comments, keeps the order', () => {
    const list = parsePluginList('# mine\nzsh-users/zsh-autosuggestions\n\r\n  zsh-users/zsh-syntax-highlighting # last\n');
    expect(list.map((p) => p.name)).toEqual(['zsh-autosuggestions', 'zsh-syntax-highlighting']);
  });

  it('refuses two plugins with the same folder name', () => {
    expect(() => parsePluginList('a/plugin\nb/plugin')).toThrow(/two plugins/);
  });
});

describe('archives', () => {
  it('downloads a GitHub tarball and caches it under a name per ref', () => {
    const spec = parsePluginSpec('romkatv/powerlevel10k@feature/x');
    expect(pluginArchiveUrl(spec)).toBe('https://github.com/romkatv/powerlevel10k/archive/feature/x.tar.gz');
    expect(pluginCacheName(spec)).toBe('romkatv__powerlevel10k__feature_x.tar.gz');
  });
});

describe('pluginLoader', () => {
  it('lists the theme first and every plugin once', () => {
    const plugins = parsePluginList('a/one\nb/two');
    const loader = pluginLoader(plugins, parsePluginSpec('c/theme'));
    expect(loader).toContain('_remoty_zsh_plugins=(\n  theme\n  one\n  two\n)');
    expect(pluginLoader(plugins, parsePluginSpec('a/one'))).toContain('_remoty_zsh_plugins=(\n  one\n  two\n)');
  });
});

describe('finalZshrc', () => {
  it('adds the plugin loader only when the config does not load it already', () => {
    expect(finalZshrc('echo hi')).toBe('echo hi\n\nsource ~/.zsh/plugins.zsh\n');
    expect(finalZshrc('source ~/.zsh/plugins.zsh\r\nalias x=y\r\n')).toBe('source ~/.zsh/plugins.zsh\nalias x=y\n');
    expect(finalZshrc('source "$HOME/.zsh/plugins.zsh"')).toBe('source "$HOME/.zsh/plugins.zsh"\n');
  });
});

describe('loadZshProfile / saveZshProfile', () => {
  it('starts from the defaults and keeps what was saved', async () => {
    expect(await loadZshProfile(dir)).toEqual(DEFAULT_PROFILE);
    const profile = { zshrc: 'PROMPT="> "\r\n', plugins: 'a/b\n', theme: ' romkatv/powerlevel10k ' };
    await saveZshProfile(profile, dir);
    expect(await loadZshProfile(dir)).toEqual({ zshrc: 'PROMPT="> "\n', plugins: 'a/b\n', theme: 'romkatv/powerlevel10k' });
  });

  it('refuses to save a plugin list it could not install', async () => {
    await expect(saveZshProfile({ zshrc: '', plugins: 'nope', theme: '' }, dir)).rejects.toThrow(/owner\/repo/);
    await expect(saveZshProfile({ zshrc: '', plugins: '', theme: 'nope' }, dir)).rejects.toThrow(/owner\/repo/);
  });
});

describe('listHomeFiles', () => {
  it('lists the files to copy into the home folder, with forward slashes', async () => {
    expect(await listHomeFiles(join(dir, 'missing'))).toEqual([]);
    await mkdir(join(dir, '.config', 'x'), { recursive: true });
    await writeFile(join(dir, '.p10k.zsh'), '');
    await writeFile(join(dir, '.config', 'x', 'y.conf'), '');
    expect(await listHomeFiles(dir)).toEqual(['.config/x/y.conf', '.p10k.zsh']);
  });
});
