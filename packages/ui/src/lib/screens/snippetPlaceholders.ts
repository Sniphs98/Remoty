// Substitution for running a Snippet straight from the SFTP file browser, where the
// only value on offer is the clicked file. Deliberately separate from the backend
// engine's `substituteTemplate` (`{{nodes.<label>.output}}` / `{{params.<name>}}`),
// which only makes sense inside an automation run — here there is no graph and no
// parameter prompt, just one path.

import { shellQuote } from './shellQuote';

/** The handle a snippet uses to say "put the clicked file's path here". */
export const FILE_PLACEHOLDER = '{{file}}';

/** Replaces every `{{file}}` with `path`, shell-quoted so a space or a quote in the
 *  name can't break (or reshape) the command. A snippet that never mentions the
 *  placeholder comes back unchanged, which is what makes "run this snippet here"
 *  work on snippets that don't care about the file at all. */
export function fillFilePlaceholder(command: string, path: string): string {
  return command.split(FILE_PLACEHOLDER).join(shellQuote(path));
}

/** A snippet run from a folder rather than a file (`docker system prune`, `git pull`):
 *  it runs in the folder being browsed, so "here" means what the user is looking at. */
export function commandInFolder(command: string, folder: string): string {
  return folder ? `cd ${shellQuote(folder)} && ${command}` : command;
}

/** Whether this snippet actually wants a file — drives the wording of the menu entry,
 *  so the user can tell which snippets will use what they right-clicked. */
export function usesFilePlaceholder(command: string): boolean {
  return command.includes(FILE_PLACEHOLDER);
}

/** Every `{{…}}` placeholder in the command, as written (`{{file}}`, `{{params.host}}`). */
function placeholdersIn(command: string): string[] {
  return command.match(/\{\{[^{}\n]*\}\}/g) ?? [];
}

/** What a right-click in the SFTP browser landed on: an entry (file or folder), whose
 *  path can fill `{{file}}`, or empty space, where only the folder being browsed is on
 *  offer. The placeholders in a snippet's command decide where it fits, since the click
 *  is all the browser can fill in:
 *  - an entry gets the snippets whose only placeholder is `{{file}}` (`cat {{file}}`)
 *  - empty space gets the ones with no placeholder at all (`df -h`)
 *  A snippet that also wants something else (`{{params.…}}`, `{{nodes.…}}`) fits
 *  neither — nothing here could fill it in — and stays an automation building block. */
export type SnippetTarget = 'entry' | 'folder';

export function snippetsForTarget<T extends { command: string }>(snippets: T[], target: SnippetTarget): T[] {
  return snippets.filter((s) => {
    const placeholders = placeholdersIn(s.command);
    return target === 'entry'
      ? placeholders.length > 0 && placeholders.every((p) => p === FILE_PLACEHOLDER)
      : placeholders.length === 0;
  });
}
