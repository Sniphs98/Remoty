// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { adoptStorageChange } from './crossWindow';
import { theme } from './theme';
import { streamerMode } from './streamer';
import { refreshInterval } from './settings';
import { terminalGpu, terminalRightClick } from './terminalPrefs';
import { settingsSection } from './settingsSection';

// What the Settings window changes reaches the main window (and back) as a changed
// localStorage entry; each window adopts the value it reads there.
describe('adoptStorageChange', () => {
  it('takes on the theme another window picked', () => {
    theme.set('dark');
    expect(adoptStorageChange('remoty-theme', 'light')).toBe(true);
    expect(get(theme)).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('takes on the other shared prefs', () => {
    adoptStorageChange('remoty-streamer-mode', 'true');
    expect(get(streamerMode)).toBe(true);
    adoptStorageChange('remoty-refresh-interval', '120');
    expect(get(refreshInterval)).toBe(120);
    adoptStorageChange('remoty-terminal-gpu', 'false');
    expect(get(terminalGpu)).toBe(false);
    adoptStorageChange('remoty-terminal-right-click', 'paste');
    expect(get(terminalRightClick)).toBe('paste');
    adoptStorageChange('remoty-settings-section', 'onepassword');
    expect(get(settingsSection)).toBe('onepassword');
  });

  it('ignores values it cannot read and keys it does not know', () => {
    theme.set('dark');
    adoptStorageChange('remoty-theme', 'purple');
    expect(get(theme)).toBe('dark');
    adoptStorageChange('remoty-terminal-right-click', 'bogus');
    expect(get(terminalRightClick)).not.toBe('bogus');
    expect(adoptStorageChange('something-else', 'x')).toBe(false);
    expect(adoptStorageChange(null, null)).toBe(false);
  });
});
