<script lang="ts">
  // The If node's command, edited in a dialog: room for a longer, multi-line check than the
  // one-line field on the canvas node (AutomationIfNode.svelte) offers. Opened via
  // AUTOMATION_NODE_ACTIONS_CONTEXT, because a canvas node sits inside svelte-flow's
  // transformed viewport and can't host a page-level Modal itself. Apply hands the
  // command back to AutomationEditor, which writes it onto the node; nothing is saved
  // until the automation is.
  import type * as Monaco from 'monaco-editor';
  import { Button, Icon } from '$lib/theme';
  import CodeEditor from '$lib/components/CodeEditor.svelte';
  import Modal from '$lib/components/Modal.svelte';
  import { PLACEHOLDERS, plainInsert } from './snippetCompletions';
  import { addPlaceholderSupport } from './placeholderEditor';

  let {
    label,
    initial,
    onApply,
    onCancel
  }: {
    /** The node's label, to say which If this is. */
    label: string;
    initial: string;
    onApply: (command: string) => void;
    onCancel: () => void;
  } = $props();

  // Seeded once; the dialog is remounted per open.
  // svelte-ignore state_referenced_locally
  let command = $state(initial);
  const dirty = $derived(command !== initial);

  // `{{file}}` is the SFTP browser's; an automation has no file right-clicked.
  const placeholders = PLACEHOLDERS.filter((p) => p.label !== '{{file}}');

  let codeEditor: Monaco.editor.IStandaloneCodeEditor | undefined;

  function apply(): void {
    onApply(command);
  }

  function setUpEditor(monaco: typeof Monaco, editor: Monaco.editor.IStandaloneCodeEditor): () => void {
    codeEditor = editor;
    const cleanup = addPlaceholderSupport(monaco, editor, placeholders);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, apply);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, apply);
    editor.focus();
    return () => {
      cleanup();
      codeEditor = undefined;
    };
  }

  /** A placeholder from the list, at the cursor. */
  function insertPlaceholder(text: string): void {
    if (!codeEditor) {
      command += text;
      return;
    }
    const selection = codeEditor.getSelection();
    if (selection) codeEditor.executeEdits('placeholder', [{ range: selection, text, forceMoveMarkers: true }]);
    codeEditor.focus();
  }
</script>

<Modal label="Edit If command" size="large" onClose={onCancel} {dirty} onSave={apply}>
  <form
    onsubmit={(e) => {
      e.preventDefault();
      apply();
    }}
    class="flex min-h-0 flex-col"
  >
    <header class="flex items-center gap-3 border-b border-default px-5 py-3.5 pr-12">
      <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-inset text-muted">
        <Icon name="branch" size={15} />
      </span>
      <span class="min-w-0 flex-1">
        <h2 class="truncate text-sm font-semibold">If {label ? `“${label}”` : ''} — command</h2>
        <span class="block truncate text-xs text-faint">
          Succeeds (exit code 0) → yes; fails or times out → no · type {'{{'} for placeholders
        </span>
      </span>
    </header>

    <div class="min-h-0 flex-1 px-5 py-4">
      <div class="h-[min(52vh,520px)] min-h-[240px] overflow-hidden rounded-xl border border-default">
        <CodeEditor
          bind:value={command}
          language="shell"
          ariaLabel="Command"
          placeholder="test -f image.tar.gz"
          onReady={setUpEditor}
        />
      </div>
      <div class="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
        <span>Insert:</span>
        {#each placeholders as p (p.label)}
          <button
            type="button"
            class="rounded bg-surface-inset px-2 py-0.5 font-mono text-fg transition hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            title={p.detail}
            onclick={() => insertPlaceholder(plainInsert(p))}>{p.label}</button
          >
        {/each}
      </div>
    </div>

    <footer class="flex items-center justify-between gap-2 border-t border-default px-5 py-3">
      <span class="text-xs text-faint">Ctrl+Enter applies · saved with the automation</span>
      <div class="flex gap-2">
        <Button variant="ghost" onclick={onCancel}>Cancel</Button>
        <Button variant="primary" type="submit">Apply</Button>
      </div>
    </footer>
  </form>
</Modal>
