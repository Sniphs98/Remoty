import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeWslOutput, parseDistroList, wslArgs, wslCommandEnv, wslUploadPathScript, wslUploadSource } from './wslExec.js';

describe('wslExec', () => {
  it('reads wsl.exe output whether it came as UTF-16 or UTF-8', () => {
    expect(decodeWslOutput(Buffer.from('Ubuntu\r\ndocker-desktop\r\n', 'utf16le'))).toBe('Ubuntu\r\ndocker-desktop\r\n');
    expect(decodeWslOutput(Buffer.from('Loaded image: nginx:1.27\n', 'utf8'))).toBe('Loaded image: nginx:1.27\n');
  });

  it("lists the distributions, without Docker Desktop's internal ones", () => {
    expect(parseDistroList('Ubuntu\r\ndocker-desktop-data\r\ndocker-desktop\r\nDebian\r\n\r\n')).toEqual(['Ubuntu', 'Debian']);
  });

  it('runs bash in the chosen distribution, the command never on the command line', () => {
    expect(wslArgs('Ubuntu')).toEqual(['-d', 'Ubuntu', '--exec', 'bash', '-lc', 'eval "$REMOTY_COMMAND"']);
    expect(wslArgs(undefined)).toEqual(['--exec', 'bash', '-lc', 'eval "$REMOTY_COMMAND"']);
  });
});

