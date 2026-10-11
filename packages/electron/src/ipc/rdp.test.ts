import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ clipboard: {}, screen: {}, shell: {} }));

const { CLIPBOARD_CLEAR_MS, launchNotice, offerPasswordOnClipboard } = await import('./rdp.js');

/** Asynchronous like Electron's own clipboard. */
function fakeClipboard(): { writeText: (t: string) => Promise<void>; readText: () => Promise<string>; clear: () => void; text: string } {
  const board = {
    text: '',
    writeText: async (t: string) => void (board.text = t),
    readText: async () => board.text,
    clear: () => void (board.text = '')
  };
  return board;
}

describe('offerPasswordOnClipboard', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('puts the password on the clipboard and takes it off again', async () => {
    vi.useFakeTimers();
    const board = fakeClipboard();
    await offerPasswordOnClipboard('secret', board);
    expect(board.text).toBe('secret');
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS);
    expect(board.text).toBe('');
  });

  it('leaves the clipboard alone if something else was copied since', async () => {
    vi.useFakeTimers();
    const board = fakeClipboard();
    await offerPasswordOnClipboard('secret', board);
    await board.writeText('something the user copied');
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS);
    expect(board.text).toBe('something the user copied');
  });
});

describe('launchNotice', () => {
  it('says when Windows uses its own saved credentials, and how to use these instead', () => {
    const notice = launchNotice({ opened: 'mstsc', credential: 'kept-existing' });
    expect(notice).toContain('already has saved credentials');
    expect(notice).toContain('Windows Credential Manager');
  });

  it('warns when Windows has RDP credentials of its own beside the staged ones', () => {
    const notice = launchNotice({ opened: 'mstsc', credential: 'staged-beside-saved' });
    expect(notice).toContain('may sign in with those');
    expect(notice).toContain('enter the credentials here again');
  });

  it('says where the password went when it had to go on the clipboard', () => {
    expect(launchNotice({ opened: 'file' }, {}, true)).toContain('on the clipboard for 45 seconds');
  });

  it("says what to tick in Windows' prompt for .rdp files, which shares nothing by default", () => {
    expect(launchNotice({ opened: 'mstsc', redirectionPrompt: true }, { drives: true, clipboard: true })).toContain(
      'tick Drives and Clipboard in its security prompt'
    );
    expect(launchNotice({ opened: 'mstsc', redirectionPrompt: true }, { drives: true, clipboard: false })).toContain(
      'tick Drives in its security prompt'
    );
    expect(launchNotice({ opened: 'mstsc', redirectionPrompt: true }, { dynamicResolution: true, clipboard: true })).toContain(
      'click Connect there, and tick Clipboard to share it'
    );
    // Without drives there's nothing to tick: the clipboard off or sound elsewhere need no consent.
    expect(launchNotice({ opened: 'mstsc', redirectionPrompt: true }, { clipboard: false })).toBeUndefined();
  });

  it('has nothing to say about an ordinary launch', () => {
    expect(launchNotice({ opened: 'mstsc', credential: 'staged' })).toBeUndefined();
    expect(launchNotice({ opened: 'xfreerdp' })).toBeUndefined();
  });
});
