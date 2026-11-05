import type { UpdateInfoDto } from '$lib/bindings';
import { theme, THEME_LOCAL_KEY } from './theme';
import { streamerMode, STREAMER_LOCAL_KEY } from './streamer';
import { refreshInterval, REFRESH_INTERVAL_LOCAL_KEY } from './settings';
import { terminalCopyOnSelect, terminalGpu, terminalRightClick } from './terminalPrefs';
import { settingsSection, SETTINGS_SECTION_LOCAL_KEY } from './settingsSection';
import { offerUpdate } from './update';

// Settings has a window of its own, so what it changes has to reach the main window
// (and the other way round: the sidebar's theme toggle, the AI panel opening Settings
// at the AI part). Every UI pref already mirrors itself to localStorage, which both
// windows share, and the browser tells the *other* windows when an entry changes —
// so each window adopts the new value without writing it back. An update found by
// "Check now" isn't a pref; it goes over a BroadcastChannel to the main window's banner.

const ADOPTERS: Record<string, (raw: string | null) => void> = {
  [THEME_LOCAL_KEY]: (raw) => theme.adopt(raw),
  [STREAMER_LOCAL_KEY]: (raw) => streamerMode.adopt(raw),
  [REFRESH_INTERVAL_LOCAL_KEY]: (raw) => refreshInterval.adopt(raw),
  [terminalRightClick.localKey]: (raw) => terminalRightClick.adopt(raw),
  [terminalCopyOnSelect.localKey]: (raw) => terminalCopyOnSelect.adopt(raw),
  [terminalGpu.localKey]: (raw) => terminalGpu.adopt(raw),
  [SETTINGS_SECTION_LOCAL_KEY]: (raw) => settingsSection.adopt(raw)
};

/** Applies a changed localStorage entry from another window; `false` when the key
 *  isn't one of the shared prefs. */
export function adoptStorageChange(key: string | null, newValue: string | null): boolean {
  const adopt = key ? ADOPTERS[key] : undefined;
  if (!adopt) return false;
  adopt(newValue);
  return true;
}

const CHANNEL = 'remoty-windows';
type Message = { kind: 'update-available'; info: UpdateInfoDto };

function channel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
  } catch {
    return null;
  }
}

/** Tell the main window an update was found, so its banner offers it. */
export function shareUpdate(info: UpdateInfoDto): void {
  const ch = channel();
  if (!ch) return;
  ch.postMessage({ kind: 'update-available', info } satisfies Message);
  ch.close();
}

/** Follow the prefs other windows change. With `updates`, also raise the update
 *  banner for an update another window found (the main window). Returns a disposer. */
export function followOtherWindows(opts: { updates: boolean }): () => void {
  const onStorage = (e: StorageEvent): void => {
    adoptStorageChange(e.key, e.newValue);
  };
  window.addEventListener('storage', onStorage);
  const ch = opts.updates ? channel() : null;
  if (ch) {
    ch.onmessage = (e: MessageEvent<Message>) => {
      if (e.data?.kind === 'update-available') offerUpdate(e.data.info);
    };
  }
  return () => {
    window.removeEventListener('storage', onStorage);
    ch?.close();
  };
}
