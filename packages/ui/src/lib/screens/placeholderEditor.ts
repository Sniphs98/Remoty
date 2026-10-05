// Placeholder help inside a Monaco command editor: `{{` suggestions and the placeholders
// highlighted (the `snippet-placeholder` class, styled in SnippetEditor.svelte). Shared by
// the snippet editor and the If node's command dialog; the lists and ranges themselves
// live Monaco-free in snippetCompletions.ts.
import type * as Monaco from 'monaco-editor';
import { PLACEHOLDERS, placeholderPrefix, placeholderRanges, type PlaceholderHelp } from './snippetCompletions';

/** Adds the suggestions and highlighting to `editor`; returns their cleanup. */
export function addPlaceholderSupport(
  monaco: typeof Monaco,
  editor: Monaco.editor.IStandaloneCodeEditor,
  placeholders: PlaceholderHelp[] = PLACEHOLDERS
): () => void {
  const suggestions = monaco.languages.registerCompletionItemProvider('shell', {
    triggerCharacters: ['{'],
    provideCompletionItems(model, position) {
      // Only in this editor (the provider is per language, FileEditor's shell files too).
      if (model !== editor.getModel()) return { suggestions: [] };
      const before = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column
      });
      const typed = placeholderPrefix(before);
      if (typed === null) return { suggestions: [] };
      // Replace what's typed of the placeholder, and a `}}` the editor closed for us.
      const after = model.getLineContent(position.lineNumber).slice(position.column - 1);
      const closing = after.startsWith('}}') ? 2 : 0;
      const range = new monaco.Range(position.lineNumber, position.column - typed, position.lineNumber, position.column + closing);
      return {
        suggestions: placeholders.map((p, i) => ({
          label: p.label,
          kind: monaco.languages.CompletionItemKind.Variable,
          detail: p.detail,
          insertText: p.insert,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          filterText: p.label,
          sortText: String(i),
          range
        }))
      };
    }
  });

  const decorations = editor.createDecorationsCollection();
  const highlight = (): void => {
    decorations.set(
      placeholderRanges(editor.getValue()).map((r) => ({
        range: new monaco.Range(r.line, r.start, r.line, r.end),
        options: { inlineClassName: 'snippet-placeholder' }
      }))
    );
  };
  highlight();
  const changes = editor.onDidChangeModelContent(highlight);

  return () => {
    suggestions.dispose();
    changes.dispose();
  };
}
