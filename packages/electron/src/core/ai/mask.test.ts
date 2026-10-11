import { describe, expect, it } from 'vitest';

import { REDACTED, maskSecrets } from './mask';

describe('maskSecrets', () => {
  it('removes private keys, whole', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAA\n-----END OPENSSH PRIVATE KEY-----';
    const out = maskSecrets(`cat id_ed25519\n${key}\n$ `);
    expect(out).not.toContain('b3BlbnNzaC1rZXktdjEAAAAA');
    expect(out).toContain(REDACTED);
    expect(out).toContain('$ ');
  });

  it('removes well-known token shapes', () => {
    const out = maskSecrets('GH ghp_abcdefghijklmnopqrstuvwxyz0123 and sk-ant-api03-abcdefghijklmnopqrstuv and AKIAABCDEFGHIJKLMNOP');
    expect(out).toBe(`GH ${REDACTED} and ${REDACTED} and ${REDACTED}`);
  });

  it('keeps the name of a secret-looking assignment and drops its value', () => {
    expect(maskSecrets('DB_PASSWORD=hunter22')).toBe(`DB_PASSWORD=${REDACTED}`);
    expect(maskSecrets('"api_key": "abc123def"')).toBe(`"api_key": "${REDACTED}"`);
    expect(maskSecrets('token: abc.def')).toBe(`token: ${REDACTED}`);
  });

  it('leaves ordinary lines alone', () => {
    const text = 'PWD=/home/me\n[sudo] password for me:\nnginx: [emerg] unknown directive "http2"';
    expect(maskSecrets(text)).toBe(text);
  });

  it('removes the password from a URL', () => {
    expect(maskSecrets('postgres://app:s3cr3t@db:5432/app')).toBe(`postgres://app:${REDACTED}@db:5432/app`);
  });

  it('removes values the caller knows are secret', () => {
    expect(maskSecrets('typed Tr0ub4dor here', ['Tr0ub4dor'])).toBe(`typed ${REDACTED} here`);
    // Too short to tell apart from ordinary text.
    expect(maskSecrets('the cat', ['cat'])).toBe('the cat');
  });
});
