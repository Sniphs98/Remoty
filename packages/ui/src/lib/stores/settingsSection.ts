import { writable } from 'svelte/store';

// Which part of Settings is showing. Settings opens where it was left (a per-window
// convenience, mirrored to localStorage), and a link elsewhere — the AI panel's
// "Open Settings" — can open it at the part it is about.

export const SETTINGS_SECTIONS = ['general', 'terminal', 'ai', 'github', 'onepassword', 'updates'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

const LOCAL_KEY = 'remoty-settings-section';

export function isSettingsSection(value: unknown): value is SettingsSection {
  return SETTINGS_SECTIONS.includes(value as SettingsSection);
}

function initial(): SettingsSection {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return isSettingsSection(raw) ? raw : 'general';
  } catch {
    return 'general';
  }
}

function create() {
  const { subscribe, set } = writable<SettingsSection>(initial());
  return {
    subscribe,
    /** Follow a section another window chose (its localStorage mirror changed). */
    adopt(raw: string | null): void {
      if (isSettingsSection(raw)) set(raw);
    },
    set(section: SettingsSection): void {
      set(section);
      try {
        localStorage.setItem(LOCAL_KEY, section);
      } catch {
        // No storage: Settings opens on General next time.
      }
    }
  };
}

export const settingsSection = create();
export const SETTINGS_SECTION_LOCAL_KEY = LOCAL_KEY;
