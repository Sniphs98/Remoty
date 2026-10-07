// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { defaultBookmarkPath, parseBookmarks, upsertBookmark, type SftpBookmark } from './sftpBookmarks';

const backend = { get: vi.fn(), set: vi.fn() };
vi.mock('$lib/ipc/settingsStore', () => ({ loadSettingsStore: vi.fn(async () => backend) }));

async function fresh() {
  vi.resetModules();
  return import('./sftpBookmarks');
}

const downloads: SftpBookmark = { id: 'a', name: 'Downloads', path: '/home/me/Downloads', isDefault: false };
const projects: SftpBookmark = { id: 'b', name: 'Projects', path: '/home/me/src', isDefault: true };

describe('parseBookmarks', () => {
  it('keeps well-formed entries and drops the rest', () => {
    expect(parseBookmarks([downloads, { id: 1 }, null, 'x'])).toEqual([downloads]);
  });

  it('reads the JSON localStorage mirror', () => {
    expect(parseBookmarks(JSON.stringify([downloads]))).toEqual([downloads]);
    expect(parseBookmarks('not json')).toBeUndefined();
  });

  it('keeps only the first default', () => {
    const parsed = parseBookmarks([projects, { ...downloads, isDefault: true }]);
    expect(parsed?.map((b) => b.isDefault)).toEqual([true, false]);
  });
});

describe('upsertBookmark', () => {
  it('appends a new bookmark and replaces one with the same id', () => {
    const list = upsertBookmark([downloads], projects);
    expect(list.map((b) => b.id)).toEqual(['a', 'b']);
    expect(upsertBookmark(list, { ...downloads, name: 'DL' })[0].name).toBe('DL');
  });

  it('a new default takes the flag from the old one', () => {
    const list = upsertBookmark([downloads, projects], { ...downloads, isDefault: true });
    expect(defaultBookmarkPath(list)).toBe(downloads.path);
    expect(list.filter((b) => b.isDefault)).toHaveLength(1);
  });
});

describe('sftpBookmarks', () => {
  beforeEach(() => {
    localStorage.clear();
    backend.get.mockReset();
    backend.set.mockReset().mockResolvedValue(undefined);
  });

  it('mirrors a save to localStorage and the settings store', async () => {
    const { sftpBookmarks } = await fresh();
    sftpBookmarks.save(downloads);
    expect(get(sftpBookmarks)).toEqual([downloads]);
    expect(JSON.parse(localStorage.getItem('remoty-sftp-bookmarks') ?? '[]')).toEqual([downloads]);
    await vi.waitFor(() => expect(backend.set).toHaveBeenCalledWith('sftpBookmarks', [downloads]));
  });

  it('removes by id', async () => {
    const { sftpBookmarks } = await fresh();
    sftpBookmarks.save(downloads);
    sftpBookmarks.save(projects);
    sftpBookmarks.remove('a');
    expect(get(sftpBookmarks)).toEqual([projects]);
  });

  it('hydrates from the settings store once', async () => {
    backend.get.mockResolvedValue([projects]);
    const { sftpBookmarks } = await fresh();
    await Promise.all([sftpBookmarks.hydrate(), sftpBookmarks.hydrate()]);
    expect(get(sftpBookmarks)).toEqual([projects]);
    expect(backend.get).toHaveBeenCalledTimes(1);
  });

  it('hydrate does not clobber a change the user already made', async () => {
    backend.get.mockResolvedValue([projects]);
    const { sftpBookmarks } = await fresh();
    sftpBookmarks.save(downloads);
    await sftpBookmarks.hydrate();
    expect(get(sftpBookmarks)).toEqual([downloads]);
  });
});
