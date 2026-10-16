import type * as Monaco from 'monaco-editor';

// Monaco's own "vs" / "vs-dark" themes bring their own greys (an off-white page, its own
// gutter and selection colours), which sit oddly inside the app's cards. These themes
// build on them but take the editor chrome from the app's semantic tokens (app.css),
// read at runtime so the two never drift apart. Syntax colours stay Monaco's.

/** A CSS colour as Monaco wants it (#rrggbb or #rrggbbaa); undefined if unreadable. */
export function toHex(css: string): string | undefined {
  const value = css.trim();
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) return value.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(value)) return '#' + [...value.slice(1)].map((c) => c + c).join('').toLowerCase();
  const m = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i);
  if (!m) return undefined;
  const byte = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');
  const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return '#' + byte(+m[1]) + byte(+m[2]) + byte(+m[3]) + (alpha < 1 ? byte(alpha * 255) : '');
}

/** Defines the theme for `mode` from the current tokens and returns its name. */
export function monacoTheme(monaco: typeof Monaco, mode: 'light' | 'dark'): string {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => toHex(style.getPropertyValue(name));
  const colors: Record<string, string> = {};
  const set = (key: string, value: string | undefined) => {
    if (value) colors[key] = value;
  };
  set('editor.background', token('--surface'));
  set('editor.foreground', token('--text'));
  set('editorGutter.background', token('--surface'));
  set('editorLineNumber.foreground', token('--text-faint'));
  set('editorLineNumber.activeForeground', token('--text-muted'));
  set('editorCursor.foreground', token('--text'));
  set('editorWidget.background', token('--surface-raised'));
  set('editorWidget.border', token('--border'));
  set('editorSuggestWidget.background', token('--surface-raised'));
  set('editorSuggestWidget.border', token('--border'));
  set('editorIndentGuide.background1', token('--border'));
  set('scrollbarSlider.background', token('--border'));
  set('scrollbarSlider.hoverBackground', token('--border-strong'));
  const name = mode === 'dark' ? 'remoty-dark' : 'remoty-light';
  monaco.editor.defineTheme(name, { base: mode === 'dark' ? 'vs-dark' : 'vs', inherit: true, rules: [], colors });
  return name;
}
