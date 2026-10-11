import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fakeCli, setReplies } from '../../testSupport/fakeCli';
import type { TurnRequest } from './backend';
import { answerStreamer, claudeArgs, claudeCliBackend, claudeCliStatus, parseClaudeResult } from './claudeCli';
import type { Entry } from './types';

let dir: string;
let bin: string;
let log: string;
let replies: string;
const saved = { log: process.env.FAKE_CLI_LOG, reply: process.env.FAKE_CLI_REPLY };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'remoty-claude-cli-'));
  bin = fakeCli(join(dir, 'bin'), 'claude');
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

function calls(): { args: string[]; stdin: string; cwd: string }[] {
  return readFileSync(log, 'utf-8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}

function result(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 'sess-1',
    structured_output: { text: 'Check the disk.', commands: [{ command: 'df -h', explanation: 'disk use', risk: 'safe' }] },
    usage: { input_tokens: 2, cache_read_input_tokens: 500, cache_creation_input_tokens: 100, output_tokens: 40 },
    modelUsage: { 'claude-opus-5-5': {} },
    ...extra
  });
}

const user = (seq: number, text: string): Entry => ({ id: `e${seq}`, problemId: 'p', seq, createdAt: 0, kind: 'user', text });

function request(over: Partial<TurnRequest> = {}): TurnRequest & { streamed: string[] } {
  const streamed: string[] = [];
  return {
    apiKey: '',
    model: '',
    system: 'SYSTEM PROMPT',
    entries: [user(1, 'disk full?')],
    commands: [],
    signal: new AbortController().signal,
    onText: (d) => streamed.push(d),
    cliPath: bin,
    streamed,
    ...over
  };
}

describe('claudeArgs', () => {
  it('gives Claude Code no tools and starts or resumes the session', () => {
    const first = claudeArgs({ model: '', systemFile: 's.md', sessionId: 'abc', resume: false });
    expect(first).toEqual(expect.arrayContaining(['-p', '--tools', '', '--strict-mcp-config', '--session-id', 'abc']));
    expect(first).not.toContain('--model');
    const next = claudeArgs({ model: 'opus', systemFile: 's.md', sessionId: 'abc', resume: true });
    expect(next).toEqual(expect.arrayContaining(['--model', 'opus', '--resume', 'abc']));
    expect(next).not.toContain('--session-id');
  });
});

/** What `claude -p --output-format stream-json --include-partial-messages` prints for
 *  an answer whose JSON arrives in `pieces`. */
function stream(pieces: string[], extra: Record<string, unknown> = {}): string {
  const event = (e: unknown): string => JSON.stringify({ type: 'stream_event', event: e });
  return [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    event({ type: 'message_start', message: {} }),
    event({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'StructuredOutput', input: {} } }),
    ...pieces.map((p) => event({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: p } })),
    event({ type: 'content_block_stop', index: 0 }),
    result(extra)
  ].join('\n');
}

describe('answerStreamer', () => {
  it('reports the answer\'s text as it grows', () => {
    const deltas: string[] = [];
    const s = answerStreamer((d) => deltas.push(d));
    for (const line of stream(['{"te', 'xt":"Check', ' the di', 'sk.","comm', 'ands":[]}']).split('\n')) s.onLine(line);
    expect(deltas).toEqual(['Check', ' the di', 'sk.']);
    expect(s.shown()).toBe('Check the disk.');
  });
});

describe('parseClaudeResult', () => {
  it('finds the result event of a stream', () => {
    expect(parseClaudeResult(stream(['{"text":"x","commands":[]}']))).toMatchObject({ type: 'result', session_id: 'sess-1' });
  });

  it('finds the result among other output', () => {
    expect(parseClaudeResult(`warning: something\n${result()}\n`)).toMatchObject({ session_id: 'sess-1' });
    expect(parseClaudeResult('nothing')).toBeUndefined();
  });
});

