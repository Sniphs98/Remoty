import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { dialogDefaultPath, rememberDialogChoice, resetDialogFolder } from './dialogFolder';

afterEach(resetDialogFolder);

describe('dialog folder', () => {
  it('leaves the folder to Electron until the user picked one', () => {
    expect(dialogDefaultPath('hosts.json')).toBe('hosts.json');
    expect(dialogDefaultPath()).toBeUndefined();
  });

  it('opens the next dialog where the last choice was', () => {
    rememberDialogChoice(join('/home', 'me', 'exports', 'hosts.json'));
    expect(dialogDefaultPath('snippet.json')).toBe(join('/home', 'me', 'exports', 'snippet.json'));
    expect(dialogDefaultPath()).toBe(join('/home', 'me', 'exports'));
  });

  it('takes a picked folder as it is', () => {
    rememberDialogChoice(join('/home', 'me', 'Desktop'), true);
    expect(dialogDefaultPath()).toBe(join('/home', 'me', 'Desktop'));
  });
});
