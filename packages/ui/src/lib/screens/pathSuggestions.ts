// What a pane's path bar suggests when it's clicked: the folders above the current one,
// the folders in it, recently visited ones and the shortcuts — filtered by what's typed.
// Works for this computer's paths (C:\Users\me, /home/me) and the server's (/var/www).
// Kept free of Svelte so it's unit-testable; PathBar.svelte renders it.

export interface PathSuggestion {
  path: string;
  /** What the row shows: a shortcut's name, a folder's own name, or the whole path. */
  label: string;
}

export interface PathSuggestionGroup {
  title: string;
  items: PathSuggestion[];
}

/** `\` for a Windows path (C:\…, \\server\share), `/` otherwise. */
export function separatorOf(path: string): '/' | '\\' {
  return /^[A-Za-z]:[\\/]|^\\\\/.test(path) || (path.includes('\\') && !path.includes('/')) ? '\\' : '/';
}

/** Every folder above `path`, outermost first: `/var/www/app` → `/`, `/var`, `/var/www`;
 *  `C:\Users\me` → `C:\`, `C:\Users`. */
export function ancestors(path: string): string[] {
  const sep = separatorOf(path);
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return [];
  const drive = sep === '\\' && /^[A-Za-z]:$/.test(parts[0]);
  const root = drive ? `${parts[0]}\\` : sep === '/' ? '/' : '';
  const rest = drive ? parts.slice(1) : parts;
  const out: string[] = [];
  if (root) out.push(root);
  for (let i = 1; i < rest.length; i++) out.push(root + rest.slice(0, i).join(sep));
  return out.filter((p) => p !== path);
}

/** The last part of a path, for a row's label. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length === 0 ? path : parts[parts.length - 1];
}

/** `path` added to the front of `recent` (once), at most `max` long. */
export function rememberPath(recent: string[], path: string, max = 8): string[] {
  if (!path) return recent;
  return [path, ...recent.filter((p) => p !== path)].slice(0, max);
}

/** The groups to show, each filtered by `typed` (anywhere in the path or label, any
 *  case). Typing a whole path that's in none of them still goes there on Enter. */
export function pathSuggestions(input: {
  path: string;
  typed: string;
  subfolders: string[];
  recent: string[];
  shortcuts: Array<{ name: string; path: string }>;
}): PathSuggestionGroup[] {
  const q = input.typed.trim().toLowerCase();
  // While the bar still shows the current path untouched, nothing is filtered.
  const filter = q && q !== input.path.toLowerCase() ? q : '';
  const keep = (s: PathSuggestion) => !filter || s.path.toLowerCase().includes(filter) || s.label.toLowerCase().includes(filter);
  const groups: PathSuggestionGroup[] = [
    { title: 'Shortcuts', items: input.shortcuts.map((s) => ({ path: s.path, label: s.name })) },
    { title: 'In this folder', items: input.subfolders.map((p) => ({ path: p, label: baseName(p) })) },
    { title: 'Up', items: ancestors(input.path).reverse().map((p) => ({ path: p, label: p })) },
    { title: 'Recent', items: input.recent.filter((p) => p !== input.path).map((p) => ({ path: p, label: p })) }
  ];
  return groups.map((g) => ({ ...g, items: g.items.filter(keep) })).filter((g) => g.items.length > 0);
}
