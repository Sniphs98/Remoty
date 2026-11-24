import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SFTPWrapper } from 'ssh2';

import type { SshSession } from '../ssh/session.js';
import { shellQuote } from '../ssh/sftp.js';
import { fetchToCache } from './download.js';
import {
  finalZshrc,
  listHomeFiles,
  loadZshProfile,
  parsePluginList,
  parsePluginSpec,
  pluginArchiveUrl,
  pluginCacheName,
  pluginLoader,
  zshCacheDir,
  zshHomeDir,
  zshProfileDir,
  type PluginSpec
} from './profile.js';
import {
  installScript,
  isSafeHomePath,
  parseInstallOutput,
  parseProbe,
  PROBE_SCRIPT,
  stagingDir,
  zshBinAsset,
  zshBinUrl,
  type InstallOutcome
} from './script.js';

export type ZshInstallStep = 'probe' | 'download' | 'upload' | 'install';
export const ZSH_INSTALL_STEPS: ZshInstallStep[] = ['probe', 'download', 'upload', 'install'];

export function zshStepDescription(step: ZshInstallStep, detail?: string): string {
  switch (step) {
    case 'probe':
      return 'Checking the server';
    case 'download':
      return detail ? `Preparing ${detail}` : 'Preparing plugins';
    case 'upload':
      return detail ? `Copying ${detail}` : 'Copying files to the server';
    case 'install':
      return 'Installing';
  }
}

export interface ZshInstallOptions {
  setDefaultShell: boolean;
  profileDir?: string;
  fetchImpl?: typeof fetch;
}

export interface ZshInstallResult extends InstallOutcome {
  bundledZsh: boolean;
  offlineCopies: string[];
}

type Remote = Pick<SshSession, 'runShell' | 'openSftp'>;

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

function sh(script: string): string {
  return `sh -c ${shellQuote(script)}`;
}

function put(sftp: SFTPWrapper, local: string, remote: string): Promise<void> {
  return new Promise((resolve, reject) =>
    sftp.fastPut(local, remote, (err) => (err ? reject(new Error(`could not copy ${remote}: ${err.message}`)) : resolve()))
  );
}

export async function installZsh(
  session: Remote,
  options: ZshInstallOptions,
  report: (step: ZshInstallStep, detail?: string) => void
): Promise<ZshInstallResult> {
  const dir = options.profileDir ?? zshProfileDir();
  const profile = await loadZshProfile(dir);
  const plugins = parsePluginList(profile.plugins);
  const theme = profile.theme ? parsePluginSpec(profile.theme) : undefined;
  const all: PluginSpec[] = theme ? [theme, ...plugins.filter((p) => p.name !== theme.name)] : plugins;
  const homeFiles = (await listHomeFiles(zshHomeDir(dir))).filter(isSafeHomePath);

  report('probe');
  const probe = await session.runShell(sh(PROBE_SCRIPT));
  if (!probe.ok) throw new Error(`could not check the server: ${probe.error ?? 'unknown error'}`);
  const facts = parseProbe(probe.stdout ?? probe.output);
  if (!facts.hasTar) throw new Error('the server has no tar, which is needed to unpack the plugins');
  if (!facts.hasGzip && all.length > 0) throw new Error('the server has no gzip, which is needed to unpack the plugins');

  const cache = zshCacheDir(dir);
  const offlineCopies: string[] = [];
  const archives: { spec: PluginSpec; path: string }[] = [];
  for (const spec of all) {
    report('download', spec.name);
    const file = await fetchToCache(
      pluginArchiveUrl(spec),
      join(cache, 'plugins', pluginCacheName(spec)),
      { refresh: true, label: `${spec.owner}/${spec.repo}` },
      options.fetchImpl
    );
    if (file.fromCache) offlineCopies.push(spec.name);
    archives.push({ spec, path: file.path });
  }

  let zshArchive: string | undefined;
  if (facts.zsh === null) {
    const asset = zshBinAsset(facts.os, facts.arch);
    report('download', 'zsh');
    const file = await fetchToCache(zshBinUrl(asset), join(cache, 'zsh', asset), { refresh: false, label: 'zsh' }, options.fetchImpl);
    zshArchive = file.path;
  }

  const local = await mkdtemp(join(tmpdir(), 'remoty-zsh-'));
  try {
    const staging = stagingDir(facts.home);
    await writeFile(join(local, 'zshrc'), finalZshrc(profile.zshrc));
    await writeFile(join(local, 'plugins.zsh'), pluginLoader(plugins, theme));
    await writeFile(
      join(local, 'install.sh'),
      installScript({ staging, bundledZsh: zshArchive !== undefined, setDefaultShell: options.setDefaultShell, homeFiles })
    );

    report('upload');
    const homeDirs = new Set<string>();
    for (const f of homeFiles) {
      const parts = f.split('/').slice(0, -1);
      for (let i = 1; i <= parts.length; i++) homeDirs.add(parts.slice(0, i).join('/'));
    }
    const mk = [`${staging}/plugins`, `${staging}/home`, ...[...homeDirs].map((d) => `${staging}/home/${d}`)]
      .map(shellQuote)
      .join(' ');
    const prep = await session.runShell(sh(`rm -rf ${shellQuote(staging)} && mkdir -p ${mk} && chmod 700 ${shellQuote(staging)}`));
    if (!prep.ok) throw new Error(`could not prepare a folder on the server: ${(prep.stderr ?? prep.output).trim() || prep.error}`);

    const sftp = await session.openSftp();
    try {
      for (const name of ['zshrc', 'plugins.zsh', 'install.sh']) await put(sftp, join(local, name), `${staging}/${name}`);
      for (const { spec, path } of archives) {
        report('upload', spec.name);
        await put(sftp, path, `${staging}/plugins/${spec.name}.tar.gz`);
      }
      if (zshArchive) {
        report('upload', 'zsh');
        await put(sftp, zshArchive, `${staging}/zsh.tar.gz`);
      }
      for (const f of homeFiles) await put(sftp, join(zshHomeDir(dir), ...f.split('/')), `${staging}/home/${f}`);
    } finally {
      sftp.end();
    }

    report('install');
    const run = await session.runShell(sh(`sh ${shellQuote(`${staging}/install.sh`)}`), INSTALL_TIMEOUT_MS);
    if (!run.ok) {
      const why = (run.stderr ?? run.output).trim().split('\n').slice(-3).join(' ') || run.error || 'unknown error';
      await session.runShell(sh(`rm -rf ${shellQuote(staging)}`)).catch(() => undefined);
      throw new Error(`installing failed on the server: ${why}`);
    }
    return { ...parseInstallOutput(run.stdout ?? run.output), bundledZsh: zshArchive !== undefined, offlineCopies };
  } finally {
    await rm(local, { recursive: true, force: true });
  }
}
