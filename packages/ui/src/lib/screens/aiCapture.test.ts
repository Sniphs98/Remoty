import { describe, expect, it, vi, afterEach } from 'vitest';
import { isPromptLine, outputFromLines, runAndCapture, type CaptureTerminal } from './aiCapture';

/** A terminal that is a list of lines, with the cursor on the last one. */
function fakeTerminal(initial: string[]) {
  const lines = initial.map((text) => ({ text, wrapped: false }));
  const writeListeners = new Set<() => void>();
  let alternate = false;
  const markers: { line: number; isDisposed: boolean; dispose(): void }[] = [];
  const term: CaptureTerminal = {
    buffer: {
      active: {
        get type() {
          return alternate ? ('alternate' as const) : ('normal' as const);
        },
        baseY: 0,
        get cursorY() {
          return lines.length - 1;
        },
        getLine: (y) => (lines[y] ? { isWrapped: lines[y].wrapped, translateToString: () => lines[y].text } : undefined)
      }
    },
    registerMarker: () => {
      const m = { line: lines.length - 1, isDisposed: false, dispose: () => (m.isDisposed = true) };
      markers.push(m);
      return m;
    },
    onWriteParsed: (l) => {
      writeListeners.add(l);
      return { dispose: () => writeListeners.delete(l) };
    }
  };
  return {
    term,
    /** Appends to the cursor line or adds lines, like output arriving. */
    print(text: string) {
      const [first, ...rest] = text.split('\n');
      lines[lines.length - 1].text += first;
      for (const r of rest) lines.push({ text: r, wrapped: false });
      writeListeners.forEach((l) => l());
    },
    wrap(text: string) {
      lines.push({ text, wrapped: true });
      writeListeners.forEach((l) => l());
    },
    setAlternate(on: boolean) {
      alternate = on;
    }
  };
}

afterEach(() => vi.useRealTimers());

describe('isPromptLine', () => {
  it('recognizes the same prompt, also in another directory', () => {
    expect(isPromptLine('me@web-1:~$ ', 'me@web-1:~$ ')).toBe(true);
    expect(isPromptLine('me@web-1:/etc/nginx$', 'me@web-1:~$ ')).toBe(true);
    expect(isPromptLine('PS C:\\Users\\me>', 'PS C:\\>')).toBe(true);
  });
  it('does not take output for a prompt', () => {
    expect(isPromptLine('Active: failed (Result: exit-code)', 'me@web-1:~$ ')).toBe(false);
    expect(isPromptLine('', 'me@web-1:~$ ')).toBe(false);
  });
});

describe('outputFromLines', () => {
  it('drops the command line, the new prompt and trailing blanks', () => {
    expect(outputFromLines(['me@h:~$ df -h', '/dev/sda1 40%', '', 'me@h:~$ '], 'me@h:~$ ')).toBe('/dev/sda1 40%');
  });
});

describe('runAndCapture', () => {
  it('captures the output once the prompt is back and the terminal is quiet', async () => {
    vi.useFakeTimers();
    const t = fakeTerminal(['banner', 'me@h:~$ ']);
    const sent: string[] = [];
    const done = runAndCapture(t.term, 'systemctl status nginx', {
      send: (line) => {
        sent.push(line);
        t.print('systemctl status nginx\n● nginx.service\n   Active: failed\n');
      },
      now: () => Date.now()
    });
    await vi.advanceTimersByTimeAsync(300);
    t.print('me@h:~$ ');
    await vi.advanceTimersByTimeAsync(1000);
    await expect(done).resolves.toEqual({ output: '● nginx.service\n   Active: failed' });
    expect(sent).toEqual(['systemctl status nginx']);
  });

  it('joins soft-wrapped rows', async () => {
    vi.useFakeTimers();
    const t = fakeTerminal(['me@h:~$ ']);
    const done = runAndCapture(t.term, 'cat long', {
      send: () => {
        t.print('cat long\naaaa');
        t.wrap('bbbb');
        t.print('\nme@h:~$ ');
      }
    });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(done).resolves.toEqual({ output: 'aaaabbbb' });
  });

  it('gives up waiting after a long quiet stretch without a prompt', async () => {
    vi.useFakeTimers();
    const t = fakeTerminal(['me@h:~$ ']);
    const done = runAndCapture(t.term, 'sleep 100', { send: () => t.print('sleep 100\n'), quietMs: 2000 });
    await vi.advanceTimersByTimeAsync(2500);
    const result = await done;
    expect(result.output).toBe('');
    expect(result.note).toMatch(/still be running/);
  });

  it('stops when the user stops waiting', async () => {
    vi.useFakeTimers();
    const t = fakeTerminal(['me@h:~$ ']);
    const controller = new AbortController();
    const done = runAndCapture(t.term, 'tail -f log', { send: () => t.print('tail -f log\nline 1'), signal: controller.signal });
    await vi.advanceTimersByTimeAsync(300);
    controller.abort();
    await expect(done).resolves.toMatchObject({ output: 'line 1', note: expect.stringMatching(/stopped waiting/) });
  });

  it('refuses while a full-screen program is open', async () => {
    const t = fakeTerminal(['me@h:~$ ']);
    t.setAlternate(true);
    await expect(runAndCapture(t.term, 'ls', { send: () => {} })).rejects.toThrow(/full-screen/);
  });
});
