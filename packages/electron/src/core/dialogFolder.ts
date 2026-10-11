import { dirname, join } from 'node:path';

/**
 * The folder the file dialogs open in. Since Electron 43 a dialog without a
 * `defaultPath` opens in Downloads every time and the OS no longer remembers where the
 * user went last, so the app remembers it instead — for this run of the app, across
 * every import and export dialog.
 */

let lastFolder: string | undefined;

/** `defaultPath` for a dialog: the file name (if any) in the folder used last. Without a
 *  folder yet, just the name — Electron then puts it in Downloads. */
export function dialogDefaultPath(fileName?: string): string | undefined {
  if (!lastFolder) return fileName;
  return fileName ? join(lastFolder, fileName) : lastFolder;
}

/** Remembers where a dialog's choice was: the file's folder, or the folder itself. */
export function rememberDialogChoice(chosen: string, isFolder = false): void {
  lastFolder = isFolder ? chosen : dirname(chosen);
}

/** For tests. */
export function resetDialogFolder(): void {
  lastFolder = undefined;
}
