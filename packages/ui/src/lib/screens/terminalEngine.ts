// Which library emulates and draws a terminal tab. xterm.js is the default and the one
// everything was built on; Ghostty (ghostty-web: Ghostty's VT core compiled to WASM,
// with an xterm.js-shaped API) is an experimental alternative, picked in Settings →
// Terminal. The pick applies to terminals opened after it changes — an open tab keeps
// the engine it started with, since its scrollback lives inside that engine.
//
// Both views (TerminalView, SftpTerminalDrawer) talk to `EngineTerminal`, the slice of
// xterm's API they use. xterm's `Terminal` already is one; Ghostty's is wrapped by
// `GhosttyTerminalAdapter`, which fills the few gaps:
//   - buffer geometry: ghostty-web numbers lines from the top of the scrollback but
//     reports `baseY`/`viewportY` as 0, so the fade and the AI capture (which want
//     xterm's absolute rows) get them derived from the buffer length and scroll offset;
//   - `registerMarker` / `onWriteParsed`, which the AI capture needs and ghostty-web
//     doesn't have;
//   - `onBinary`, which ghostty-web never fires (it sends everything through onData);
//   - the custom key handler, whose return value means the opposite in ghostty-web;
//   - re-theming: ghostty-web only takes a theme at construction, so a theme flip
//     repaints through its renderer, best effort.

import type { Readable } from 'svelte/store';
import type { ITheme } from '@xterm/xterm';
import { followGpuPref } from './terminalRenderer';

export type TerminalEngineId = 'xterm' | 'ghostty';

export interface Disposable {
  dispose(): void;
}

export interface EngineBufferLine {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
}

/** xterm's `IBuffer` geometry: absolute rows, 0 = the oldest scrollback line. */
export interface EngineBuffer {
  readonly type: 'normal' | 'alternate';
  /** The top visible row. */
  readonly viewportY: number;
  /** The top row of the live screen (everything above it is scrollback). */
  readonly baseY: number;
  /** The cursor's row within the live screen. */
  readonly cursorY: number;
  getLine(y: number): EngineBufferLine | undefined;
}

export interface EngineMarker {
  readonly line: number;
  readonly isDisposed: boolean;
  dispose(): void;
}

/** The slice of xterm.js's `Terminal` the terminal views use. */
export interface EngineTerminal {
  readonly cols: number;
  readonly rows: number;
  readonly buffer: { readonly active: EngineBuffer };
  open(parent: HTMLElement): void;
  write(data: Uint8Array | string, callback?: () => void): void;
  paste(text: string): void;
  focus(): void;
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  onData(listener: (data: string) => void): Disposable;
  onBinary(listener: (data: string) => void): Disposable;
  onScroll(listener: (ydisp: number) => void): Disposable;
  onSelectionChange(listener: () => void): Disposable;
  onWriteParsed(listener: () => void): Disposable;
  registerMarker(cursorYOffset?: number): EngineMarker | undefined;
  dispose(): void;
}

export interface TerminalOptions {
  fontFamily: string;
  fontSize: number;
  cursorBlink: boolean;
  scrollback: number;
  theme: ITheme;
}

/** A terminal plus the engine-specific pieces around it. */
export interface EngineHandle {
  engine: TerminalEngineId;
  term: EngineTerminal;
  /** Sizes the terminal to its container (call while it's visible). */
  fit(): void;
  /** Re-themes an open terminal. */
  setTheme(theme: ITheme): void;
  /** Keeps GPU drawing in line with the pref; returns a disposer. Call after `open()`. */
  followGpu(pref: Readable<boolean>): () => void;
}

export async function createTerminal(engine: TerminalEngineId, options: TerminalOptions): Promise<EngineHandle> {
  return engine === 'ghostty' ? createGhostty(options) : createXterm(options);
}

async function createXterm(options: TerminalOptions): Promise<EngineHandle> {
  const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
  const term = new Terminal(options);
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  return {
    engine: 'xterm',
    term,
    fit: () => fitAddon.fit(),
    setTheme: (theme) => {
      term.options.theme = theme;
    },
    followGpu: (pref) => followGpuPref(term, pref)
  };
}

/** Roughly what one scrollback line costs ghostty-web, measured at 120 columns. */
export const GHOSTTY_BYTES_PER_LINE = 2000;

// ghostty-web compiles its WASM once per page; every terminal shares it.
let ghosttyReady: Promise<typeof import('ghostty-web')> | undefined;
function loadGhostty(): Promise<typeof import('ghostty-web')> {
  ghosttyReady ??= import('ghostty-web').then(async (mod) => {
    await mod.init();
    return mod;
  });
  // A failed load (no WASM support) shouldn't stick: the next tab tries again.
  ghosttyReady.catch(() => (ghosttyReady = undefined));
  return ghosttyReady;
}

async function createGhostty(options: TerminalOptions): Promise<EngineHandle> {
  const { Terminal, FitAddon } = await loadGhostty();
  // ghostty-web's scrollback limit is in bytes of Ghostty's page memory, not lines (a
  // 120-column line takes about 1.6 KB), so the line count becomes a byte budget.
  const inner = new Terminal({ ...options, scrollback: options.scrollback * GHOSTTY_BYTES_PER_LINE });
  const fitAddon = new FitAddon();
  inner.loadAddon(fitAddon);
  const term = new GhosttyTerminalAdapter(inner as unknown as GhosttyLike);
  return {
    engine: 'ghostty',
    term,
    fit: () => fitAddon.fit(),
    setTheme: (theme) => term.setTheme(theme),
    // ghostty-web always draws on a 2D canvas; there is no WebGL path to switch.
    followGpu: () => () => {}
  };
}

