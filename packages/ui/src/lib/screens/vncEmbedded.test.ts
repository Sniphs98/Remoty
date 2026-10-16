import { describe, expect, it } from 'vitest';
import { credentialFields, explainVncEnd } from './vncEmbedded';

describe('credentialFields', () => {
  it('asks for a user only when the server wants one', () => {
    expect(credentialFields(['password']).username).toBe(false);
    expect(credentialFields(['username', 'password']).username).toBe(true);
    expect(credentialFields(undefined).username).toBe(false);
  });
});

describe('explainVncEnd', () => {
  it("prefers the gateway's own account", () => {
    expect(explainVncEnd({ gatewayFailure: 'could not reach x:5900: ECONNREFUSED', clean: false, connected: false })).toBe(
      'Could not reach x:5900: ECONNREFUSED.'
    );
  });

  it("passes on the server's reason for refusing, or blames the password", () => {
    expect(explainVncEnd({ securityFailure: { status: 1, reason: 'Too many attempts' }, clean: true, connected: false })).toBe(
      'The server refused to sign in: Too many attempts.'
    );
    expect(explainVncEnd({ securityFailure: { status: 1 }, clean: true, connected: false })).toBe('The password was not accepted.');
  });

  it('says nothing about a session closed on purpose, and tells a lost one', () => {
    expect(explainVncEnd({ clean: true, connected: true })).toBeNull();
    expect(explainVncEnd({ clean: false, connected: true })).toBe('The connection was lost.');
    expect(explainVncEnd({ clean: false, connected: false })).toBe('Could not connect to the server.');
  });
});
