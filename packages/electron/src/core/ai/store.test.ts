import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SecretCipher } from '../config/secretCipher';
import { AiStore } from './store';

const plain: SecretCipher = {
  available: false,
  encrypt: () => {
    throw new Error('unavailable');
  },
  decrypt: () => {
    throw new Error('unavailable');
  }
};

/** Reversible stand-in for the OS keystore. */
const xor: SecretCipher = {
  available: true,
  encrypt: (s) => Buffer.from(Buffer.from(s, 'utf-8').map((b) => b ^ 0x5a)),
  decrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf-8')
};

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'remoty-ai-'));
  file = join(dir, 'ai.sqlite');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('AiStore', () => {
  it('keeps problems, entries and commands across a reopen', async () => {
    const store = await AiStore.open(file, plain);
    const p = store.createProblem({ hostKey: 'web-1', hostLabel: 'web-1', title: 'nginx', systemPrompt: 'sys' });
    store.appendEntry(p.id, { kind: 'user', text: 'nginx does not start' });
    const a = store.appendEntry(p.id, { kind: 'assistant', text: 'Check it', provider: 'anthropic', model: 'm', payload: [{ type: 'text' }] });
    const c = store.addCommand({
      problemId: p.id,
      entryId: a.id,
      callId: 'toolu_1',
      command: 'systemctl status nginx',
      explanation: 'status',
      risk: 'safe',
      state: 'proposed'
    });
    store.updateCommand(c.id, { state: 'ran', output: 'failed', ranAt: 5 });
    store.addUsage(p.id, 10, 2);
    store.close();

    const again = await AiStore.open(file, plain);
    expect(again.problems('web-1').map((x) => x.title)).toEqual(['nginx']);
    expect(again.problem(p.id)?.inputTokens).toBe(10);
    expect(again.entries(p.id).map((e) => [e.seq, e.kind])).toEqual([
      [1, 'user'],
      [2, 'assistant']
    ]);
    expect(again.commands(p.id)).toMatchObject([{ command: 'systemctl status nginx', state: 'ran', output: 'failed', ranAt: 5 }]);
    again.close();
  });

  it('lists the most recently active problem first, per host', async () => {
    const store = await AiStore.open(file, plain);
    const a = store.createProblem({ hostKey: 'h', hostLabel: 'h', title: 'a', systemPrompt: '' });
    store.createProblem({ hostKey: 'h', hostLabel: 'h', title: 'b', systemPrompt: '' });
    store.createProblem({ hostKey: 'other', hostLabel: 'other', title: 'c', systemPrompt: '' });
    await new Promise((r) => setTimeout(r, 2));
    store.appendEntry(a.id, { kind: 'user', text: 'again' });
    expect(store.problems('h').map((p) => p.title)).toEqual(['a', 'b']);
    expect(store.problems()).toHaveLength(3);
    store.close();
  });

  it('deletes a problem with everything in it', async () => {
    const store = await AiStore.open(file, plain);
    const p = store.createProblem({ hostKey: 'h', hostLabel: 'h', title: 't', systemPrompt: '' });
    const e = store.appendEntry(p.id, { kind: 'assistant', text: '', provider: 'openai', model: 'm', payload: [] });
    store.addCommand({ problemId: p.id, entryId: e.id, callId: 'c', command: 'ls', explanation: '', risk: 'safe', state: 'proposed' });
    store.deleteProblem(p.id);
    expect(store.entries(p.id)).toEqual([]);
    expect(store.commands(p.id)).toEqual([]);
    store.close();
  });

  it('encrypts the file when a keystore is available', async () => {
    const store = await AiStore.open(file, xor);
    const p = store.createProblem({ hostKey: 'h', hostLabel: 'h', title: 'secret title', systemPrompt: '' });
    store.close();
    expect(readFileSync(file).includes(Buffer.from('secret title'))).toBe(false);
    const again = await AiStore.open(file, xor);
    expect(again.problem(p.id)?.title).toBe('secret title');
    again.close();
  });

  it('sets an unreadable file aside and starts fresh', async () => {
    writeFileSync(file, Buffer.concat([Buffer.from('REMOTY-AI-ENC1\n'), Buffer.from('garbage')]));
    const store = await AiStore.open(file, plain);
    expect(store.problems()).toEqual([]);
    store.close();
    expect(readdirSync(dir).some((f) => f.startsWith('ai.sqlite.unreadable-'))).toBe(true);
  });
});
