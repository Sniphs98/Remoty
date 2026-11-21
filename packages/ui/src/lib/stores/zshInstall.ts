import { writable } from 'svelte/store';
import type { KeySetupStepDto, ZshInstallResultDto } from '$lib/bindings';

export type ZshInstallPhase =
  | { kind: 'running'; step: KeySetupStepDto | null }
  | { kind: 'complete'; result: ZshInstallResultDto }
  | { kind: 'failed'; error: string };

export interface ZshInstallRun {
  hostName: string;
  setDefaultShell: boolean;
  phase: ZshInstallPhase;
}

export const zshInstall = writable<ZshInstallRun | null>(null);

export function beginZshInstall(hostName: string, setDefaultShell: boolean): void {
  zshInstall.set({ hostName, setDefaultShell, phase: { kind: 'running', step: null } });
}

export function dismissZshInstall(): void {
  zshInstall.set(null);
}

export function reduceZshProgress(run: ZshInstallRun | null, hostName: string, step: KeySetupStepDto): ZshInstallRun | null {
  if (run?.hostName !== hostName || run.phase.kind !== 'running') return run;
  return { ...run, phase: { kind: 'running', step } };
}

export function reduceZshComplete(run: ZshInstallRun | null, hostName: string, result: ZshInstallResultDto): ZshInstallRun {
  return { hostName, setDefaultShell: run?.hostName === hostName ? run.setDefaultShell : false, phase: { kind: 'complete', result } };
}

export function reduceZshFailed(run: ZshInstallRun | null, hostName: string, error: string): ZshInstallRun {
  return { hostName, setDefaultShell: run?.hostName === hostName ? run.setDefaultShell : false, phase: { kind: 'failed', error } };
}

export function shellOutcome(result: ZshInstallResultDto): string {
  switch (result.shell) {
    case 'changed':
      return 'zsh is now the login shell. New terminals open in zsh.';
    case 'already':
      return 'zsh already was the login shell.';
    case 'profile':
      return `The login shell could not be changed without root, so ${result.profileFile ?? 'the login profile'} now starts zsh. Set REMOTY_NO_ZSH=1 to skip it.`;
    case 'unchanged':
      return `The login shell stays as it is. Run ${result.zshPath} to start zsh.`;
  }
}
