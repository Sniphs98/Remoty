import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AiBackend, TurnRequest, TurnResult } from './backend.js';
import { answerCalls, answerText, childEnv, CliNotFoundError, type CliStatus, findExecutable, lastLine, runProcess } from './cliProcess.js';
import { cliPrompt } from './history.js';
import { CLI_ANSWER_SCHEMA, cliSystemPrompt } from './prompt.js';

/**
 * OpenAI models through the Codex CLI (`codex exec`), signed in with the user's ChatGPT
 * plan. Remoty runs the CLI as installed and reads its JSON events; Codex gets no shell,
 * browser, apps or plugins here and runs read-only in an empty directory — it only
 * answers, in Remoty's answer format (`CLI_ANSWER_SCHEMA`). Each problem is one Codex
 * thread, so a follow-up sends only what is new.
 */

export const CODEX_CLI_SIGN_IN = 'codex login';

/** Codex's own tools, off: commands run in the user's terminal, nowhere else. Set
 *  through `--config`, which Codex versions that lack one of them only warn about. */
const DISABLED_FEATURES = [
  'shell_tool',
  'unified_exec',
  'shell_snapshot',
  'apps',
  'plugins',
  'hooks',
  'browser_use',
  'browser_use_external',
  'in_app_browser',
  'computer_use',
  'image_generation',
  'view_image',
  'multi_agent',
  'memories',
  'tool_suggest',
  'skill_search'
];

export function codexExecutable(cliPath?: string): string {
  const path = findExecutable('codex', cliPath);
  if (!path) {
    throw new CliNotFoundError(
      cliPath?.trim()
        ? `Codex was not found at ${cliPath.trim()} — check the path in Settings → AI.`
        : 'The Codex CLI is not installed (or not on PATH). Install it with `npm install -g @openai/codex`, then sign in.'
    );
  }
  return path;
}

/** The arguments for one `codex exec` run; the prompt goes to stdin. */
export function codexArgs(opts: { model: string; schemaFile: string; dir: string; threadId?: string }): string[] {
  return [
    'exec',
    '--json',
    '--ignore-user-config',
    '--ignore-rules',
    ...DISABLED_FEATURES.flatMap((f) => ['--config', `features.${f}=false`]),
    '--config',
    'web_search="disabled"',
    '--config',
    'approval_policy="never"',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--cd',
    opts.dir,
    '--output-schema',
    opts.schemaFile,
    ...(opts.model ? ['--model', opts.model] : []),
    ...(opts.threadId ? ['resume', opts.threadId] : []),
    '-'
  ];
}

interface CodexEvents {
  threadId?: string;
  message?: string;
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  failure?: string;
  lastError?: string;
}

/** What a run printed, from its JSONL events. */
export function parseCodexEvents(stdout: string): CodexEvents {
  const out: CodexEvents = {};
  for (const line of stdout.split('\n')) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') out.threadId = event.thread_id;
    else if (event.type === 'item.completed') {
      const item = event.item as { type?: string; text?: string; message?: string } | undefined;
      if (item?.type === 'agent_message' && typeof item.text === 'string') out.message = item.text;
    } else if (event.type === 'turn.completed') out.usage = event.usage as CodexEvents['usage'];
    else if (event.type === 'turn.failed') {
      const error = event.error as { message?: string } | undefined;
      out.failure = error?.message ?? 'the turn failed';
    } else if (event.type === 'error' && typeof event.message === 'string') out.lastError = event.message;
  }
  return out;
}

function friendlyError(message: string): string {
  if (/not logged in|unauthorized|\b401\b|log ?in again|authenticat/i.test(message)) {
    return `Codex is not signed in — run \`${CODEX_CLI_SIGN_IN}\` in a terminal, then try again.`;
  }
  if (/unexpected argument|unrecognized|unknown (option|flag)/i.test(message)) {
    return `This Codex CLI is too old for Remoty — update it (\`npm install -g @openai/codex\`). Codex said: ${message}`;
  }
  return `Codex failed: ${message}`;
}

export function codexCliBackend(workDir: () => string): AiBackend {
  async function run(req: TurnRequest, path: string, resume: boolean): Promise<{ code: number | null; events: CodexEvents; stderr: string }> {
    const dir = workDir();
    await mkdir(dir, { recursive: true });
    const schemaFile = join(dir, 'answer-schema.json');
    await writeFile(schemaFile, JSON.stringify(CLI_ANSWER_SCHEMA), 'utf-8');
    const transcript = cliPrompt(req.entries, req.commands, resume ? req.session?.lastSeq : 0);
    // `codex exec` has no system prompt of its own: a new thread starts with it.
    const prompt = resume ? transcript : `${cliSystemPrompt(req.system)}\n\n---\n\n${transcript}`;
    const out = await runProcess(path, codexArgs({ model: req.model, schemaFile, dir, threadId: resume ? req.session?.id : undefined }), {
      stdin: prompt,
      cwd: dir,
      signal: req.signal,
      env: childEnv(path)
    });
    return { code: out.code, events: parseCodexEvents(out.stdout), stderr: out.stderr };
  }

  return {
    id: 'codex-cli',

    async turn(req: TurnRequest): Promise<TurnResult> {
      const path = codexExecutable(req.cliPath);
      let out = await run(req, path, Boolean(req.session));
      // The thread is gone (Codex's history cleared, another computer): start a new one
      // with the whole problem.
      if (req.session && out.events.message === undefined && /no (rollout|session|thread|conversation) found|not found/i.test(out.events.failure ?? out.stderr)) {
        out = await run(req, path, false);
      }

      const { events } = out;
      if (events.message === undefined || events.failure || out.code !== 0) {
        throw new Error(friendlyError(events.failure ?? events.lastError ?? (lastLine(out.stderr) || `exit code ${out.code}`)));
      }
      let answer: unknown;
      try {
        answer = JSON.parse(events.message);
      } catch {
        answer = undefined;
      }
      const notice = answer === undefined ? 'The answer did not come back in the expected format.' : undefined;
      const text = answer === undefined ? events.message : answerText(answer);
      req.onText(text);
      return {
        payload: { sessionId: events.threadId ?? null, answer: answer ?? null },
        text,
        calls: answerCalls(answer),
        notice,
        usage: { input: events.usage?.input_tokens ?? 0, output: events.usage?.output_tokens ?? 0 },
        sessionId: events.threadId ?? req.session?.id
      };
    },

    async check(_apiKey: string, _model: string, cliPath?: string): Promise<void> {
      const status = await codexCliStatus(cliPath);
      if (!status.loggedIn) throw new Error(`Codex is not signed in — run \`${CODEX_CLI_SIGN_IN}\` in a terminal.`);
    }
  };
}

export async function codexCliStatus(cliPath?: string): Promise<CliStatus> {
  let path: string;
  try {
    path = codexExecutable(cliPath);
  } catch (err) {
    return { installed: false, loggedIn: false, detail: (err as Error).message };
  }
  const env = childEnv(path);
  const version = await runProcess(path, ['--version'], { env }).catch(() => undefined);
  const login = await runProcess(path, ['login', 'status'], { env }).catch((err: Error) => ({ code: -1, stdout: '', stderr: err.message }));
  const said = lastLine(`${login.stdout}\n${login.stderr}`);
  const loggedIn = login.code === 0 && !/not logged in/i.test(said);
  return {
    installed: true,
    path,
    version: version?.stdout.trim().split('\n')[0] || undefined,
    loggedIn,
    detail: said || (loggedIn ? 'signed in' : 'not signed in')
  };
}
