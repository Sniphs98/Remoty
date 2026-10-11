import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fakeCli, setReplies } from '../../testSupport/fakeCli';
import type { TurnRequest } from './backend';
import { codexArgs, codexCliBackend, codexCliStatus, parseCodexEvents } from './codexCli';
import type { Entry } from './types';

let dir: string;
let bin: string;
let log: string;
let replies: string;
const saved = { log: process.env.FAKE_CLI_LOG, reply: process.env.FAKE_CLI_REPLY };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'remoty-codex-cli-'));
  bin = fakeCli(join(dir, 'bin'), 'codex');
  log = join(dir, 'log.jsonl');
  replies = join(dir, 'replies.json');
  process.env.FAKE_CLI_LOG = log;
  process.env.FAKE_CLI_REPLY = replies;
});
afterEach(() => {
  process.env.FAKE_CLI_LOG = saved.log;
  process.env.FAKE_CLI_REPLY = saved.reply;
  if (saved.log === undefined) delete process.env.FAKE_CLI_LOG;
  if (saved.reply === undefined) delete process.env.FAKE_CLI_REPLY;
  rmSync(dir, { recursive: true, force: true });
});

function calls(): { args: string[]; stdin: string }[] {
  return readFileSync(log, 'utf-8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}

function events(threadId = 'thread-1', answer: unknown = { text: 'Look at memory.', commands: [{ command: 'free -h', explanation: 'memory', risk: 'safe' }] }): string {
  return [
    { type: 'thread.started', thread_id: threadId },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'i0', type: 'error', message: 'Codex is ignoring 1 unrecognized configuration setting.' } },
    { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: typeof answer === 'string' ? answer : JSON.stringify(answer) } },
    { type: 'turn.completed', usage: { input_tokens: 900, cached_input_tokens: 800, output_tokens: 30 } }
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');
}

const user = (seq: number, text: string): Entry => ({ id: `e${seq}`, problemId: 'p', seq, createdAt: 0, kind: 'user', text });

function request(over: Partial<TurnRequest> = {}): TurnRequest {
  return {
    apiKey: '',
    model: '',
    system: 'SYSTEM PROMPT',
    entries: [user(1, 'out of memory?')],
    commands: [],
    signal: new AbortController().signal,
    onText: () => {},
    cliPath: bin,
    ...over
  };
}

describe('codexArgs', () => {
  it('turns Codex\'s own tools off and resumes the thread', () => {
    const args = codexArgs({ model: '', schemaFile: 's.json', dir: '/w', threadId: 't1' });
    expect(args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(args).toEqual(expect.arrayContaining(['features.shell_tool=false', 'features.unified_exec=false', '--sandbox', 'read-only']));
    expect(args.slice(-3)).toEqual(['resume', 't1', '-']);
    expect(codexArgs({ model: 'gpt-5.5', schemaFile: 's.json', dir: '/w' })).not.toContain('resume');
  });
});

describe('parseCodexEvents', () => {
  it('keeps the thread, the last message, usage and failures', () => {
    expect(parseCodexEvents(events())).toMatchObject({ threadId: 'thread-1', usage: { input_tokens: 900 } });
    expect(parseCodexEvents('{"type":"turn.failed","error":{"message":"boom"}}').failure).toBe('boom');
  });
});

describe('codexCliBackend', () => {
  const backend = (): ReturnType<typeof codexCliBackend> => codexCliBackend(() => join(dir, 'work'));

  it('starts a thread with the system prompt and returns the commands', async () => {
    setReplies(replies, { '*': [{ stdout: events() }] });
    const out = await backend().turn(request());
    expect(out).toMatchObject({
      text: 'Look at memory.',
      calls: [{ input: { command: 'free -h' } }],
      usage: { input: 900, output: 30 },
      sessionId: 'thread-1'
    });
    const [call] = calls();
    expect(call.stdin).toMatch(/^SYSTEM PROMPT\n\n.*answer with JSON/s);
    expect(call.stdin).toMatch(/out of memory\?$/);
    const schema = JSON.parse(readFileSync(call.args[call.args.indexOf('--output-schema') + 1], 'utf-8'));
    expect(schema.required).toEqual(['text', 'commands']);
  });

  it('sends only what is new to a resumed thread', async () => {
    setReplies(replies, { '*': [{ stdout: events() }] });
    await backend().turn(request({ entries: [user(1, 'old'), user(2, 'and now?')], session: { id: 'thread-1', lastSeq: 1 } }));
    const [call] = calls();
    expect(call.args.slice(-3)).toEqual(['resume', 'thread-1', '-']);
    expect(call.stdin).toBe('and now?');
  });

  it('shows an answer that is not JSON as text', async () => {
    setReplies(replies, { '*': [{ stdout: events('thread-1', 'plain words') }] });
    const out = await backend().turn(request());
    expect(out).toMatchObject({ text: 'plain words', calls: [], notice: expect.stringMatching(/expected format/) });
  });

  it('says how to sign in when Codex is signed out', async () => {
    setReplies(replies, { '*': [{ stdout: '{"type":"turn.failed","error":{"message":"401 Unauthorized"}}', exit: 1 }] });
    await expect(backend().turn(request())).rejects.toThrow(/not signed in — run `codex login`/);
  });
});

describe('codexCliStatus', () => {
  it('reports version and sign-in', async () => {
    setReplies(replies, { '--version': [{ stdout: 'codex-cli 0.162.1\n' }], 'login status': [{ stderr: 'Logged in using ChatGPT\n' }] });
    expect(await codexCliStatus(bin)).toMatchObject({ installed: true, version: 'codex-cli 0.162.1', loggedIn: true, detail: 'Logged in using ChatGPT' });
  });

  it('reports a signed-out CLI', async () => {
    setReplies(replies, { 'login status': [{ stderr: 'Not logged in\n', exit: 1 }] });
    expect(await codexCliStatus(bin)).toMatchObject({ installed: true, loggedIn: false, detail: 'Not logged in' });
  });
});
