import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SshSession } from '../ssh/session.js';
import { testTargetHost } from '../../testSupport/sshTestTarget.js';
import { installZsh } from './install.js';
import { saveZshProfile } from './profile.js';

describe('installZsh against the test target', () => {
  let session: SshSession;
  let profileDir: string;

  beforeAll(async () => {
    session = await SshSession.connect(testTargetHost());
    profileDir = await mkdtemp(join(tmpdir(), 'remoty-zsh-it-'));
    await session.runShell('rm -rf ~/.zsh ~/.zshrc ~/.zshrc.remoty-backup-*');
  });

  afterAll(async () => {
    await session.runShell('rm -rf ~/.zsh ~/.zshrc ~/.zshrc.remoty-backup-* ~/.remoty-zsh-staging');
    session.disconnect();
    await rm(profileDir, { recursive: true, force: true });
  });

  it('installs zsh with its plugins on a server that has neither', async () => {
    await saveZshProfile(
      {
        zshrc: 'PROMPT="it> "\nsource ~/.zsh/plugins.zsh\n',
        plugins: 'zsh-users/zsh-autosuggestions\nzsh-users/zsh-syntax-highlighting\n',
        theme: ''
      },
      profileDir
    );

    const result = await installZsh(session, { setDefaultShell: false, profileDir }, () => undefined);

    expect(result.plugins).toEqual(['zsh-autosuggestions', 'zsh-syntax-highlighting']);
    expect(result.zshPath).toMatch(/\/zsh$/);
    expect(result.zshVersion).toMatch(/^5\./);

    const check = await session.runShell(
      `${result.zshPath} -ic 'print -r -- "$PROMPT"; (( $+functions[_zsh_autosuggest_start] )) && echo autosuggestions; (( $+functions[_zsh_highlight] )) && echo highlighting' </dev/null`,
      60_000
    );
    expect(check.stdout).toContain('it> ');
    expect(check.stdout).toContain('autosuggestions');
    expect(check.stdout).toContain('highlighting');
  }, 120_000);
});
