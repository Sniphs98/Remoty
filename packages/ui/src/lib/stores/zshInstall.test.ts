import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ZshInstallResultDto } from '$lib/bindings';
import { applyZshInstallComplete, applyZshInstallFailed, applyZshInstallProgress } from '$lib/ipc/router';
import { beginZshInstall, dismissZshInstall, shellOutcome, zshInstall } from './zshInstall';

const result: ZshInstallResultDto = {
  zshPath: '/home/me/.zsh/zsh-bin/bin/zsh',
  zshVersion: '5.8',
  shell: 'profile',
  plugins: ['zsh-autosuggestions'],
  homeFiles: [],
  backups: [],
  profileFile: '/home/me/.profile',
  bundledZsh: true,
  offlineCopies: []
};

const step = { index: 2, total: 4, description: 'Preparing zsh' };

beforeEach(() => dismissZshInstall());

describe('zsh install run', () => {
  it('advances only the host it is for, and only while running', () => {
    beginZshInstall('web-1', true);
    applyZshInstallProgress({ hostName: 'db-1', step });
    expect(get(zshInstall)?.phase).toEqual({ kind: 'running', step: null });
    applyZshInstallProgress({ hostName: 'web-1', step });
    expect(get(zshInstall)).toEqual({ hostName: 'web-1', setDefaultShell: true, phase: { kind: 'running', step } });
    applyZshInstallComplete({ hostName: 'web-1', result });
    applyZshInstallProgress({ hostName: 'web-1', step });
    expect(get(zshInstall)).toEqual({ hostName: 'web-1', setDefaultShell: true, phase: { kind: 'complete', result } });
  });

  it('shows an outcome even after the panel was dismissed', () => {
    beginZshInstall('web-1', false);
    dismissZshInstall();
    applyZshInstallFailed({ hostName: 'web-1', error: 'no tar' });
    expect(get(zshInstall)).toEqual({ hostName: 'web-1', setDefaultShell: false, phase: { kind: 'failed', error: 'no tar' } });
  });

  it('says what happened to the login shell', () => {
    expect(shellOutcome(result)).toContain('/home/me/.profile');
    expect(shellOutcome({ ...result, shell: 'changed' })).toContain('login shell');
    expect(shellOutcome({ ...result, shell: 'unchanged' })).toContain(result.zshPath);
  });
});
