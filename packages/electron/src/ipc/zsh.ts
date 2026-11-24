import { mkdir } from 'node:fs/promises';

import { shell, type IpcMain } from 'electron';

import { SshSession } from '../core/ssh/session.js';
import { installZsh, ZSH_INSTALL_STEPS, zshStepDescription, type ZshInstallResult } from '../core/zsh/install.js';
import {
  DEFAULT_PROFILE,
  listHomeFiles,
  loadZshProfile,
  saveZshProfile,
  zshHomeDir,
  zshProfileDir,
  type ZshProfile
} from '../core/zsh/profile.js';
import { toCommandError } from '../dto.js';
import type { GuiState } from '../state/guiState.js';

export interface ZshProfileDto extends ZshProfile {
  folder: string;
  homeFolder: string;
  homeFiles: string[];
  defaults: ZshProfile;
}

export type ZshInstallResultDto = ZshInstallResult;

function handle<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (_e: unknown, ...args: A) => Promise<R> {
  return async (_e, ...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      throw toCommandError(err);
    }
  };
}

const running = new Set<string>();

export function registerZshIpc(ipcMain: IpcMain, state: GuiState): void {
  ipcMain.handle(
    'zsh_profile_load',
    handle(async (): Promise<ZshProfileDto> => {
      const profile = await loadZshProfile();
      return {
        ...profile,
        folder: zshProfileDir(),
        homeFolder: zshHomeDir(),
        homeFiles: await listHomeFiles(),
        defaults: DEFAULT_PROFILE
      };
    })
  );

  ipcMain.handle(
    'zsh_profile_save',
    handle(async (profile: ZshProfile): Promise<void> => {
      await saveZshProfile({ zshrc: String(profile.zshrc ?? ''), plugins: String(profile.plugins ?? ''), theme: String(profile.theme ?? '') });
    })
  );

  ipcMain.handle(
    'zsh_profile_open_folder',
    handle(async (): Promise<void> => {
      await mkdir(zshHomeDir(), { recursive: true });
      const error = await shell.openPath(zshProfileDir());
      if (error) throw new Error(error);
    })
  );

  ipcMain.handle('start_zsh_install', (_event, hostName: string, setDefaultShell: boolean) => {
    const host = state.hostByName(hostName);
    if (host === undefined) throw toCommandError(new Error(`unknown host '${hostName}'`));
    if (running.has(hostName)) throw toCommandError(new Error(`zsh is already being installed on '${hostName}'`));
    running.add(hostName);
    void (async () => {
      let session: SshSession | undefined;
      try {
        session = await SshSession.connect(host);
        const result = await installZsh(session, { setDefaultShell: Boolean(setDefaultShell) }, (step, detail) => {
          state.emit('zsh-install-progress', {
            hostName,
            step: { index: ZSH_INSTALL_STEPS.indexOf(step) + 1, total: ZSH_INSTALL_STEPS.length, description: zshStepDescription(step, detail) }
          });
        });
        state.emit('zsh-install-complete', { hostName, result });
      } catch (e) {
        state.emit('zsh-install-failed', { hostName, error: (e as Error).message });
      } finally {
        session?.disconnect();
        running.delete(hostName);
      }
    })();
  });
}
