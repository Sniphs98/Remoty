import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type AiSettings, DEFAULT_AI_SETTINGS } from '../config/ai';
import type { SecretCipher } from '../config/secretCipher';
import { anthropicMessages } from './anthropic';
import type { AiBackend, TurnRequest, TurnResult } from './backend';
import { AiEngine, type EngineEvent, titleFrom } from './engine';
import { openaiInput } from './openai';
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

/** A backend that answers from a script and remembers what it was asked. */
function scripted(id: 'anthropic' | 'openai', answers: ((req: TurnRequest) => TurnResult)[]): AiBackend & { requests: TurnRequest[] } {
  const requests: TurnRequest[] = [];
  return {
    id,
    requests,
    async turn(req) {
      requests.push(req);
      const next = answers.shift();
      if (!next) throw new Error('no scripted answer left');
      return next(req);
    },
    async check() {}
  };
}

function toolAnswer(calls: { id: string; command: string; risk?: string }[], text = 'Let us look.'): () => TurnResult {
  return () => ({
    payload: [
      { type: 'text', text },
      ...calls.map((c) => ({ type: 'tool_use', id: c.id, name: 'propose_command', input: { command: c.command, explanation: 'why', risk: c.risk ?? 'safe' } }))
    ],
    text,
    calls: calls.map((c) => ({ callId: c.id, input: { command: c.command, explanation: 'why', risk: c.risk ?? 'safe' } })),
    usage: { input: 100, output: 10 }
  });
}

const textAnswer = (text: string) => (): TurnResult => ({ payload: [{ type: 'text', text }], text, calls: [], usage: { input: 1, output: 1 } });

let dir: string;
let store: AiStore;
let events: EngineEvent[];
let settings: AiSettings;

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