/** The members of ghostty-web's `Terminal` the adapter relies on (a test passes a stand-in). */
export interface GhosttyLike {
  readonly cols: number;
  readonly rows: number;
  readonly buffer: {
    readonly active: {
      readonly type: 'normal' | 'alternate';
      readonly cursorY: number;
      readonly length: number;
      getLine(y: number): EngineBufferLine | undefined;
    };
  };
  /** Rows scrolled up from the bottom (0 = following output); may be fractional mid-animation. */
  getViewportY(): number;
  renderer?: { setTheme(theme: ITheme): void };
  open(parent: HTMLElement): void;
  write(data: Uint8Array | string, callback?: () => void): void;
  paste(text: string): void;
  focus(): void;
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  onData(listener: (data: string) => void): Disposable;
  onScroll(listener: (y: number) => void): Disposable;
  onSelectionChange(listener: () => void): Disposable;
  dispose(): void;
}

function hasNewline(data: Uint8Array | string): boolean {
  return typeof data === 'string' ? data.includes('\n') : data.includes(0x0a);
}

const NOOP: Disposable = { dispose: () => {} };

export class GhosttyTerminalAdapter implements EngineTerminal {
  private readonly writeListeners = new Set<() => void>();
  /** Bumped each time the scrollback is seen full (old lines dropped off the top, so
   *  absolute row numbers shifted). */
  private trims = 0;
  readonly buffer: { readonly active: EngineBuffer };

  constructor(private readonly inner: GhosttyLike) {
    const self = this;
    this.buffer = {
      get active(): EngineBuffer {
        return self.activeBuffer();
      }
    };
  }

  get cols(): number {
    return this.inner.cols;
  }

  get rows(): number {
    return this.inner.rows;
  }

  private activeBuffer(): EngineBuffer {
    const buf = this.inner.buffer.active;
    // ghostty-web: `length` is scrollback + screen for the normal buffer, the screen
    // alone for the alternate one; line 0 is the oldest scrollback line.
    const baseY = Math.max(0, buf.length - this.inner.rows);
    const viewportY = Math.max(0, baseY - Math.round(this.inner.getViewportY()));
    return {
      type: buf.type,
      baseY,
      viewportY,
      cursorY: buf.cursorY,
      getLine: (y) => buf.getLine(y)
    };
  }

  open(parent: HTMLElement): void {
    this.inner.open(parent);
  }

  write(data: Uint8Array | string, callback?: () => void): void {
    // ghostty-web parses synchronously inside write(); the callback waits for the next
    // frame, so "parsed" is now.
    const before = this.inner.buffer.active;
    const fullBefore = before.type === 'normal' && before.length > this.inner.rows;
    const lengthBefore = before.length;
    const atBottom = before.cursorY === this.inner.rows - 1;
    this.inner.write(data, callback);
    // A newline on the last row of a screen with scrollback that didn't grow the buffer:
    // the scrollback is at its limit and dropped its oldest line(s).
    if (fullBefore && atBottom && this.inner.buffer.active.length === lengthBefore && hasNewline(data)) this.trims++;
    for (const listener of this.writeListeners) listener();
  }

  paste(text: string): void {
    this.inner.paste(text);
  }

  focus(): void {
    this.inner.focus();
  }

  hasSelection(): boolean {
    return this.inner.hasSelection();
  }

  getSelection(): string {
    return this.inner.getSelection();
  }

  clearSelection(): void {
    this.inner.clearSelection();
  }

  /** xterm's handler returns false to keep a key from the terminal; ghostty-web's
   *  returns true for that. */
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.inner.attachCustomKeyEventHandler((event) => !handler(event));
  }

  onData(listener: (data: string) => void): Disposable {
    return this.inner.onData(listener);
  }

  /** ghostty-web sends mouse reports and the like through onData. */
  onBinary(): Disposable {
    return NOOP;
  }

  onScroll(listener: (ydisp: number) => void): Disposable {
    return this.inner.onScroll(listener);
  }

  onSelectionChange(listener: () => void): Disposable {
    return this.inner.onSelectionChange(listener);
  }

  onWriteParsed(listener: () => void): Disposable {
    this.writeListeners.add(listener);
    return { dispose: () => this.writeListeners.delete(listener) };
  }

  /** A row pinned by its absolute number. Once the scrollback drops lines off the top
   *  the numbers shift, so the marker reports itself disposed from then on (the AI
   *  capture then reads from the start of the scrollback and says so). */
  registerMarker(cursorYOffset = 0): EngineMarker | undefined {
    const self = this;
    const start = this.activeBuffer();
    const line = start.baseY + start.cursorY + cursorYOffset;
    const trimsAtStart = this.trims;
    let disposed = false;
    return {
      line,
      get isDisposed() {
        return disposed || self.trims !== trimsAtStart;
      },
      dispose: () => {
        disposed = true;
      }
    };
  }

  setTheme(theme: ITheme): void {
    // ghostty-web's own `options.theme` setter only warns after open(); its renderer
    // takes the new palette and background for everything it draws from now on.
    this.inner.renderer?.setTheme(theme);
  }

  dispose(): void {
    this.writeListeners.clear();
    this.inner.dispose();
  }
}
