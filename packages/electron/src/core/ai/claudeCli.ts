import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AiBackend, TurnRequest, TurnResult } from './backend.js';
import {
  answerCalls,
  answerText,
  childEnv,
  CliNotFoundError,
  type CliStatus,
  findExecutable,
  lastLine,
  lineSplitter,
  partialStringField,
  runProcess
} from './cliProcess.js';
import { cliPrompt } from './history.js';
import { CLI_ANSWER_SCHEMA, cliSystemPrompt } from './prompt.js';

/**
 * Claude through the Claude Code CLI (`claude -p`), signed in with the user's Pro/Max
 * subscription. Remoty runs the CLI as installed and reads its JSON result; Claude Code
 * itself gets no tools, MCP servers, settings or slash commands here — it only answers,
 * in Remoty's answer format (`CLI_ANSWER_SCHEMA`). Each problem is one Claude Code
 * session, so a follow-up sends only what is new.
 */

export const CLAUDE_CLI_SIGN_IN = 'claude auth login';

interface ClaudeResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  structured_output?: unknown;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  modelUsage?: Record<string, unknown>;
}

export function claudeExecutable(cliPath?: string): string {
  const path = findExecutable('claude', cliPath);
  if (!path) {
    throw new CliNotFoundError(
      cliPath?.trim()
        ? `Claude Code was not found at ${cliPath.trim()} — check the path in Settings → AI.`
        : 'Claude Code is not installed (or not on PATH). Install it from https://claude.com/claude-code, then sign in.'
    );
  }
  return path;
}

/** The arguments for one `claude -p` run. */
export function claudeArgs(opts: { model: string; systemFile: string; sessionId: string; resume: boolean }): string[] {
  return [
    '-p',
    // One event per line, with the answer's JSON as it is written, so its text can be
    // shown while Claude is still writing it.
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--json-schema',
    JSON.stringify(CLI_ANSWER_SCHEMA),
    // Nothing to run, read or fetch: the user runs the commands, in their terminal.
    '--tools',
    '',
    '--disallowedTools',
    'mcp__*',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--setting-sources',
    '',
    '--permission-mode',
    'dontAsk',
    '--disable-slash-commands',
    '--no-chrome',
    ...(opts.model ? ['--model', opts.model] : []),
    '--system-prompt-file',
    opts.systemFile,
    ...(opts.resume ? ['--resume', opts.sessionId] : ['--session-id', opts.sessionId])
  ];
}

function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The result object among what the CLI printed: the `result` event of a stream, or
 *  the one JSON document it printed. */
export function parseClaudeResult(stdout: string): ClaudeResult | undefined {
  const lines = stdout.trim().split('\n').reverse();
  for (const line of lines) {
    const event = jsonObject(line);
    if (event?.type === 'result') return event as ClaudeResult;
  }
  return jsonObject(stdout.trim()) ?? lines.map(jsonObject).find(Boolean);
}

/**
 * Follows the stream's partial answer and reports its `text` as it grows. Claude Code
 * hands the structured answer over as a tool call whose input arrives in pieces.
 */
export function answerStreamer(onText: (delta: string) => void): { onLine: (line: string) => void; shown: () => string } {
  let json = '';
  let shown = '';
  return {
    shown: () => shown,
    onLine(line) {
      const event = jsonObject(line);
      if (event?.type !== 'stream_event') return;
      const e = event.event as { type?: string; content_block?: { type?: string }; delta?: { type?: string; partial_json?: string } } | undefined;
      if (e?.type === 'content_block_start' && e.content_block?.type === 'tool_use') json = '';
      else if (e?.type === 'content_block_delta' && e.delta?.type === 'input_json_delta') {
        json += e.delta.partial_json ?? '';
        const text = partialStringField(json, 'text');
        // A second try at the answer starts over: only text past what is shown counts.
        if (text && text.length > shown.length && text.startsWith(shown)) {
          onText(text.slice(shown.length));
          shown = text;
        }
      }
    }
  };
}

function friendlyError(message: string): string {
  if (/not logged in|\/login|invalid api key|oauth token|authenticat/i.test(message)) {
    return `Claude Code is not signed in — run \`${CLAUDE_CLI_SIGN_IN}\` in a terminal, then try again.`;
  }
  if (/usage limit|rate limit|limit reached|resets? at/i.test(message)) {
    return `Claude Code says: ${message}`;
  }
  return `Claude Code failed: ${message}`;
}