// The script runs inside WSL, i.e. Linux — so it is run here in this machine's bash, which
// Windows runners don't have (theirs is WSL's own launcher).
describe.skipIf(process.platform === 'win32')('wslUploadPathScript', () => {
  // A stand-in `wslpath` that marks the absolute path it was given, as WSL's own would
  // turn it into a Windows one.
  let dir = '';
  let bin = '';
  let home = '';
  let cwd = '';
  beforeAll(() => {
    // Resolved, as the script's realpath resolves it: macOS's /var is /private/var.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'remoty-wslpath-')));
    bin = join(dir, 'bin');
    home = join(dir, 'home');
    cwd = join(dir, 'cwd');
    mkdirSync(bin);
    mkdirSync(home);
    mkdirSync(cwd);
    writeFileSync(join(bin, 'wslpath'), '#!/bin/sh\necho "WIN:$2"\n');
    chmodSync(join(bin, 'wslpath'), 0o755);
    writeFileSync(join(home, "it's.tar.gz"), 'x');
    writeFileSync(join(cwd, 'frontend.tar.gz'), 'x');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function run(path: string): { out: string; ok: boolean } {
    try {
      const out = execFileSync('bash', ['-c', wslUploadPathScript(path)], {
        cwd,
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: home },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      return { out: out.toString().trim(), ok: true };
    } catch (e) {
      return { out: String((e as { stderr: Buffer }).stderr).trim(), ok: false };
    }
  }

  it('gives the Windows path of an absolute, ~ or relative WSL path', () => {
    expect(run(join(cwd, 'frontend.tar.gz'))).toEqual({ out: `WIN:${join(cwd, 'frontend.tar.gz')}`, ok: true });
    expect(run("~/it's.tar.gz")).toEqual({ out: `WIN:${join(home, "it's.tar.gz")}`, ok: true });
    expect(run(' frontend.tar.gz ')).toEqual({ out: `WIN:${join(cwd, 'frontend.tar.gz')}`, ok: true });
  });

  it("fails with the WSL path when there's no such file", () => {
    expect(run('/tmp/remoty-no-such-file.tar.gz')).toEqual({ out: 'no such file in WSL: /tmp/remoty-no-such-file.tar.gz', ok: false });
    expect(run(cwd)).toEqual({ out: `not a file in WSL: ${cwd}`, ok: false });
  });
});

describe('wslUploadSource', () => {
  it("takes the path from the output's last line, after anything a login profile printed", async () => {
    const path = await wslUploadSource('Ubuntu', '/tmp/frontend.tar.gz', async () => ({
      output: 'welcome!\n\\\\wsl.localhost\\Ubuntu\\tmp\\frontend.tar.gz\n',
      ok: true
    }));
    expect(path).toBe('\\\\wsl.localhost\\Ubuntu\\tmp\\frontend.tar.gz');
  });

  it("fails with WSL's own reason", async () => {
    await expect(
      wslUploadSource(undefined, '/tmp/x', async () => ({ output: 'no such file in WSL: /tmp/x\n', ok: false, error: 'exited with code 1' }))
    ).rejects.toThrow('no such file in WSL: /tmp/x');
  });
});

describe('wslCommandEnv', () => {
  it('hands WSL the command with Linux line ends, shared through WSLENV', () => {
    const env = wslCommandEnv('echo "hello"\r\necho "world"\r\nexit 0\r\n', { WSLENV: 'FOO/p' });
    expect(env.REMOTY_COMMAND).toBe('echo "hello"\necho "world"\nexit 0\n');
    expect(env.WSLENV).toBe('FOO/p:REMOTY_COMMAND/u');
    expect(wslCommandEnv('echo one\necho two', {}).REMOTY_COMMAND).toBe('echo one\necho two');
  });
});

// What WSL does with it: bash, started as `wsl.exe` starts it (the arguments after
// `--exec`), with the environment `wsl.exe` passes on. Run in this machine's bash.
describe.skipIf(process.platform === 'win32')('a WSL command in bash', () => {
  function runInBash(command: string, env: NodeJS.ProcessEnv = wslCommandEnv(command)) {
    const [bash, ...args] = wslArgs(undefined).slice(1);
    const r = spawnSync(bash, args, { env, encoding: 'utf8' });
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status };
  }

  it('runs a command with Windows line ends as one with Linux ones', () => {
    const command = 'echo "hello"\r\n' + 'echo "world"\r\n' + 'exit 0\r\n';
    const r = runInBash(command);
    expect(r.stdout).toBe('hello\nworld\n');
    expect(r.stderr).not.toContain("$'\\r'");
    expect(r.exitCode).toBe(0);
    // Without it, what was seen: bash takes the `\r` for part of each line.
    const raw = runInBash(command, { ...process.env, REMOTY_COMMAND: command });
    expect(raw.stdout).toContain('hello\r');
    expect(raw.stderr).toContain('numeric argument required');
  });

  it('runs a command with Linux line ends, and a one-line one, as before', () => {
    expect(runInBash('echo "hello"\necho "world"\nexit 0\n')).toMatchObject({ stdout: 'hello\nworld\n', exitCode: 0 });
    expect(runInBash('test -d / && echo yes || echo no')).toMatchObject({ stdout: 'yes\n', exitCode: 0 });
    expect(runInBash('exit 3')).toMatchObject({ exitCode: 3 });
  });

  it('runs if, case, pipes and || across lines with Windows line ends', () => {
    const command = [
      'ARCHIVE="/no/such/archive.tar.gz"',
      'EXPECTED="ghcr.io/example/frontend:v3.0.0"',
      'echo "ARCHIVE=$ARCHIVE"',
      '',
      'if [ -n "$EXPECTED" ]; then',
      '  echo "expected set"',
      'fi',
      '',
      'printf "a\\nb\\nc\\n" | grep -c . | tr -d " "',
      'MANIFEST="ghcr.io/example/frontend:v3.0.0"',
      'case "$MANIFEST" in',
      '  *"$EXPECTED"*)',
      '    echo match',
      '    ;;',
      '  *)',
      '    exit 1',
      '    ;;',
      'esac',
      'test -f "$ARCHIVE" || exit 4',
      ''
    ].join('\r\n');
    const r = runInBash(command);
    expect(r.stdout).toBe('ARCHIVE=/no/such/archive.tar.gz\nexpected set\n3\nmatch\n');
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(4);
  });
});
