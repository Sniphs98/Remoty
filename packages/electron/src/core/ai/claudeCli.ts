import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AiBackend, TurnRequest, TurnResult } from './backend.js';
import { answerCalls, answerText, childEnv, CliNotFoundError, type CliStatus, findExecutable, lastLine, runProcess } from './cliProcess.js';
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
    '--output-format',
    'json',
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

/** The result object among what the CLI printed (one JSON document). */
export function parseClaudeResult(stdout: string): ClaudeResult | undefined {
  const text = stdout.trim();
  for (const candidate of [text, ...text.split('\n').reverse()]) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as ClaudeResult;
    } catch {
      // Not this one.
    }
  }
  return undefined;
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
  async function run(req: TurnRequest, path: string, resume: boolean): Promise<{ code: number | null; result?: ClaudeResult; stderr: string; sessionId: string }> {
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
        env: childEnv(path)
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
      let out = await run(req, path, Boolean(req.session));
      // The session is gone (Claude Code's history cleared, another computer): start a
      // new one with the whole problem.
      if (req.session && !out.result && /no conversation found/i.test(out.stderr)) out = await run(req, path, false);

      const r = out.result;
      if (!r || r.is_error || out.code !== 0) {
        const message = (r?.result && r.result.trim()) || lastLine(out.stderr) || r?.subtype || `exit code ${out.code}`;
        throw new Error(friendlyError(message));
      }
      const answer = r.structured_output;
      const notice = answer === undefined ? 'The answer did not come back in the expected format.' : undefined;
      const text = answer === undefined ? (r.result ?? '') : answerText(answer);
      req.onText(text);
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
