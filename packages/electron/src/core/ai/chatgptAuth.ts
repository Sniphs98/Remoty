import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

/**
 * "Sign in with ChatGPT" (experimental): the OAuth flow the Codex CLI uses, so a ChatGPT
 * plan can pay for the AI helper without any CLI installed. OpenAI does not document it
 * for other apps; it is tolerated today and may stop working. The browser signs in at
 * auth.openai.com and comes back to a short-lived server on 127.0.0.1; Remoty keeps the
 * refresh token (encrypted, `ai.toml`) and the access token in memory only.
 */

export const CHATGPT_ISSUER = 'https://auth.openai.com';
export const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
/** The ports the client's redirect is registered for, tried in order. */
const PORTS = [1455, 1457];
const LOGIN_TIMEOUT_MS = 5 * 60_000;
/** Refresh this long before the access token runs out. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export interface ChatgptTokens {
  /** Empty after a refresh that did not send a new one. */
  idToken: string;
  accessToken: string;
  refreshToken: string;
}

export interface ChatgptAccount {
  accountId: string;
  email?: string;
  /** plus, pro, team, … as the ID token says. */
  plan?: string;
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(64));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

/** A JWT's claims, unverified — only read to show who is signed in and when the token
 *  runs out; OpenAI's servers check the token itself. */
export function jwtClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function accountFrom(idToken: string): ChatgptAccount {
  const claims = jwtClaims(idToken);
  const auth = (claims['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;
  const accountId = typeof auth.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : '';
  if (!accountId) throw new Error('The sign-in did not include a ChatGPT account — is there a ChatGPT plan on this login?');
  return {
    accountId,
    ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
    ...(typeof auth.chatgpt_plan_type === 'string' ? { plan: auth.chatgpt_plan_type } : {})
  };
}

/** When the access token runs out (ms since epoch), or 0 when it doesn't say. */
export function expiresAt(accessToken: string): number {
  const exp = jwtClaims(accessToken).exp;
  return typeof exp === 'number' ? exp * 1000 : 0;
}

export function authorizeUrl(opts: { redirectUri: string; challenge: string; state: string }): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CHATGPT_CLIENT_ID,
    redirect_uri: opts.redirectUri,
    scope: 'openid profile email offline_access',
    code_challenge: opts.challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state: opts.state
  });
  return `${CHATGPT_ISSUER}/oauth/authorize?${params.toString()}`;
}

async function tokenRequest(body: string, contentType: string, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  const res = await fetchImpl(`${CHATGPT_ISSUER}/oauth/token`, { method: 'POST', headers: { 'Content-Type': contentType }, body });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Reported below.
  }
  if (!res.ok) {
    const detail = typeof json.error_description === 'string' ? json.error_description : typeof json.error === 'string' ? json.error : text.slice(0, 200);
    throw new Error(`ChatGPT sign-in failed (${res.status}): ${detail}`);
  }
  return json;
}

function tokensFrom(json: Record<string, unknown>, previous?: ChatgptTokens): ChatgptTokens {
  const str = (k: string): string | undefined => (typeof json[k] === 'string' && json[k] ? (json[k] as string) : undefined);
  const accessToken = str('access_token');
  if (!accessToken) throw new Error('ChatGPT sign-in returned no access token.');
  const idToken = str('id_token') ?? previous?.idToken ?? '';
  const refreshToken = str('refresh_token') ?? previous?.refreshToken;
  if (!refreshToken) throw new Error('ChatGPT sign-in returned no refresh token.');
  return { idToken, accessToken, refreshToken };
}

export async function exchangeCode(
  code: string,
  redirectUri: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch
): Promise<ChatgptTokens> {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: CHATGPT_CLIENT_ID, code_verifier: verifier });
  const tokens = tokensFrom(await tokenRequest(body.toString(), 'application/x-www-form-urlencoded', fetchImpl));
  if (!tokens.idToken) throw new Error('ChatGPT sign-in returned no ID token.');
  return tokens;
}

/** New tokens for a refresh token. OpenAI may hand out a new refresh token with them;
 *  the old one stops working then, so the caller stores what comes back. */
export async function refreshTokens(previous: ChatgptTokens, fetchImpl: typeof fetch = fetch): Promise<ChatgptTokens> {
  const body = JSON.stringify({ client_id: CHATGPT_CLIENT_ID, grant_type: 'refresh_token', refresh_token: previous.refreshToken, scope: 'openid profile email' });
  return tokensFrom(await tokenRequest(body, 'application/json', fetchImpl), previous);
}

export function needsRefresh(accessToken: string, now = Date.now()): boolean {
  const exp = expiresAt(accessToken);
  return exp === 0 || exp - now < REFRESH_MARGIN_MS;
}

const PAGE = (title: string, text: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;padding:3rem;text-align:center"><h1 style="font-size:1.4rem">${title}</h1><p>${text}</p></body>`;

function listen(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onError = (): void => resolve(false);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve(true);
    });
  });
}

