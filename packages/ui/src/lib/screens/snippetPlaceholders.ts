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

/** The category that puts a snippet in the SFTP browser's right-click menu. Every other
 *  category (free text, made up by the user) only sorts the Snippets screen. */
export const SFTP_MENU_CATEGORY = 'SFTP menu';
/** The submenu an SFTP-menu snippet without one of its own goes under. */
export const DEFAULT_SUBMENU = 'Snippets';

type Categorized = { command: string; name: string; category?: string; submenu?: string };

const inSftpMenu = (s: { category?: string }) => s.category === SFTP_MENU_CATEGORY;

/** Why a snippet in the SFTP menu category won't actually show there, if it won't: a
 *  right-click can fill in `{{file}}` and nothing else. */
export function sftpMenuProblem(command: string): string | undefined {
  const others = placeholdersIn(command).filter((p) => p !== FILE_PLACEHOLDER);
  return others.length > 0
    ? `Uses ${others[0]}, which a right-click can't fill in — only {{file}} works there.`
    : undefined;
}

/** The SFTP right-click menu's snippet submenus for what was clicked: the snippets in
 *  the SFTP menu category that fit it (see `snippetsForTarget`), grouped by submenu in
 *  order of first appearance, each sorted by name. */
export function sftpMenuGroups<T extends Categorized>(snippets: T[], target: SnippetTarget): Array<{ title: string; snippets: T[] }> {
  const groups = new Map<string, T[]>();
  for (const snippet of snippetsForTarget(snippets.filter(inSftpMenu), target)) {
    const title = snippet.submenu?.trim() || DEFAULT_SUBMENU;
    groups.set(title, [...(groups.get(title) ?? []), snippet]);
  }
  return [...groups].map(([title, list]) => ({ title, snippets: [...list].sort((a, b) => a.name.localeCompare(b.name)) }));
}

/** Every category in use, the SFTP menu one first and the rest by name — what the
 *  editor's category field suggests. */
export function snippetCategories(snippets: Array<{ category?: string }>): string[] {
  const own = [...new Set(snippets.map((s) => s.category).filter((c): c is string => !!c && c !== SFTP_MENU_CATEGORY))];
  return [SFTP_MENU_CATEGORY, ...own.sort((a, b) => a.localeCompare(b))];
}

/** The Snippets tab's sections, one per category: the SFTP menu first (it's the one that
 *  does something), then the user's own by name, then the uncategorized ones. Empty
 *  sections are left out; each keeps the library's own order. */
export interface SnippetSection<T> {
  key: string;
  title: string;
  hint: string;
  snippets: T[];
}

export function snippetSections<T extends Categorized>(snippets: T[]): SnippetSection<T>[] {
  const sections: SnippetSection<T>[] = snippetCategories(snippets).map((category) => ({
    key: `category:${category}`,
    title: category,
    hint: category === SFTP_MENU_CATEGORY ? 'Shown when you right-click in the SFTP browser' : '',
    snippets: snippets.filter((s) => s.category === category)
  }));
  sections.push({ key: 'uncategorized', title: 'Uncategorized', hint: '', snippets: snippets.filter((s) => !s.category) });
  return sections.filter((s) => s.snippets.length > 0);
}
