import { commands } from '$lib/bindings';
import { settingsSection, type SettingsSection } from '$lib/stores/settingsSection';

// Settings opens in a window of its own, beside the main one, instead of replacing
// what the main window shows. The same app is loaded there with `?window=settings`;
// the layout and the page check `isSettingsWindow()` to show only Settings and to
// leave hosts, metrics and the event bridge to the main window.

export const SETTINGS_WINDOW_QUERY = '?window=settings';

export function isSettingsWindow(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('window') === 'settings';
  } catch {
    return false;
  }
}

/** Opens the Settings window, or brings it to the front if it's open — at `section`
 *  when given (an open window follows through the shared section store). */
export async function openSettingsWindow(section?: SettingsSection): Promise<void> {
  if (section) settingsSection.set(section);
  if (window.remoty) {
    const res = await commands.openSettingsWindow();
    if (res.status === 'error') throw new Error(res.error.message);
    return;
  }
  // No Electron bridge (vite preview): a browser window does the same job.
  window.open(`/${SETTINGS_WINDOW_QUERY}`, 'remoty-settings', 'width=960,height=720');
}