function engineWith(backend: AiBackend): AiEngine {
  return new AiEngine({
    store,
    settings: async () => settings,
    apiKey: async () => 'key',
    backends: { anthropic: backend, openai: backend },
    secretsFor: () => ['hunter2hunter2'],
    emit: (e) => events.push(e)
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'remoty-ai-engine-'));
  store = await AiStore.open(join(dir, 'ai.sqlite'), plain);
  events = [];
  settings = { ...structuredClone(DEFAULT_AI_SETTINGS), maxOutputLines: 20 };
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('AiEngine', () => {
  it('turns tool calls into command cards and answers the model once the user ran them', async () => {
    const backend = scripted('anthropic', [
      toolAnswer([{ id: 't1', command: 'systemctl status nginx' }, { id: 't2', command: 'sudo rm -rf /var/cache/nginx', risk: 'safe' }]),
      textAnswer('The config has an error.')
    ]);
    const engine = engineWith(backend);
    const p = engine.createProblem('web-1', { kind: 'ssh', hostLabel: 'web-1' });
    engine.send(p.id, { text: 'nginx does not start', sessionKey: 's1' });
    await settle();

    const [status, cleanup] = store.commands(p.id);
    expect(status).toMatchObject({ command: 'systemctl status nginx', state: 'proposed', risk: 'safe' });
    // The local rules overrule the model's rating.
    expect(cleanup.risk).toBe('danger');
    expect(store.problem(p.id)?.title).toBe('nginx does not start');

    await engine.report(p.id, status.id, { state: 'ran', output: 'failed\npassword=hunter2hunter2' });
    await settle();
    // One card is still open: no new turn yet.
    expect(backend.requests).toHaveLength(1);

    await engine.report(p.id, cleanup.id, { state: 'skipped' });
    await settle();
    expect(backend.requests).toHaveLength(2);

    const sent = anthropicMessages(backend.requests[1]);
    expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const results = sent[2].content as { type: string; tool_use_id: string; content: string }[];
    expect(results.map((r) => r.tool_use_id)).toEqual(['t1', 't2']);
    expect(results[0].content).toContain('failed');
    expect(results[0].content).not.toContain('hunter2hunter2');
    expect(results[1].content).toContain('did not run');
    expect(store.entries(p.id).map((e) => e.kind)).toEqual(['user', 'assistant', 'results', 'assistant']);
  });

  it('waits for the user when results should not go out on their own', async () => {
    settings.replyToResult = false;
    const backend = scripted('anthropic', [toolAnswer([{ id: 't1', command: 'df -h' }]), textAnswer('Disk is fine.')]);
    const engine = engineWith(backend);
    const p = engine.createProblem('web-1', { kind: 'ssh', hostLabel: 'web-1' });
    engine.send(p.id, { text: 'disk?' });
    await settle();
    await engine.report(p.id, store.commands(p.id)[0].id, { state: 'ran', output: '/dev/sda1 40%' });
    await settle();
    expect(backend.requests).toHaveLength(1);

    engine.continue(p.id);
    await settle();
    expect(backend.requests).toHaveLength(2);
  });

  it('answers open cards as skipped when the user writes instead', async () => {
    const backend = scripted('anthropic', [toolAnswer([{ id: 't1', command: 'df -h' }]), textAnswer('ok')]);
    const engine = engineWith(backend);
    const p = engine.createProblem('web-1', { kind: 'ssh', hostLabel: 'web-1' });
    engine.send(p.id, { text: 'disk?' });
    await settle();
    engine.send(p.id, { text: 'never mind, it is docker' });
    await settle();
    expect(store.commands(p.id)[0].state).toBe('skipped');
    // Tool results first, then the new text, in one user message.
    const sent = anthropicMessages(backend.requests[1]);
    expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect((sent[2].content as { type: string }[]).map((b) => b.type)).toEqual(['tool_result', 'text']);
  });

  it('tells the model when the user is back in a new terminal session', async () => {
    const backend = scripted('anthropic', [textAnswer('a'), textAnswer('b')]);
    const engine = engineWith(backend);
    const p = engine.createProblem('web-1', { kind: 'ssh', hostLabel: 'web-1' });
    engine.send(p.id, { text: 'first', sessionKey: 'monday' });
    await settle();
    engine.send(p.id, { text: 'back again', sessionKey: 'tuesday' });
    await settle();
    const entries = store.entries(p.id).filter((e) => e.kind === 'user');
    expect(entries[0]).not.toHaveProperty('context');
    expect(entries[1]).toMatchObject({ context: expect.stringContaining('new terminal session') });
  });

  it('reports a failed request and lets the user retry', async () => {
    const backend = scripted('anthropic', []);
    const engine = engineWith(backend);
    const p = engine.createProblem('web-1', { kind: 'ssh', hostLabel: 'web-1' });
    engine.send(p.id, { text: 'hello' });
    await settle();
    expect(events).toContainEqual({ type: 'error', problemId: p.id, message: 'no scripted answer left' });
    expect(engine.isRunning(p.id)).toBe(false);
  });

  it('renders another provider\'s turns as text', async () => {
    const anthropic = scripted('anthropic', [toolAnswer([{ id: 't1', command: 'uptime' }])]);
    const engine = engineWith(anthropic);
    const p = engine.createProblem('web-1', { kind: 'ssh', hostLabel: 'web-1' });
    engine.send(p.id, { text: 'load?' });
    await settle();
    settings.replyToResult = false;
    await engine.report(p.id, store.commands(p.id)[0].id, { state: 'ran', output: 'load average: 0.1' });

    const input = openaiInput({ entries: store.entries(p.id), commands: store.commands(p.id) });
    expect(input).toEqual([
      { role: 'user', content: 'load?' },
      { role: 'assistant', content: 'Let us look.\n[proposed command: uptime]' },
      { role: 'user', content: expect.stringContaining('load average: 0.1') }
    ]);
  });
});

describe('titleFrom', () => {
  it('takes the first line, cut at a word', () => {
    expect(titleFrom('nginx does not start\nmore')).toBe('nginx does not start');
    expect(titleFrom('a'.repeat(10) + ' ' + 'b'.repeat(30) + ' ' + 'c'.repeat(40))).toBe('a'.repeat(10) + ' ' + 'b'.repeat(30) + '…');
  });
});