describe('claudeCliBackend', () => {
  const backend = (): ReturnType<typeof claudeCliBackend> => claudeCliBackend(() => join(dir, 'work'));

  it('runs a new session and turns the answer into calls', async () => {
    setReplies(replies, { '*': [{ stdout: result() }] });
    const req = request();
    const out = await backend().turn(req);

    expect(out).toMatchObject({
      text: 'Check the disk.',
      calls: [{ callId: expect.stringMatching(/^cli-/), input: { command: 'df -h', explanation: 'disk use', risk: 'safe' } }],
      usage: { input: 602, output: 40 },
      sessionId: 'sess-1',
      model: 'claude-opus-5-5'
    });
    expect(req.streamed).toEqual(['Check the disk.']);
    const [call] = calls();
    expect(call.stdin).toBe('disk full?');
    expect(realpathSync(call.cwd)).toBe(realpathSync(join(dir, 'work')));
    expect(call.args).toContain('--session-id');
    // The system prompt went in a file, which is gone again.
    expect(readdirSync(join(dir, 'work'))).toEqual([]);
  });

  it('streams the text while Claude writes it', async () => {
    setReplies(replies, { '*': [{ stdout: stream(['{"text":"Check', ' the disk.","commands":[{"command":"df -h","explanation":"disk use","risk":"safe"}]}']) }] });
    const req = request();
    const out = await backend().turn(req);
    expect(req.streamed).toEqual(['Check', ' the disk.']);
    expect(out).toMatchObject({ text: 'Check the disk.', calls: [{ input: { command: 'df -h' } }] });
  });

  it('sends only what is new to a resumed session', async () => {
    setReplies(replies, { '*': [{ stdout: result() }] });
    await backend().turn(
      request({ entries: [user(1, 'old'), user(2, 'second question')], session: { id: 'sess-1', lastSeq: 1 } })
    );
    const [call] = calls();
    expect(call.args).toEqual(expect.arrayContaining(['--resume', 'sess-1']));
    expect(call.stdin).toBe('second question');
  });

  it('starts over with the whole problem when the session is gone', async () => {
    setReplies(replies, {
      '*': [{ stderr: 'No conversation found with session ID: sess-1\n', exit: 1 }, { stdout: result({ session_id: 'sess-2' }) }]
    });
    const out = await backend().turn(request({ entries: [user(1, 'old'), user(2, 'new')], session: { id: 'sess-1', lastSeq: 1 } }));
    expect(out.sessionId).toBe('sess-2');
    const [, retry] = calls();
    expect(retry.args).toContain('--session-id');
    expect(retry.stdin).toBe('old\n\nnew');
  });

  it('says how to sign in when Claude Code is signed out', async () => {
    setReplies(replies, { '*': [{ stdout: JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' }), exit: 1 }] });
    await expect(backend().turn(request())).rejects.toThrow(/not signed in — run `claude auth login`/);
  });

  it('says so when Claude Code is not installed', async () => {
    await expect(backend().turn(request({ cliPath: join(dir, 'nope') }))).rejects.toThrow(/not found at/);
  });
});

describe('claudeCliStatus', () => {
  it('reports version and sign-in', async () => {
    setReplies(replies, {
      '--version': [{ stdout: '2.1.296 (Claude Code)\n' }],
      'auth status': [{ stdout: '{"loggedIn": true, "authMethod": "claude.ai"}' }]
    });
    expect(await claudeCliStatus(bin)).toEqual({
      installed: true,
      path: bin,
      version: '2.1.296 (Claude Code)',
      loggedIn: true,
      detail: 'signed in (claude.ai)'
    });
  });

  it('reports a signed-out CLI', async () => {
    setReplies(replies, { 'auth status': [{ stdout: '{"loggedIn": false}', exit: 1 }] });
    expect(await claudeCliStatus(bin)).toMatchObject({ installed: true, loggedIn: false });
  });

  it('reports a missing CLI', async () => {
    expect(await claudeCliStatus(join(dir, 'nope'))).toMatchObject({ installed: false, loggedIn: false });
  });
});
