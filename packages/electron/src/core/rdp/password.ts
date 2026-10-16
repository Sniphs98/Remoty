import type { RemoteDesktopConnection } from '../config/remoteDesktop.js';
import { OnePasswordError, readSecretCached, resolvePort, resolveReference } from '../secrets/onePassword.js';

/**
 * The password to sign in to `connection` with: read from 1Password when it has a
 * reference (remembered for a few minutes, see `readSecretCached`), else the stored
 * one. Read before anything connects — a Windows Hello or Touch ID prompt for the
 * 1Password CLI can take a while.
 */
export async function connectionPassword(connection: Pick<RemoteDesktopConnection, 'password' | 'passwordRef'>): Promise<string | undefined> {
  if (connection.passwordRef) return readSecretCached(connection.passwordRef);
  return connection.password;
}

/**
 * `connection` with everything that comes from 1Password filled in: the address, user
 * name and domain when they are references (`op://…` in the field itself), the port
 * from `portRef` and the password from `passwordRef`. The result carries no references
 * any more, so whatever launches or tunnels it needs no knowledge of 1Password.
 */
export async function resolveConnection<
  C extends Pick<RemoteDesktopConnection, 'hostname' | 'port' | 'portRef' | 'username' | 'domain' | 'password' | 'passwordRef'>
>(connection: C): Promise<C> {
  // One after the other: the first read may wait for Windows Hello / Touch ID, and
  // the rest then ride on that unlock.
  const hostname = await resolveReference(connection.hostname);
  const port = await resolvePort(connection.portRef, connection.port);
  const username = connection.username ? await resolveReference(connection.username) : connection.username;
  const domain = connection.domain ? await resolveReference(connection.domain) : connection.domain;
  const password = await connectionPassword(connection);
  return { ...connection, hostname, port, portRef: undefined, username, domain, password, passwordRef: undefined };
}

type SignInFields = Pick<RemoteDesktopConnection, 'hostname' | 'port' | 'portRef' | 'username' | 'domain' | 'password' | 'passwordRef'>;

/** Sign-in details typed in the tab for one connection: they stand in for the profile's
 *  (and its 1Password ones), and are never saved. */
export interface TypedSignIn {
  username?: string;
  password: string;
  domain?: string;
}

/**
 * Like `resolveConnection`, but 1Password failing to give the sign-in — user name,
 * domain or password — doesn't fail the connection: those are left out and
 * `signInProblem` says why, so the tab can ask for them instead. The address and port
 * still have to come through (there's nothing to connect to without them). With
 * `typed` sign-in details, 1Password isn't asked for the sign-in at all.
 */
export async function resolveForSignIn<C extends SignInFields>(
  connection: C,
  typed?: TypedSignIn
): Promise<{ connection: C; signInProblem?: string }> {
  const hostname = await resolveReference(connection.hostname);
  const port = await resolvePort(connection.portRef, connection.port);
  const base = { ...connection, hostname, port, portRef: undefined, passwordRef: undefined };
  if (typed) {
    return {
      connection: { ...base, username: typed.username || undefined, domain: typed.domain || undefined, password: typed.password }
    };
  }
  let signInProblem: string | undefined;
  const lenient = async (read: () => Promise<string | undefined>): Promise<string | undefined> => {
    try {
      return await read();
    } catch (err) {
      if (!(err instanceof OnePasswordError)) throw err;
      signInProblem ??= err.message;
      return undefined;
    }
  };
  const username = connection.username ? await lenient(() => resolveReference(connection.username!)) : connection.username;
  const domain = connection.domain ? await lenient(() => resolveReference(connection.domain!)) : connection.domain;
  const password = await lenient(() => connectionPassword(connection));
  return { connection: { ...base, username, domain, password }, signInProblem };
}
