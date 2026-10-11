// Runs a command the AI proposed in a terminal tab and captures what it printed, so the
// output can go back to the model without anyone copying it (docs/concepts/
// ai-integration.md, "Ausgabe zurück in den Chat"). There is no shell integration yet,
// so where the output ends is a guess from the screen: the shell showed its prompt again
// and the terminal went quiet — or it stayed quiet long enough, or the user said so.

/** The few xterm.js members the capture needs (a test passes a stand-in). */
export interface CaptureTerminal {
  buffer: {
    active: {
      type: 'normal' | 'alternate';
      baseY: number;
      cursorY: number;
      getLine(y: number): { isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined;
    };
  };
  registerMarker(cursorYOffset?: number): { line: number; isDisposed: boolean; dispose(): void } | undefined;
  onWriteParsed(listener: () => void): { dispose(): void };
}

export interface CaptureResult {
  output: string;
  /** What the model should know about how the capture ended. */
  note?: string;
}

export interface CaptureOptions {
  /** Types the command into the shell, Enter included. */
  send: (line: string) => void;
  signal?: AbortSignal;
  /** Quiet time after the prompt is back. */
  promptQuietMs?: number;
  /** Quiet time without a prompt after which the capture stops anyway. */
  quietMs?: number;
  maxMs?: number;
  pollMs?: number;
  now?: () => number;
}

/** The logical lines from absolute line `from` to `to` (inclusive), with soft-wrapped
 *  rows joined back into one. */
export function readLines(term: CaptureTerminal, from: number, to: number): string[] {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let y = Math.max(0, from); y <= to; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines;
}

/** Whether `line` looks like the shell's prompt, given the prompt seen before the
 *  command (`user@web-1:~$`, `PS C:\>`). The directory part can have changed, so the
 *  prompt counts as back when the line ends with the same marker character. */
export function isPromptLine(line: string, prompt: string): boolean {
  const current = line.trimEnd();
  const before = prompt.trimEnd();
  if (!current || !before) return false;
  if (current === before) return true;
  const marker = before[before.length - 1];
  return /[$#>%❯»:\]]/.test(marker) && current.endsWith(marker) && current.length <= Math.max(before.length * 3, 200);
}

/** The command's output from the captured lines: without the first line (prompt and
 *  command echo), a prompt at the end, and trailing blank lines. */
export function outputFromLines(lines: string[], prompt: string): string {
  const out = lines.slice(1);
  if (out.length && isPromptLine(out[out.length - 1], prompt)) out.pop();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join('\n');
}

/** Types `command` into the shell and resolves with its output once it seems done. */
export function runAndCapture(term: CaptureTerminal, command: string, options: CaptureOptions): Promise<CaptureResult> {
  const {
    send,
    signal,
    promptQuietMs = 700,
    quietMs = 10_000,
    maxMs = 5 * 60_000,
    pollMs = 150,
    now = Date.now
  } = options;
  const buf = (): CaptureTerminal['buffer']['active'] => term.buffer.active;
  if (buf().type === 'alternate') {
    return Promise.reject(new Error('A full-screen program is open in this terminal — close it first.'));
  }
  const startLine = buf().baseY + buf().cursorY;
  const prompt = readLines(term, startLine, startLine)[0] ?? '';
  const marker = term.registerMarker(0);
  const started = now();
  let lastWrite = started;
  const writes = term.onWriteParsed(() => (lastWrite = now()));

  return new Promise<CaptureResult>((resolve) => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const finish = (note?: string): void => {
      if (timer) clearInterval(timer);
      writes.dispose();
      signal?.removeEventListener('abort', onAbort);
      // The marker goes when its line scrolls out of the scrollback.
      const trimmedAway = !marker || marker.isDisposed;
      const from = trimmedAway ? 0 : marker.line;
      marker?.dispose();
      const output = outputFromLines(readLines(term, from, buf().baseY + buf().cursorY), prompt);
      const notes = [note, trimmedAway ? 'The beginning of the output scrolled out of the terminal.' : undefined].filter(Boolean);
      resolve({ output, ...(notes.length ? { note: notes.join(' ') } : {}) });
    };
    const onAbort = (): void => finish('The user stopped waiting; the command may still be running.');
    signal?.addEventListener('abort', onAbort);

    send(command);
    timer = setInterval(() => {
      const t = now();
      if (buf().type === 'alternate') {
        finish('A full-screen program opened; its screen is not part of the output.');
        return;
      }
      const cursorLine = buf().baseY + buf().cursorY;
      const current = readLines(term, cursorLine, cursorLine)[0] ?? '';
      const quiet = t - lastWrite;
      if (cursorLine > startLine && isPromptLine(current, prompt) && quiet >= promptQuietMs) finish();
      else if (quiet >= quietMs) finish('No prompt came back yet; the command may still be running or waiting for input.');
      else if (t - started >= maxMs) finish('Still running after 5 minutes; this is the output so far.');
    }, pollMs);
  });
}
