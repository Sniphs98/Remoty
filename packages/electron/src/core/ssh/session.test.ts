import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { defaultHost, type Host } from './client.js';
import { SshSession, buildCdShellCommand, connectBudgetMs, hostKeyMessage, unreachableMessage, useHosts } from './session.js';

describe('buildCdShellCommand', () => {
  it('cds into the path, then execs a login shell', () => {
    const cmd = buildCdShellCommand('/var/www');
    expect(cmd).toBe(`cd '/var/www' 2>/dev/null; exec "$SHELL" -l`);
  });

  it('falls through to the login default rather than aborting if cd fails', () => {
    const cmd = buildCdShellCommand('/var/www');
    expect(cmd).toContain('2>/dev/null;');
    expect(cmd).not.toContain('&&');
  });

  it('escapes a single quote in the path', () => {
    const cmd = buildCdShellCommand("/srv/o'brien");
    expect(cmd).toContain(`'/srv/o'\\''brien'`);
  });
});

describe('useHosts', () => {
  const host = (name: string, proxyJump?: string): Host => ({ ...defaultHost(), name, hostname: `${name}.example`, proxyJump });

  it('resolves jump chains against the host list it was given, not the config files', async () => {
    // Neither host exists on disk: the chain can only resolve from the given list.
    const outer = host('remoty-test-outer-bastion');
    const inner = host('remoty-test-inner-bastion', outer.name);
    const target = host('remoty-test-target', inner.name);
    useHosts([outer, inner, target]);
    // Two bastions plus the target: three per-hop connect budgets.
    expect(await connectBudgetMs(target)).toBe(3 * (await connectBudgetMs(outer)));
  });
});

describe('hostKeyMessage', () => {
  it('names the changed key and the command that removes the old one', () => {
    const msg = hostKeyMessage({ name: 'test-container', hostname: '127.0.0.1', port: 2222 }, 'key-changed');
    expect(msg).toContain('host key of test-container (127.0.0.1:2222) has changed');
    expect(msg).toContain('ssh-keygen -R "[127.0.0.1]:2222"');
    // Port 22 is written without brackets, as known_hosts has it.
    expect(hostKeyMessage({ name: 'web', hostname: 'web.example.com', port: 22 }, 'key-changed')).toContain('ssh-keygen -R "web.example.com"');
  });

  it('says when known_hosts cannot be read', () => {
    expect(hostKeyMessage({ name: 'web', hostname: 'w', port: 22 }, 'unreadable')).toMatch(/known_hosts can't be read/);
  });
});

describe('unreachableMessage', () => {
  const host = { name: 'web', hostname: '10.0.0.5', port: 2222 };
  it('says why the server could not be reached, in plain words', () => {
    expect(unreachableMessage(host, 'connect ECONNREFUSED 10.0.0.5:2222')).toMatch(/nothing is listening on that port/);
    expect(unreachableMessage(host, 'getaddrinfo ENOTFOUND 10.0.0.5')).toBe('Could not reach web: there is no host called 10.0.0.5');
    expect(unreachableMessage(host, 'Timed out while waiting for handshake')).toMatch(/no answer/);
    expect(unreachableMessage(host, 'connect EHOSTUNREACH')).toMatch(/no route/);
    expect(unreachableMessage(host, 'something odd')).toBe('Could not reach web (10.0.0.5:2222): something odd');
  });
});

describe('exit status', () => {
  /** A session over a fake client whose exec channel reports exit `code` straight away —
   *  in the same tick as the exec reply, as ssh2 does when both arrive in one socket
   *  read — and closes a moment later. */
  function sessionExiting(code: number): SshSession {
    const client = {
      exec(_cmd: string, cb: (err: Error | undefined, channel: EventEmitter) => void) {
        const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
        cb(undefined, channel);
        channel.emit('exit', code);
        setTimeout(() => channel.emit('close'), 0);
      }
    };
    // The constructor is private: sessions come from connect()/shared(), which dial.
    const Session = SshSession as unknown as new (connection: { client: typeof client }) => SshSession;
    return new Session({ client });
  }

  it('is seen even when it arrives with the exec reply', async () => {
    await expect(sessionExiting(7).runCommandChecked('exit 7')).rejects.toThrow('exited with status 7');
    await expect(sessionExiting(7).runShell('exit 7')).resolves.toMatchObject({ ok: false, error: 'remote command exited with status 7' });
    await expect(sessionExiting(0).runShell('true')).resolves.toMatchObject({ ok: true });
  });
});

// A command from the editor on Windows has `\r\n` line ends. An SSH server runs an exec
// request as `$SHELL -c <command>`; this fake one does just that, in this machine's bash.
describe.skipIf(process.platform === 'win32')('runShell with Windows line ends', () => {
  const received: string[] = [];
  function sessionRunningInBash(): SshSession {
    const client = {
      exec(cmd: string, cb: (err: Error | undefined, channel: EventEmitter) => void) {
        received.push(cmd);
        const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), destroy() {}, close() {}, signal() {} });
        cb(undefined, channel);
        const child = spawn('bash', ['-c', cmd]);
        child.stdout.on('data', (d: Buffer) => channel.emit('data', d));
        child.stderr.on('data', (d: Buffer) => channel.stderr.emit('data', d));
        child.on('close', (code) => {
          channel.emit('exit', code);
          channel.emit('close');
        });
      }
    };
    const Session = SshSession as unknown as new (connection: { client: typeof client }) => SshSession;
    return new Session({ client });
  }
  const crlf = (...lines: string[]): string => lines.join('\r\n') + '\r\n';

  it('sends the host the command with Linux line ends', async () => {
    const result = await sessionRunningInBash().runShell('echo "hello"\r\n' + 'echo "world"\r\n' + 'exit 0\r\n', 10_000);
    expect(received.at(-1)).toBe('echo "hello"\necho "world"\nexit 0\n');
    expect(result).toMatchObject({ ok: true, exitCode: 0, stdout: 'hello\nworld\n', stderr: '' });
    expect(result.output).not.toContain("$'\\r'");
  });

  it('keeps the exit code of if, case, pipes and || across such lines', async () => {
    const result = await sessionRunningInBash().runShell(
      crlf('if [ -d / ]; then', '  echo dir', 'fi', 'case x in', '  x) echo case ;;', 'esac', 'printf "a\\nb\\n" | wc -l | tr -d " "', 'false || exit 7'),
      10_000
    );
    expect(result).toMatchObject({ ok: false, exitCode: 7, stdout: 'dir\ncase\n2\n', stderr: '' });
  });

  // The app's own commands (key setup, monitoring, discovery) go the same way.
  it('sends runCommand and runCommandChecked to the host with Linux line ends too', async () => {
    const session = sessionRunningInBash();
    // (`runCommand` gives its output line by line — what the parsers read — hence the trim.)
    expect((await session.runCommand(crlf('echo "hello"', 'echo "world"'))).trim()).toBe('hello\nworld');
    expect(received.at(-1)).toBe('echo "hello"\necho "world"\n');
    expect((await session.runCommandChecked(crlf('if [ -d / ]; then', '  echo ok', 'fi'))).trim()).toBe('ok');
    await expect(session.runCommandChecked(crlf('echo before', 'exit 3'))).rejects.toThrow('exited with status 3');
  });

  it('runs a one-line command as it always did', async () => {
    const result = await sessionRunningInBash().runShell('test -d / && echo yes || echo no', 10_000);
    expect(received.at(-1)).toBe('test -d / && echo yes || echo no');
    expect(result).toMatchObject({ ok: true, exitCode: 0, stdout: 'yes\n' });
  });
});
