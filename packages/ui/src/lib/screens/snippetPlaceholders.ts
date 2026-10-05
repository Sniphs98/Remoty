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

/** Whether the command mentions `{{file}}`. */
export function usesFilePlaceholder(command: string): boolean {
  return command.includes(FILE_PLACEHOLDER);
}

/** A snippet's type, set in the snippet editor: `'file'` takes a file or folder path,
 *  `'general'` takes none. A snippet saved before the type existed has none stored, so
 *  a `{{file}}` in its command decides — which is how they were sorted until then. */
export type SnippetType = 'general' | 'file';

export function snippetType(snippet: { command: string; type?: SnippetType }): SnippetType {
  return snippet.type ?? (usesFilePlaceholder(snippet.command) ? 'file' : 'general');
}

/** The command a File snippet runs for `path`: `{{file}}` filled in, or — for a command
 *  that leaves it out (`tail -f`, `less`) — the path appended as its last argument. */
export function commandForFile(command: string, path: string): string {
  return usesFilePlaceholder(command) ? fillFilePlaceholder(command, path) : `${command} ${shellQuote(path)}`;
}

/** What a right-click in the SFTP browser landed on: an entry (file or folder), whose
 *  path the snippet takes, or empty space, where only the folder being browsed is on
 *  offer. An entry gets the File snippets, empty space the General ones, so the menu
 *  never offers a snippet that can't use the click. */
export type SnippetTarget = 'entry' | 'folder';

export function snippetsForTarget<T extends { command: string; type?: SnippetType }>(
  snippets: T[],
  target: SnippetTarget
): T[] {
  const wanted: SnippetType = target === 'entry' ? 'file' : 'general';
  return snippets.filter((s) => snippetType(s) === wanted);
}
