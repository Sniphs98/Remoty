import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import type { ProposedCall } from './backend.js';

/**
 * Running the AI CLIs the user installed and signed in to (Claude Code, Codex). Remoty
 * starts them as they are — never a modified copy — and only reads what they print.
 */

export class CliNotFoundError extends Error {}

/** Whether a CLI provider can be used: installed, and signed in. */
export interface CliStatus {
  installed: boolean;
  path?: string;
  version?: string;
  loggedIn: boolean;
  /** What the CLI said about its sign-in, or why it could not be checked. */
  detail?: string;
}

/** Where the installers put the CLIs, for an app started from the desktop: it gets
 *  the system's PATH, not the one the user's shell profile sets up. */
export function installDirs(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  if (platform === 'win32') {
    return [join(home, '.local', 'bin'), ...(env.APPDATA ? [join(env.APPDATA, 'npm')] : [])];
  }
  return [
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ];
}

/** Where `name` lives: the configured path when there is one, else the first match on
 *  PATH (with Windows' executable extensions), else in a usual install directory. */
export function findExecutable(
  name: string,
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (override?.trim()) {
    const path = override.trim();
    return existsSync(path) ? path : undefined;
  }
  const extensions = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  const dirs = [...pathDirs(env, platform), ...installDirs(env, platform)];
  for (const dir of dirs) {
    for (const ext of platform === 'win32' ? [...extensions, ''] : extensions) {
      const candidate = join(dir, name + ext.toLowerCase());
      try {
        if (isAbsolute(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        // Not there.
      }
    }
  }
  return undefined;
}

function pathSeparator(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':';
}

function pathDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  return (env.PATH ?? env.Path ?? '').split(pathSeparator(platform)).filter(Boolean);
}

/** The environment to run `path` in: PATH also holds the program's own directory, so a
 *  script installed next to `node` finds it. */
export function childEnv(path: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const key = platform === 'win32' ? (Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path') : 'PATH';
  const dirs = [...pathDirs(env, platform)];
  const own = dirname(path);
  if (!dirs.includes(own)) dirs.push(own);
  return { ...env, [key]: dirs.join(pathSeparator(platform)) };
}

/** A `.cmd`/`.bat` file (npm's wrappers on Windows) runs through cmd.exe, so its
 *  arguments are quoted the way cmd.exe reads them back. */
function needsShell(path: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(path);
}

export function quoteForCmd(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"&|<>^()%!,;=]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `path` with `args`, `stdin` written and closed, and collects its output. */
export function runProcess(
  path: string,
  args: string[],
  options: {
    stdin?: string;
    cwd?: string;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    /** Each piece of output as it arrives (it is collected in `stdout` as well). */
    onStdout?: (chunk: string) => void;
  } = {}
): Promise<ProcessResult> {
  const platform = options.platform ?? process.platform;
  const shell = needsShell(path, platform);
  return new Promise((resolve, reject) => {
    const child = shell
      ? spawn([quoteForCmd(path), ...args.map(quoteForCmd)].join(' '), { shell: true, cwd: options.cwd, env: options.env, windowsHide: true })
      : spawn(path, args, { cwd: options.cwd, env: options.env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8').on('data', (d: string) => {
      stdout += d;
      options.onStdout?.(d);
    });
    child.stderr.setEncoding('utf-8').on('data', (d: string) => (stderr += d));
    const onAbort = (): void => {
      child.kill();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.once('error', (err) => {
      options.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.once('close', (code) => {
      options.signal?.removeEventListener('abort', onAbort);
      if (options.signal?.aborted) reject(new Error('stopped'));
      else resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {
      // The program may exit without reading its input; its exit code says why.
    });
    child.stdin.end(options.stdin ?? '');
  });
}

/** The commands in a CLI provider's structured answer, as calls the engine takes. */
export function answerCalls(answer: unknown): ProposedCall[] {
  const commands = (answer as { commands?: unknown } | undefined)?.commands;
  if (!Array.isArray(commands)) return [];
  return commands.map((input) => ({ callId: `cli-${randomUUID()}`, input }));
}

export function answerText(answer: unknown): string {
  const text = (answer as { text?: unknown } | undefined)?.text;
  return typeof text === 'string' ? text : '';
}

/** The last non-empty line of a CLI's error output, for the message the user sees. */
export function lastLine(text: string): string {
  return (
    text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? ''
  );
}

/** Splits a stream into whole lines, for a CLI that prints one JSON event per line. */
export function lineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let rest = '';
  return (chunk) => {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) onLine(line);
  };
}

const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/**
 * The value of the top-level string field `key` in a JSON object that is still being
 * written (`{"text":"Check the di`), as far as it has arrived — so an answer can be
 * shown while the model is still producing it. Undefined until the field starts.
 */
export function partialStringField(json: string, key: string): string | undefined {
  let depth = 0;
  let i = 0;
  const readString = (): { value: string; done: boolean } => {
    // At the opening quote.
    let value = '';
    i++;
    while (i < json.length) {
      const ch = json[i];
      if (ch === '"') {
        i++;
        return { value, done: true };
      }
      if (ch === '\\') {
        const next = json[i + 1];
        if (next === undefined) break;
        if (next === 'u') {
          const hex = json.slice(i + 2, i + 6);
          if (hex.length < 4) break;
          value += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else {
          value += ESCAPES[next] ?? next;
          i += 2;
        }
        continue;
      }
      value += ch;
      i++;
    }
    return { value, done: false };
  };
  while (i < json.length) {
    const ch = json[i];
    if (ch === '"') {
      const start = i;
      const { value, done } = readString();
      if (!done) return undefined;
      // A key at the top level: is it ours, and does its string value start?
      if (depth === 1 && value === key) {
        let j = i;
        while (j < json.length && /\s/.test(json[j])) j++;
        if (json[j] !== ':') continue;
        j++;
        while (j < json.length && /\s/.test(json[j])) j++;
        if (j >= json.length) return undefined;
        if (json[j] !== '"') return undefined;
        i = j;
        return readString().value;
      }
      if (i === start) i++;
      continue;
    }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    i++;
  }
  return undefined;
}
