import { writable } from 'svelte/store';

// Shortcuts to folders on this machine, shown as badges above the SFTP tab's local pane:
// a click there navigates the local side to the folder. At most one is the default, which
// every SFTP tab opens its local pane in instead of the home directory. Local paths, so
// they belong to this machine rather than to any host — one list for every SFTP tab.
// Persisted like the other UI prefs (see `stores/terminalPrefs.ts`): canonical copy in the
// settings store, mirrored to localStorage so a tab opened before `hydrate()` resolves
// already has them.

export interface SftpBookmark {
  id: string;
  name: string;
  path: string;
  isDefault: boolean;
}

const LOCAL_KEY = 'remoty-sftp-bookmarks';
const STORE_KEY = 'sftpBookmarks';

/** Keeps the well-formed entries of a stored value, and at most one default (the first). */
export function parseBookmarks(raw: unknown): SftpBookmark[] | undefined {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(raw)) return undefined;
  let sawDefault = false;
  const out: SftpBookmark[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { id, name, path, isDefault } = item as Record<string, unknown>;
    if (typeof id !== 'string' || typeof name !== 'string' || typeof path !== 'string') continue;
    const dflt = isDefault === true && !sawDefault;
    if (dflt) sawDefault = true;
    out.push({ id, name, path, isDefault: dflt });
  }
  return out;
}

/** The folder a new SFTP tab's local pane should open in, if a bookmark is the default. */
export function defaultBookmarkPath(list: SftpBookmark[]): string | undefined {
  return list.find((b) => b.isDefault)?.path;
}

/** `list` with `bookmark` added (new id) or replaced (same id). Marking it the default
 *  clears the flag everywhere else, so there's only ever one. */
export function upsertBookmark(list: SftpBookmark[], bookmark: SftpBookmark): SftpBookmark[] {
  const others = bookmark.isDefault ? list.map((b) => ({ ...b, isDefault: false })) : list;
  const at = others.findIndex((b) => b.id === bookmark.id);
  return at === -1 ? [...others, bookmark] : others.map((b, i) => (i === at ? bookmark : b));
}

async function settingsStore() {
  const { loadSettingsStore } = await import('$lib/ipc/settingsStore');
  return loadSettingsStore();
}

function createBookmarks() {
  function mirrored(): SftpBookmark[] {
    try {
      return parseBookmarks(localStorage.getItem(LOCAL_KEY)) ?? [];
    } catch {
      return [];
    }
  }

  const { subscribe, set: setStore } = writable<SftpBookmark[]>(mirrored());
  let current: SftpBookmark[] = [];
  subscribe((value) => (current = value));
  let interacted = false;
  let hydrating: Promise<void> | undefined;

  function apply(list: SftpBookmark[], user: boolean): void {
    setStore(list);
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(list));
    } catch {
      // localStorage unavailable (hardened webview): the store copy is canonical.
    }
    if (user) {
      interacted = true;
      void settingsStore()
        .then((store) => store.set(STORE_KEY, list))
        .catch(() => {
          // Not under Electron (tests, vite preview): the mirror suffices.
        });
    }
  }

  return {
    subscribe,
    /** Adds a new bookmark or replaces the one with the same id. */
    save: (bookmark: SftpBookmark) => apply(upsertBookmark(current, bookmark), true),
    remove: (id: string) => apply(current.filter((b) => b.id !== id), true),
    /** Reconciles with the settings store. Runs once; later calls await the same run, so
     *  an SFTP tab can wait on it before picking its default folder. */
    hydrate(): Promise<void> {
      hydrating ??= (async () => {
        try {
          const store = await settingsStore();
          const saved = parseBookmarks(await store.get<unknown>(STORE_KEY));
          if (!interacted && saved !== undefined) apply(saved, false);
        } catch {
          // Store unreachable: keep the mirrored value.
        }
      })();
      return hydrating;
    }
  };
}

export const sftpBookmarks = createBookmarks();

export function newBookmarkId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