export function claudeCliBackend(workDir: () => string): AiBackend {
  async function run(
    req: TurnRequest,
    path: string,
    resume: boolean,
    streamer: ReturnType<typeof answerStreamer>
  ): Promise<{ code: number | null; result?: ClaudeResult; stderr: string; sessionId: string }> {
    const dir = workDir();
    await mkdir(dir, { recursive: true });
    const systemFile = join(dir, `system-${randomUUID()}.md`);
    await writeFile(systemFile, cliSystemPrompt(req.system), { encoding: 'utf-8', mode: 0o600 });
    const sessionId = resume && req.session ? req.session.id : randomUUID();
    try {
      const out = await runProcess(path, claudeArgs({ model: req.model, systemFile, sessionId, resume }), {
        stdin: cliPrompt(req.entries, req.commands, resume ? req.session?.lastSeq : 0),
        cwd: dir,
        signal: req.signal,
        env: childEnv(path),
        onStdout: lineSplitter(streamer.onLine)
      });
      return { code: out.code, result: parseClaudeResult(out.stdout), stderr: out.stderr, sessionId };
    } finally {
      await rm(systemFile, { force: true });
    }
  }

  return {
    id: 'claude-cli',

    async turn(req: TurnRequest): Promise<TurnResult> {
      const path = claudeExecutable(req.cliPath);
      const streamer = answerStreamer(req.onText);
      let out = await run(req, path, Boolean(req.session), streamer);
      // The session is gone (Claude Code's history cleared, another computer): start a
      // new one with the whole problem.
      if (req.session && !out.result && /no conversation found/i.test(out.stderr)) out = await run(req, path, false, streamer);

      const r = out.result;
      if (!r || r.is_error || out.code !== 0) {
        const message = (r?.result && r.result.trim()) || lastLine(out.stderr) || r?.subtype || `exit code ${out.code}`;
        throw new Error(friendlyError(message));
      }
      const answer = r.structured_output;
      const notice = answer === undefined ? 'The answer did not come back in the expected format.' : undefined;
      const text = answer === undefined ? (r.result ?? '') : answerText(answer);
      // Whatever the stream has not shown yet.
      const shown = streamer.shown();
      if (text.startsWith(shown) && text.length > shown.length) req.onText(text.slice(shown.length));
      const u = r.usage ?? {};
      return {
        payload: { sessionId: r.session_id ?? out.sessionId, answer: answer ?? null },
        text,
        calls: answerCalls(answer),
        notice,
        usage: {
          input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          output: u.output_tokens ?? 0
        },
        sessionId: r.session_id ?? out.sessionId,
        model: Object.keys(r.modelUsage ?? {})[0]
      };
    },

    async check(_apiKey: string, _model: string, cliPath?: string): Promise<void> {
      const status = await claudeCliStatus(cliPath);
      if (!status.loggedIn) throw new Error(`Claude Code is not signed in — run \`${CLAUDE_CLI_SIGN_IN}\` in a terminal.`);
    }
  };
}

export async function claudeCliStatus(cliPath?: string): Promise<CliStatus> {
  let path: string;
  try {
    path = claudeExecutable(cliPath);
  } catch (err) {
    return { installed: false, loggedIn: false, detail: (err as Error).message };
  }
  const env = childEnv(path);
  const version = await runProcess(path, ['--version'], { env }).catch(() => undefined);
  const auth = await runProcess(path, ['auth', 'status', '--json'], { env }).catch((err: Error) => ({ code: -1, stdout: '', stderr: err.message }));
  const parsed = parseClaudeResult(auth.stdout) as { loggedIn?: boolean; authMethod?: string } | undefined;
  const loggedIn = auth.code === 0 && parsed?.loggedIn !== false;
  return {
    installed: true,
    path,
    version: version?.stdout.trim().split('\n')[0] || undefined,
    loggedIn,
    detail: loggedIn ? (parsed?.authMethod ? `signed in (${parsed.authMethod})` : 'signed in') : lastLine(auth.stderr) || 'not signed in'
  };
}
