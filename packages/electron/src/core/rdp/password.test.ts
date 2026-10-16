import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearSecretCache, setOpRunner } from '../secrets/onePassword.js';
import { connectionPassword, resolveConnection, resolveForSignIn } from './password.js';

describe('connectionPassword', () => {
  afterEach(() => {
    setOpRunner(undefined);
    clearSecretCache();
  });

  it('is the stored password when there is no 1Password reference', async () => {
    expect(await connectionPassword({ password: 'stored' })).toBe('stored');
    expect(await connectionPassword({})).toBeUndefined();
  });

  it('comes from 1Password when there is a reference — which wins over a stored one', async () => {
    const op = vi.fn(async () => ({ stdout: 'from-1password', stderr: '' }));
    setOpRunner(op);
    expect(await connectionPassword({ password: 'stored', passwordRef: 'op://Servers/win11/password' })).toBe('from-1password');
    expect(op).toHaveBeenCalledWith(['read', '--no-newline', 'op://Servers/win11/password']);
  });

  it('asks 1Password once for a while, however often it connects', async () => {
    const op = vi.fn(async () => ({ stdout: 'secret', stderr: '' }));
    setOpRunner(op);
    await connectionPassword({ passwordRef: 'op://Servers/win11/password' });
    await connectionPassword({ passwordRef: 'op://Servers/win11/password' });
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('resolves address, user and password — only the fields that are references', async () => {
    const values: Record<string, string> = {
      'op://Servers/win11/host': '10.0.0.7',
      'op://Servers/win11/password': 'pw'
    };
    const op = vi.fn(async (args: string[]) => ({ stdout: values[args[2]], stderr: '' }));
    setOpRunner(op);
    const resolved = await resolveConnection({
      hostname: 'op://Servers/win11/host',
      username: 'admin',
      passwordRef: 'op://Servers/win11/password',
      port: 3389
    });
    expect(resolved).toEqual({ hostname: '10.0.0.7', username: 'admin', password: 'pw', passwordRef: undefined, port: 3389 });
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('resolves the port and the domain too', async () => {
    const values: Record<string, string> = { 'op://S/pc/port': '13389\n', 'op://S/pc/domain': 'CORP' };
    setOpRunner(async (args: string[]) => ({ stdout: values[args[2]], stderr: '' }));
    const resolved = await resolveConnection({ hostname: 'pc', port: 3389, portRef: 'op://S/pc/port', domain: 'op://S/pc/domain' });
    expect(resolved).toMatchObject({ port: 13389, portRef: undefined, domain: 'CORP' });
  });

  it('refuses a port that is not one — without echoing what 1Password returned', async () => {
    setOpRunner(async () => ({ stdout: 'hunter2', stderr: '' }));
    const err = await resolveConnection({ hostname: 'pc', port: 3389, portRef: 'op://S/pc/password' }).catch((e: Error) => e);
    expect((err as Error).message).toBe('1Password: op://S/pc/password is not a port number (1–65535)');
  });

  it('leaves a connection without references as it is, without asking 1Password', async () => {
    const op = vi.fn();
    setOpRunner(op);
    expect(await resolveConnection({ hostname: 'win11.lan', username: 'admin', password: 'pw' })).toEqual({
      hostname: 'win11.lan',
      username: 'admin',
      password: 'pw',
      passwordRef: undefined
    });
    expect(op).not.toHaveBeenCalled();
  });

  it("says what's wrong when 1Password can't be asked", async () => {
    setOpRunner(async () => Promise.reject(Object.assign(new Error('spawn op ENOENT'), { code: 'ENOENT' })));
    await expect(connectionPassword({ passwordRef: 'op://Servers/win11/password' })).rejects.toThrow('1Password CLI (op) not found');
  });
});

describe('resolveForSignIn', () => {
  afterEach(() => {
    setOpRunner(undefined);
    clearSecretCache();
  });

  const refs = {
    hostname: '10.0.0.7',
    port: 3389,
    username: 'op://Servers/win11/username',
    passwordRef: 'op://Servers/win11/password'
  };

  it("leaves the sign-in out and says why when 1Password can't give it — the address still counts", async () => {
    setOpRunner(async () => {
      throw Object.assign(new Error('failed'), { stderr: '[ERROR] item not found', code: 1 });
    });
    const { connection, signInProblem } = await resolveForSignIn(refs);
    expect(connection).toMatchObject({ hostname: '10.0.0.7', port: 3389, username: undefined, password: undefined });
    expect(signInProblem).toMatch(/1Password/);
  });

  it('with sign-in details typed in the tab, does not ask 1Password for the sign-in at all', async () => {
    const op = vi.fn(async () => ({ stdout: 'x', stderr: '' }));
    setOpRunner(op);
    const { connection, signInProblem } = await resolveForSignIn(refs, { username: 'admin', password: 'typed', domain: '' });
    expect(connection).toMatchObject({ username: 'admin', password: 'typed', domain: undefined });
    expect(signInProblem).toBeUndefined();
    expect(op).not.toHaveBeenCalled();
  });

  it('an address that only 1Password knows still has to come through', async () => {
    setOpRunner(async () => {
      throw Object.assign(new Error('failed'), { stderr: '[ERROR] locked', code: 1 });
    });
    await expect(resolveForSignIn({ ...refs, hostname: 'op://Servers/win11/host' })).rejects.toThrow(/1Password/);
  });
});
