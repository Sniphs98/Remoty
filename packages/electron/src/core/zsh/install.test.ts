import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ExecResult } from '../automation/types.js';
import { installZsh } from './install.js';
import { saveZshProfile, zshHomeDir } from './profile.js';
import { isSafeHomePath, parseInstallOutput, parseProbe, zshBinAsset, zshBinUrl } from './script.js';

const run = promisify(execFile);

describe('zshBinAsset', () => {
  it('maps uname to a zsh-bin release file', () => {
    expect(zshBinAsset('Linux', 'x86_64')).toBe('zsh-5.8-linux-x86_64.tar.gz');
    expect(zshBinAsset('Linux', 'arm64')).toBe('zsh-5.8-linux-aarch64.tar.gz');
    expect(zshBinAsset('Darwin', 'arm64')).toBe('zsh-5.8-darwin-arm64.tar.gz');
    expect(zshBinUrl('zsh-5.8-linux-x86_64.tar.gz')).toBe(
      'https://github.com/romkatv/zsh-bin/releases/download/v6.1.1/zsh-5.8-linux-x86_64.tar.gz'
    );
    expect(() => zshBinAsset('Linux', 'riscv64')).toThrow(/no ready-made zsh/);
  });
});

describe('parseProbe', () => {
  it('reads the facts, with Windows line endings too', () => {
    expect(parseProbe('os=Linux\r\narch=x86_64\r\nhome=/home/me\r\nzsh=\r\ntar=1\r\n')).toEqual({
      os: 'Linux',
      arch: 'x86_64',
      home: '/home/me',
      zsh: null,
      hasTar: true,
      hasGzip: false
    });
    expect(parseProbe('home=/root\nzsh=/usr/bin/zsh\n').zsh).toBe('/usr/bin/zsh');
    expect(() => parseProbe('home=\n')).toThrow(/home directory/);
  });
});

describe('parseInstallOutput', () => {
  it('collects what the script reported', () => {
    const out = parseInstallOutput(
      'noise\nREMOTY_PLUGIN=a\nREMOTY_PLUGIN=b\nREMOTY_BACKUP=/h/.zshrc.remoty-backup-1\nREMOTY_ZSH_PATH=/usr/bin/zsh\nREMOTY_ZSH_VERSION=5.9\nREMOTY_SHELL=changed\n'
    );
    expect(out).toEqual({
      zshPath: '/usr/bin/zsh',
      zshVersion: '5.9',
      shell: 'changed',
      plugins: ['a', 'b'],
      homeFiles: [],
      backups: ['/h/.zshrc.remoty-backup-1'],
      profileFile: null
    });
    expect(() => parseInstallOutput('REMOTY_PLUGIN=a\n')).toThrow(/did not finish/);
  });
});

