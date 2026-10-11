import { describe, expect, it } from 'vitest';

import {
  accountFrom,
  authorizeUrl,
  CHATGPT_CLIENT_ID,
  ChatgptCredentials,
  type ChatgptLogin,
  ChatgptSignedOutError,
  jwtClaims,
  loginWithBrowser,
  needsRefresh,
  pkcePair
} from './chatgptAuth';

/** An unsigned JWT with these claims (Remoty only reads them). */
function jwt(claims: Record<string, unknown>): string {
  const part = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.sig`;
}

const ID_TOKEN = jwt({ email: 'me@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1', chatgpt_plan_type: 'plus' } });
const accessToken = (minutes: number): string => jwt({ exp: Math.floor((Date.now() + minutes * 60_000) / 1000) });

type Call = { url: string; body: string; contentType: string };

/** A token endpoint that answers from a list and remembers what it was sent. */
function tokenEndpoint(answers: { status?: number; json: Record<string, unknown> }[]): typeof fetch & { calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? ''), contentType: new Headers(init?.headers).get('content-type') ?? '' });
    const next = answers.shift() ?? { status: 500, json: { error: 'no answer left' } };
    return new Response(JSON.stringify(next.json), { status: next.status ?? 200 });
  }) as typeof fetch & { calls: Call[] };
  impl.calls = calls;
  return impl;
}

describe('pkcePair / authorizeUrl', () => {
  it('builds the sign-in URL the Codex client expects', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    const url = new URL(authorizeUrl({ redirectUri: 'http://127.0.0.1:1455/auth/callback', challenge, state: 's1' }));
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: CHATGPT_CLIENT_ID,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 's1',
      scope: 'openid profile email offline_access'
    });
  });
});

describe('jwtClaims / accountFrom / needsRefresh', () => {
  it('reads who signed in and when the token runs out', () => {
    expect(accountFrom(ID_TOKEN)).toEqual({ accountId: 'acc-1', email: 'me@example.com', plan: 'plus' });
    expect(jwtClaims('not a jwt')).toEqual({});
    expect(() => accountFrom(jwt({ email: 'x' }))).toThrow(/ChatGPT account/);
    expect(needsRefresh(accessToken(60))).toBe(false);
    expect(needsRefresh(accessToken(2))).toBe(true);
    expect(needsRefresh('opaque')).toBe(true);
  });
});

describe('loginWithBrowser', () => {
  /** Plays the browser: follows the sign-in URL straight to Remoty's callback. */
  const browser = (answer: (url: URL) => Record<string, string>) => async (signIn: string) => {
    const url = new URL(signIn);
    const back = new URL(url.searchParams.get('redirect_uri')!);
    for (const [k, v] of Object.entries(answer(url))) back.searchParams.set(k, v);
    await fetch(back);
  };

  it('signs in through the browser and exchanges the code', async () => {
    const endpoint = tokenEndpoint([{ json: { id_token: ID_TOKEN, access_token: accessToken(60), refresh_token: 'r1' } }]);
    const tokens = await loginWithBrowser({
      open: browser((url) => ({ code: 'c0de', state: url.searchParams.get('state')! })),
      fetchImpl: endpoint,
      ports: [0]
    });
    expect(tokens.refreshToken).toBe('r1');
    const form = new URLSearchParams(endpoint.calls[0].body);
    expect(endpoint.calls[0].url).toBe('https://auth.openai.com/oauth/token');
    expect(Object.fromEntries(form)).toMatchObject({ grant_type: 'authorization_code', code: 'c0de', client_id: CHATGPT_CLIENT_ID });
    expect(form.get('code_verifier')).toBeTruthy();
    expect(form.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  });

  it('ignores an answer that does not belong to this sign-in', async () => {
    const controller = new AbortController();
    const done = loginWithBrowser({
      open: async (signIn) => {
        await browser(() => ({ code: 'x', state: 'someone-else' }))(signIn);
        controller.abort();
      },
      signal: controller.signal,
      fetchImpl: tokenEndpoint([]),
      ports: [0]
    });
    await expect(done).rejects.toThrow('stopped');
  });

  it('reports a sign-in the user turned down', async () => {
    const done = loginWithBrowser({
      open: browser((url) => ({ error: 'access_denied', state: url.searchParams.get('state')! })),
      fetchImpl: tokenEndpoint([]),
      ports: [0]
    });
    await expect(done).rejects.toThrow(/access_denied/);
  });
});

describe('ChatgptCredentials', () => {
  function storeWith(login?: ChatgptLogin) {
    const saved: (ChatgptLogin | undefined)[] = [];
    let current = login;
    return {
      saved,
      store: {
        load: async () => current,
        save: async (l: ChatgptLogin | undefined) => {
          current = l;
          saved.push(l);
        }
      }
    };
  }

  it('refreshes once for parallel requests and keeps a rotated refresh token', async () => {
    const { store, saved } = storeWith({ accountId: 'acc-1', refreshToken: 'r1' });
    const endpoint = tokenEndpoint([{ json: { access_token: accessToken(60), refresh_token: 'r2' } }]);
    const creds = new ChatgptCredentials(store, endpoint);
    const [a, b] = await Promise.all([creds.get(), creds.get()]);
    expect(a).toEqual(b);
    expect(a.accountId).toBe('acc-1');
    expect(endpoint.calls).toHaveLength(1);
    expect(JSON.parse(endpoint.calls[0].body)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'r1', client_id: CHATGPT_CLIENT_ID });
    expect(saved).toEqual([{ accountId: 'acc-1', refreshToken: 'r2' }]);
    // Still valid: no new refresh.
    await creds.get();
    expect(endpoint.calls).toHaveLength(1);
  });

  it('says to sign in again when the refresh token is no longer taken', async () => {
    const { store } = storeWith({ accountId: 'acc-1', refreshToken: 'old' });
    const creds = new ChatgptCredentials(store, tokenEndpoint([{ status: 401, json: { error: 'invalid_grant' } }]));
    await expect(creds.get()).rejects.toThrow(ChatgptSignedOutError);
  });

  it('is signed out without a stored sign-in, and after signing out', async () => {
    const { store, saved } = storeWith();
    const creds = new ChatgptCredentials(store, tokenEndpoint([]));
    await expect(creds.get()).rejects.toThrow(/Not signed in/);
    const account = await creds.signIn({ idToken: ID_TOKEN, accessToken: accessToken(60), refreshToken: 'r1' });
    expect(account).toEqual({ accountId: 'acc-1', email: 'me@example.com', plan: 'plus' });
    expect((await creds.get()).accountId).toBe('acc-1');
    await creds.signOut();
    expect(saved.at(-1)).toBeUndefined();
    await expect(creds.get()).rejects.toThrow(/Not signed in/);
  });
});