/**
 * Signs in: opens the browser at OpenAI's sign-in page (`open`) and resolves with the
 * tokens once it comes back. Rejects when the user cancels (`signal`), after five
 * minutes, or when the sign-in fails.
 */
export async function loginWithBrowser(opts: {
  open: (url: string) => Promise<void> | void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  ports?: number[];
  timeoutMs?: number;
}): Promise<ChatgptTokens> {
  const { verifier, challenge } = pkcePair();
  const state = base64url(randomBytes(32));
  let finish: (result: ChatgptTokens | Error) => void = () => {};
  const done = new Promise<ChatgptTokens>((resolve, reject) => {
    finish = (result) => (result instanceof Error ? reject(result) : resolve(result));
  });
  // The browser can answer before `open` returns; `done` is awaited after it.
  done.catch(() => {});

  let redirectUri = '';
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/auth/callback') {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    if (url.searchParams.get('state') !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE('Sign-in failed', 'The answer did not belong to this sign-in. Try again from Remoty.'));
      return;
    }
    if (error || !code) {
      const why = url.searchParams.get('error_description') ?? error ?? 'no code';
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE('Sign-in failed', 'You can close this tab and try again from Remoty.'));
      finish(new Error(`ChatGPT sign-in failed: ${why}`));
      return;
    }
    exchangeCode(code, redirectUri, verifier, opts.fetchImpl)
      .then((tokens) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE('Signed in to Remoty', 'You can close this tab and go back to Remoty.'));
        finish(tokens);
      })
      .catch((err: Error) => {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE('Sign-in failed', 'You can close this tab and try again from Remoty.'));
        finish(err);
      });
  });

  let port: number | undefined;
  for (const p of opts.ports ?? PORTS) {
    if (await listen(server, p)) {
      port = (server.address() as { port: number }).port;
      break;
    }
  }
  if (port === undefined) {
    throw new Error('Could not start the sign-in: ports 1455 and 1457 are in use (is a Codex sign-in running?).');
  }
  // 127.0.0.1, as the Codex CLI uses: "localhost" may resolve to ::1, where nothing listens.
  redirectUri = `http://127.0.0.1:${port}/auth/callback`;

  const timer = setTimeout(() => finish(new Error('The ChatGPT sign-in timed out — try again.')), opts.timeoutMs ?? LOGIN_TIMEOUT_MS);
  const onAbort = (): void => finish(new Error('stopped'));
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await opts.open(authorizeUrl({ redirectUri, challenge, state }));
    return await done;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    server.closeAllConnections();
    server.close();
  }
}

/** What `ai.toml` keeps of a ChatGPT sign-in. */
export interface ChatgptLogin extends ChatgptAccount {
  refreshToken: string;
}

export class ChatgptSignedOutError extends Error {
  constructor(message = 'Not signed in to ChatGPT — sign in under Settings → AI.') {
    super(message);
  }
}

/**
 * The access token for requests: refreshed when it is about to run out, one refresh at
 * a time, and a rotated refresh token stored right away (the old one stops working).
 */
export class ChatgptCredentials {
  private access: { token: string; accountId: string } | undefined;
  private refreshing: Promise<{ accessToken: string; accountId: string }> | undefined;

  constructor(
    private readonly store: { load(): Promise<ChatgptLogin | undefined>; save(login: ChatgptLogin | undefined): Promise<void> },
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async get(): Promise<{ accessToken: string; accountId: string }> {
    if (this.access && !needsRefresh(this.access.token)) return { accessToken: this.access.token, accountId: this.access.accountId };
    this.refreshing ??= this.refresh().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  /** Keeps the tokens of a fresh sign-in (from `loginWithBrowser`). */
  async signIn(tokens: ChatgptTokens): Promise<ChatgptAccount> {
    const account = accountFrom(tokens.idToken);
    await this.store.save({ ...account, refreshToken: tokens.refreshToken });
    this.access = { token: tokens.accessToken, accountId: account.accountId };
    return account;
  }

  async signOut(): Promise<void> {
    this.access = undefined;
    await this.store.save(undefined);
  }

  /** Forgets the access token, so the next request refreshes it (after a 401). */
  invalidate(): void {
    this.access = undefined;
  }

  private async refresh(): Promise<{ accessToken: string; accountId: string }> {
    const login = await this.store.load();
    if (!login) throw new ChatgptSignedOutError();
    let tokens: ChatgptTokens;
    try {
      tokens = await refreshTokens({ idToken: '', accessToken: '', refreshToken: login.refreshToken }, this.fetchImpl);
    } catch (err) {
      if (/\((400|401)\)/.test((err as Error).message)) {
        throw new ChatgptSignedOutError('The ChatGPT sign-in has expired — sign in again under Settings → AI.');
      }
      throw err;
    }
    const account = tokens.idToken ? accountFrom(tokens.idToken) : login;
    if (tokens.refreshToken !== login.refreshToken || tokens.idToken) {
      await this.store.save({ ...login, ...account, refreshToken: tokens.refreshToken });
    }
    this.access = { token: tokens.accessToken, accountId: account.accountId };
    return { accessToken: tokens.accessToken, accountId: account.accountId };
  }
}