describe('isSafeHomePath', () => {
  it('keeps files inside the home folder', () => {
    expect(isSafeHomePath('.p10k.zsh')).toBe(true);
    expect(isSafeHomePath('.config/a/b')).toBe(true);
    expect(isSafeHomePath('../etc/passwd')).toBe(false);
    expect(isSafeHomePath('/etc/passwd')).toBe(false);
    expect(isSafeHomePath('a//b')).toBe(false);
    expect(isSafeHomePath('a\\b')).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('installZsh on a local stand-in server', () => {
  let root: string;
  let home: string;
  let bin: string;
  let profileDir: string;
  let archives: Map<string, Buffer>;
  let system: string;

  beforeAll(async () => {
    system = await mkdtemp(join(tmpdir(), 'remoty-zsh-path-'));
    for (const dir of ['/usr/bin', '/bin']) {
      if (!existsSync(dir)) continue;
      for (const name of await readdir(dir)) {
        if (name.startsWith('zsh') || existsSync(join(system, name))) continue;
        await symlink(join(dir, name), join(system, name)).catch(() => undefined);
      }
    }
  });

  afterAll(async () => {
    await rm(system, { recursive: true, force: true });
  });

  async function tarball(name: string, files: Record<string, string>, top?: string): Promise<Buffer> {
    const src = join(root, 'src', name);
    const base = top ? join(src, top) : src;
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(base, path, '..'), { recursive: true });
      await writeFile(join(base, path), content, { mode: 0o755 });
    }
    const out = join(root, `${name}.tar.gz`);
    await run('tar', ['-czf', out, '-C', src, '.']);
    return readFile(out);
  }

  const fakeZsh = `#!/bin/sh
if [ "$2" = 'echo $ZSH_VERSION' ]; then echo 5.8; fi
exit 0
`;

  async function shim(name: string, body: string): Promise<void> {
    await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(bin, name), 0o755);
  }

  const fetchImpl = (async (url: string) => {
    const hit = [...archives.entries()].find(([key]) => String(url).includes(key));
    if (!hit) return new Response('not found', { status: 404 });
    return new Response(new Uint8Array(hit[1]), { status: 200 });
  }) as typeof fetch;

  const session = {
    async runShell(cmd: string): Promise<ExecResult> {
      try {
        const { stdout, stderr } = await run('sh', ['-c', cmd], {
          env: { HOME: home, PATH: `${bin}:${system}` },
          cwd: home
        });
        return { ok: true, output: stdout + stderr, stdout, stderr, exitCode: 0 };
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; code?: number };
        return {
          ok: false,
          output: `${err.stdout ?? ''}${err.stderr ?? ''}`,
          stdout: err.stdout ?? '',
          stderr: err.stderr ?? '',
          exitCode: err.code ?? 1,
          error: `exited with ${err.code}`
        };
      }
    },
    async openSftp() {
      return {
        fastPut(local: string, remote: string, cb: (err?: Error) => void) {
          copyFile(local, remote).then(() => cb(), cb);
        },
        end() {}
      } as never;
    }
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'remoty-zsh-install-'));
    home = join(root, 'home');
    bin = join(root, 'bin');
    profileDir = join(root, 'profile');
    await mkdir(home, { recursive: true });
    await mkdir(bin, { recursive: true });
    await shim('uname', 'case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac');
    await shim('id', 'case "$1" in -u) echo 1000 ;; -un) echo tester ;; esac');
    await shim('sudo', 'exit 1');
    archives = new Map([
      ['zsh-users/zsh-autosuggestions', await tarball('as', { 'zsh-autosuggestions.plugin.zsh': '# as\n' }, 'zsh-autosuggestions-abc')],
      ['zsh-users/zsh-syntax-highlighting', await tarball('sh', { 'zsh-syntax-highlighting.zsh': '# sh\n' }, 'zsh-syntax-highlighting-def')],
      [
        'zsh-5.8-linux-x86_64',
        await tarball('zsh', { 'bin/zsh': fakeZsh, 'share/zsh/5.8/scripts/relocate': '#!/bin/sh\nexit 0\n' })
      ]
    ]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('brings its own zsh, unpacks the plugins and backs up the old .zshrc', async () => {
    await saveZshProfile(
      { zshrc: 'PROMPT="> "\n', plugins: 'zsh-users/zsh-autosuggestions\nzsh-users/zsh-syntax-highlighting\n', theme: '' },
      profileDir
    );
    await mkdir(join(zshHomeDir(profileDir), '.config', 'demo'), { recursive: true });
    await writeFile(join(zshHomeDir(profileDir), '.config', 'demo', 'it.conf'), 'demo\n');
    await writeFile(join(home, '.zshrc'), 'old\n');

    const steps: string[] = [];
    const result = await installZsh(session, { setDefaultShell: false, profileDir, fetchImpl }, (s, d) => steps.push(d ? `${s}:${d}` : s));

    expect(result.bundledZsh).toBe(true);
    expect(result.zshPath).toBe(join(home, '.zsh', 'zsh-bin', 'bin', 'zsh'));
    expect(result.zshVersion).toBe('5.8');
    expect(result.shell).toBe('unchanged');
    expect(result.plugins).toEqual(['zsh-autosuggestions', 'zsh-syntax-highlighting']);
    expect(result.homeFiles).toEqual(['.config/demo/it.conf']);
    expect(result.backups).toHaveLength(1);
    expect(steps[0]).toBe('probe');
    expect(steps).toContain('download:zsh');
    expect(steps.at(-1)).toBe('install');

    expect(await readFile(join(home, '.zshrc'), 'utf-8')).toBe('PROMPT="> "\n\nsource ~/.zsh/plugins.zsh\n');
    expect(await readFile(result.backups[0], 'utf-8')).toBe('old\n');
    expect(existsSync(join(home, '.zsh', 'plugins', 'zsh-autosuggestions', 'zsh-autosuggestions.plugin.zsh'))).toBe(true);
    expect(existsSync(join(home, '.zsh', 'plugins', 'zsh-syntax-highlighting', 'zsh-syntax-highlighting.zsh'))).toBe(true);
    expect(await readFile(join(home, '.zsh', 'plugins.zsh'), 'utf-8')).toContain('zsh-syntax-highlighting');
    expect(await readFile(join(home, '.config', 'demo', 'it.conf'), 'utf-8')).toBe('demo\n');
    expect(existsSync(join(home, '.remoty-zsh-staging'))).toBe(false);
  });

  it('uses the zsh that is there, works from the kept copies when offline, and falls back to the login profile', async () => {
    await shim('zsh', fakeZsh.replace('#!/bin/sh\n', ''));
    await saveZshProfile({ zshrc: 'source ~/.zsh/plugins.zsh\n', plugins: 'zsh-users/zsh-autosuggestions\n', theme: '' }, profileDir);
    await installZsh(session, { setDefaultShell: false, profileDir, fetchImpl }, () => undefined);
    await writeFile(join(home, '.bash_profile'), '# mine\n');

    const offline = (async () => {
      throw new Error('getaddrinfo ENOTFOUND github.com');
    }) as typeof fetch;
    const result = await installZsh(session, { setDefaultShell: true, profileDir, fetchImpl: offline }, () => undefined);

    expect(result.bundledZsh).toBe(false);
    expect(result.zshPath).toBe(join(bin, 'zsh'));
    expect(result.offlineCopies).toEqual(['zsh-users/zsh-autosuggestions'.split('/')[1]]);
    expect(result.backups).toEqual([]);
    expect(result.shell).toBe('profile');
    expect(result.profileFile).toBe(join(home, '.bash_profile'));
    const profile = await readFile(join(home, '.bash_profile'), 'utf-8');
    expect(profile.startsWith('# mine\n')).toBe(true);
    expect(profile).toContain(`exec "$SHELL" -l`);
    expect(profile).toContain(join(bin, 'zsh'));

    await installZsh(session, { setDefaultShell: true, profileDir, fetchImpl: offline }, () => undefined);
    const again = await readFile(join(home, '.bash_profile'), 'utf-8');
    expect(again.split('# >>> remoty zsh >>>').length).toBe(2);
    expect(await readdir(join(home, '.zsh', 'plugins'))).toEqual(['zsh-autosuggestions']);
  });

  it('says what is missing when this computer has never been online', async () => {
    await saveZshProfile({ zshrc: '', plugins: 'zsh-users/zsh-autosuggestions\n', theme: '' }, profileDir);
    const offline = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    await expect(installZsh(session, { setDefaultShell: false, profileDir, fetchImpl: offline }, () => undefined)).rejects.toThrow(
      /could not download zsh-users\/zsh-autosuggestions/
    );
  });
});
