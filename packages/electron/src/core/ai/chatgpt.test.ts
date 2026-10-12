import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TurnRequest } from './backend';
import { chatgptBackend } from './chatgpt';
import { ChatgptCredentials, type ChatgptLogin } from './chatgptAuth';

/** A stand-in for ChatGPT's Responses endpoint: answers each request with the next
 *  status, a 200 streaming a short answer with one proposed command. */
let server: Server;
let baseURL: string;
let statuses: number[];
let seen: { url?: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[];
/** What the next 200 streams. */
let next: () => string;

const sse = (events: [string, unknown][]): string => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');

function answer(): string {
  const msg = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Disk?', annotations: [] }] };
  const fc = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'propose_command', arguments: '{"command":"df -h","explanation":"x","risk":"safe"}', status: 'completed' };
  const resp = (status: string, output: unknown[]) => ({ id: 'r1', object: 'response', created_at: 1, status, model: 'gpt-5.5', output, usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 }, parallel_tool_calls: true, tools: [] });
  return sse([
    ['response.created', { type: 'response.created', sequence_number: 0, response: resp('in_progress', []) }],
    ['response.output_item.added', { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...msg, status: 'in_progress', content: [] } }],
    ['response.content_part.added', { type: 'response.content_part.added', sequence_number: 2, item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }],
    ['response.output_text.delta', { type: 'response.output_text.delta', sequence_number: 3, item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Disk?', logprobs: [] }],
    ['response.output_text.done', { type: 'response.output_text.done', sequence_number: 4, item_id: 'msg_1', output_index: 0, content_index: 0, text: 'Disk?', logprobs: [] }],
    ['response.content_part.done', { type: 'response.content_part.done', sequence_number: 5, item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: 'Disk?', annotations: [] } }],
    ['response.output_item.done', { type: 'response.output_item.done', sequence_number: 6, output_index: 0, item: msg }],
    ['response.output_item.added', { type: 'response.output_item.added', sequence_number: 7, output_index: 1, item: { ...fc, arguments: '', status: 'in_progress' } }],
    ['response.function_call_arguments.done', { type: 'response.function_call_arguments.done', sequence_number: 8, item_id: 'fc_1', output_index: 1, arguments: fc.arguments, name: 'propose_command' }],
    ['response.output_item.done', { type: 'response.output_item.done', sequence_number: 9, output_index: 1, item: fc }],
    ['response.completed', { type: 'response.completed', sequence_number: 10, response: resp('completed', [msg, fc]) }]
  ]);
}

beforeEach(async () => {
  statuses = [];
  seen = [];
  next = answer;
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
      const status = statuses.shift() ?? 200;
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `status ${status}` } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(next());
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/backend-api/codex`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

/** Credentials that hand out access tokens in order, counting refreshes. */
function credentials(tokens: string[]): ChatgptCredentials & { refreshes: number } {
  const creds = new ChatgptCredentials({ load: async () => undefined, save: async (_l: ChatgptLogin | undefined) => {} }) as ChatgptCredentials & {
    refreshes: number;
  };
  creds.refreshes = 0;
  creds.get = async () => ({ accessToken: tokens[Math.min(creds.refreshes, tokens.length - 1)], accountId: 'acc-1' });
  const invalidate = creds.invalidate.bind(creds);
  creds.invalidate = () => {
    creds.refreshes++;
    invalidate();
  };
  return creds;
}

/** An answer with the command written into the text instead of called. */
function leakedAnswer(): string {
  const text = '{"command":"df -h","explanation":"x","risk":"safe"}Ich schaue zuerst nach.';
  const msg = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  const resp = (status: string, output: unknown[]) => ({ id: 'r1', object: 'response', created_at: 1, status, model: 'gpt-5.5', output, usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 }, parallel_tool_calls: true, tools: [] });
  return sse([
    ['response.created', { type: 'response.created', sequence_number: 0, response: resp('in_progress', []) }],
    ['response.output_item.added', { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...msg, status: 'in_progress', content: [] } }],
    ['response.content_part.added', { type: 'response.content_part.added', sequence_number: 2, item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }],
    ['response.output_text.delta', { type: 'response.output_text.delta', sequence_number: 3, item_id: 'msg_1', output_index: 0, content_index: 0, delta: text, logprobs: [] }],
    ['response.output_item.done', { type: 'response.output_item.done', sequence_number: 4, output_index: 0, item: msg }],
    ['response.completed', { type: 'response.completed', sequence_number: 5, response: resp('completed', [msg]) }]
  ]);
}

const request = (): TurnRequest => ({
  apiKey: '',
  model: 'gpt-5.5',
  system: 'SYSTEM',
  entries: [{ id: 'e1', problemId: 'p', seq: 1, createdAt: 0, kind: 'user', text: 'disk full?' }],
  commands: [],
  signal: new AbortController().signal,
  onText: () => {}
});

describe('chatgptBackend', () => {
  it('sends the turn to ChatGPT with the sign-in\'s token and account', async () => {
    const out = await chatgptBackend(credentials(['tok-1']), baseURL).turn(request());
    expect(out).toMatchObject({ text: 'Disk?', calls: [{ callId: 'call_1', input: { command: 'df -h' } }] });
    const [req] = seen;
    expect(req.url).toBe('/backend-api/codex/responses');
    expect(req.headers.authorization).toBe('Bearer tok-1');
    expect(req.headers['chatgpt-account-id']).toBe('acc-1');
    expect(req.body).toMatchObject({ model: 'gpt-5.5', instructions: 'SYSTEM', store: false, stream: true });
  });

  it('turns a command written into the text into a card', async () => {
    next = leakedAnswer;
    const out = await chatgptBackend(credentials(['tok-1']), baseURL).turn(request());
    expect(out.text).toBe('Ich schaue zuerst nach.');
    expect(out.calls).toEqual([{ callId: expect.stringMatching(/^call_/), input: { command: 'df -h', explanation: 'x', risk: 'safe' } }]);
    // Replayed with a call of its own, so the command's result has a call to answer.
    expect(out.payload).toEqual([
      expect.objectContaining({ type: 'message', content: [expect.objectContaining({ text: 'Ich schaue zuerst nach.' })] }),
      expect.objectContaining({ type: 'function_call', call_id: out.calls[0].callId, name: 'propose_command' })
    ]);
  });

  it('refreshes the token once when ChatGPT turns it down', async () => {
    statuses = [401];
    const creds = credentials(['stale', 'fresh']);
    await chatgptBackend(creds, baseURL).turn(request());
    expect(seen.map((s) => s.headers.authorization)).toEqual(['Bearer stale', 'Bearer fresh']);
  });

  it('asks to sign in again when the fresh token is turned down too', async () => {
    statuses = [401, 401];
    await expect(chatgptBackend(credentials(['a', 'b']), baseURL).turn(request())).rejects.toThrow(/sign in again/);
  });

  it('says when the plan\'s usage limit is reached', async () => {
    statuses = [429, 429, 429, 429];
    await expect(chatgptBackend(credentials(['a']), baseURL).turn(request())).rejects.toThrow(/usage limit/);
  });
});
