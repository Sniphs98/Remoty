import { describe, expect, it } from 'vitest';
import { GhosttyTerminalAdapter, type Disposable, type GhosttyLike } from './terminalEngine';
import { runAndCapture } from './aiCapture';

/** A line-based stand-in for ghostty-web's Terminal: lines numbered from the top of the
 *  scrollback, `length` = scrollback + screen, `getViewportY()` = rows scrolled up, and
 *  a scrollback that drops its oldest lines past `maxLines`. */
class FakeGhostty implements GhosttyLike {
  readonly cols = 80;
  lines: string[];
  scrolledUp = 0;
  themes: unknown[] = [];
  renderer = { setTheme: (t: unknown) => void this.themes.push(t) };
  private dataListeners: Array<(d: string) => void> = [];

  constructor(
    readonly rows: number,
    private readonly maxLines = Infinity
  ) {
    this.lines = Array.from({ length: rows }, () => '');
  }

  private cursorRow = 0; // absolute
  readonly buffer = {
    active: {
      type: 'normal' as const,
      get cursorY(): number {
        return 0;
      },
      length: 0,
      getLine: (y: number) => {
        const text = this.lines[y];
        return text === undefined ? undefined : { isWrapped: false, translateToString: () => text };
      }
    }
  };

  private sync(): void {
    const self = this;
    Object.defineProperty(this.buffer.active, 'length', { get: () => self.lines.length, configurable: true });
    Object.defineProperty(this.buffer.active, 'cursorY', {
      get: () => self.cursorRow - (self.lines.length - self.rows),
      configurable: true
    });
  }

  getViewportY(): number {
    return this.scrolledUp;
  }

  write(data: Uint8Array | string): void {
    this.sync();
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    for (const ch of text) {
      if (ch === '\r') continue;
      if (ch === '\n') {
        if (this.cursorRow === this.lines.length - 1) {
          this.lines.push('');
          if (this.lines.length > this.maxLines) this.lines.shift();
          else this.cursorRow++;
        } else this.cursorRow++;
      } else this.lines[this.cursorRow] += ch;
    }
  }

  open(): void {
    this.sync();
  }
  paste(text: string): void {
    for (const l of this.dataListeners) l(text);
  }
  focus(): void {}
  hasSelection(): boolean {
    return false;
  }
  getSelection(): string {
    return '';
  }
  clearSelection(): void {}
  keyHandler?: (event: KeyboardEvent) => boolean;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.keyHandler = handler;
  }
  onData(listener: (d: string) => void): Disposable {
    this.dataListeners.push(listener);
    return { dispose: () => {} };
  }
  onScroll(): Disposable {
    return { dispose: () => {} };
  }
  onSelectionChange(): Disposable {
    return { dispose: () => {} };
  }
  dispose(): void {}
}

function setup(rows = 4, maxLines = Infinity) {
  const fake = new FakeGhostty(rows, maxLines);
  const term = new GhosttyTerminalAdapter(fake);
  term.open({} as HTMLElement);
  return { fake, term };
}

describe('GhosttyTerminalAdapter', () => {
  it('reports xterm-style absolute geometry once output scrolls into the scrollback', () => {
    const { term } = setup(4);
    term.write('a\nb\nc\nd\ne\nf');
    const buf = term.buffer.active;
    // 6 lines, 4 on screen: the screen starts at row 2, the cursor on its last row.
    expect(buf.baseY).toBe(2);
    expect(buf.cursorY).toBe(3);
    expect(buf.viewportY).toBe(2);
    expect(buf.getLine(buf.baseY + buf.cursorY)?.translateToString()).toBe('f');
  });

  it('moves viewportY up as the user scrolls back', () => {
    const { fake, term } = setup(4);
    term.write('1\n2\n3\n4\n5\n6\n7\n8');
    fake.scrolledUp = 3;
    expect(term.buffer.active.viewportY).toBe(1);
    fake.scrolledUp = 99;
    expect(term.buffer.active.viewportY).toBe(0);
  });

  it('fires onWriteParsed after each write and stops after dispose', () => {
    const { term } = setup();
    let calls = 0;
    const sub = term.onWriteParsed(() => calls++);
    term.write('x');
    term.write(new TextEncoder().encode('y'));
    sub.dispose();
    term.write('z');
    expect(calls).toBe(2);
  });

  it('keeps a marker on its row while the scrollback grows', () => {
    const { term } = setup(3);
    term.write('one\ntwo\n$ ');
    const marker = term.registerMarker(0)!;
    expect(term.buffer.active.getLine(marker.line)?.translateToString()).toBe('$ ');
    term.write('ls\nfile-a\nfile-b\nfile-c\n$ ');
    expect(marker.isDisposed).toBe(false);
    expect(term.buffer.active.getLine(marker.line)?.translateToString()).toBe('$ ls');
  });

  it('gives a marker up once the full scrollback drops lines off the top', () => {
    const { term } = setup(3, 5);
    term.write('1\n2\n3\n4\n$ ');
    const marker = term.registerMarker(0)!;
    expect(marker.isDisposed).toBe(false);
    term.write('a\nb\nc\n');
    expect(marker.isDisposed).toBe(true);
  });

  it('never fires onBinary (ghostty-web sends everything through onData)', () => {
    const { term } = setup();
    expect(() => term.onBinary().dispose()).not.toThrow();
  });

  it('turns xterm’s key-handler answer into ghostty-web’s (true = keep the key away)', () => {
    const { fake, term } = setup();
    term.attachCustomKeyEventHandler((e) => e.key !== 'c');
    expect(fake.keyHandler?.({ key: 'c' } as KeyboardEvent)).toBe(true);
    expect(fake.keyHandler?.({ key: 'x' } as KeyboardEvent)).toBe(false);
  });

  it('re-themes through the renderer', () => {
    const { fake, term } = setup();
    term.setTheme({ background: '#000000' });
    expect(fake.themes).toEqual([{ background: '#000000' }]);
  });

  it('lets the AI capture read a command’s output', async () => {
    const { term } = setup(5);
    term.write('user@web-1:~$ ');
    let clock = 0;
    const done = runAndCapture(term, 'ls', {
      send: () => term.write('ls\nfile-a\nfile-b\nuser@web-1:~$ '),
      now: () => clock,
      pollMs: 1,
      promptQuietMs: 0
    });
    clock = 1000;
    const result = await done;
    expect(result.output).toContain('file-a');
    expect(result.output).toContain('file-b');
    expect(result.note).toBeUndefined();
  });
});
