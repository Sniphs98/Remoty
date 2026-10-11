import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: {} }));

import { applyProvider } from './ai';

describe('applyProvider', () => {
  it('keeps the ChatGPT sign-in when the settings form is saved', () => {
    const login = { accountId: 'acc-1', refreshToken: 'r1', email: 'me@example.com' };
    expect(applyProvider({ login, model: 'gpt-5.5' }, { model: 'gpt-5.5-mini' })).toEqual({ login, model: 'gpt-5.5-mini' });
  });

  it('changes only what the input sets', () => {
    expect(applyProvider({ apiKey: 'k', path: '/opt/claude' }, { path: '' })).toEqual({ apiKey: 'k', path: undefined, apiKeyRef: undefined, model: undefined });
    expect(applyProvider({ apiKey: 'k' }, { clearKey: true })).toMatchObject({ apiKey: undefined });
    expect(() => applyProvider({}, { keyRef: 'not a reference' })).toThrow(/op:\/\//);
  });
});
