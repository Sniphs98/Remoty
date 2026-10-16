import { describe, expect, it } from 'vitest';
import { canCut, pasteLabel, pastePlan, type FileClip } from './sftpClipboard';

const file = { path: '/srv/app.log', name: 'app.log', isDir: false };
const dir = { path: '/srv/logs', name: 'logs', isDir: true };
const clip = (mode: 'copy' | 'cut', onServer: boolean, entries = [file]): FileClip => ({ mode, onServer, entries });

describe('pastePlan', () => {
  it('on the server: cut moves, copy copies — folders too', () => {
    expect(pastePlan(clip('cut', true, [dir]), true)).toEqual({ kind: 'relocate', mode: 'move' });
    expect(pastePlan(clip('copy', true, [file, dir]), true)).toEqual({ kind: 'relocate', mode: 'copy' });
  });

  it('this computer to the server uploads; the server to this computer downloads a copy', () => {
    expect(pastePlan(clip('copy', false), true)).toEqual({ kind: 'upload' });
    expect(pastePlan(clip('copy', true), false)).toEqual({ kind: 'download' });
  });

  it("doesn't move off the server, nor paste folders across, nor from this computer to itself", () => {
    expect(pastePlan(clip('cut', true), false).kind).toBe('none');
    expect(pastePlan(clip('copy', true, [dir]), false).kind).toBe('none');
    expect(pastePlan(clip('copy', false), false).kind).toBe('none');
    expect(pastePlan(null, true).kind).toBe('none');
  });
});

describe('pasteLabel and canCut', () => {
  it('says how many and where', () => {
    expect(pasteLabel(clip('copy', true), { kind: 'relocate', mode: 'copy' })).toBe('Paste');
    expect(pasteLabel(clip('copy', true, [file, dir]), { kind: 'relocate', mode: 'copy' }, 'backup')).toBe('Paste 2 items into backup');
  });

  it('a cut starts only on the server', () => {
    expect(canCut(true)).toBe(true);
    expect(canCut(false)).toBe(false);
  });
});
