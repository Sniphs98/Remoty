<script lang="ts">
  // One command the AI proposed: run it in the terminal with one click (its output goes
  // back to the AI by itself), put it on the prompt to edit first, copy it, or skip it.
  // A dangerous one needs a second click to run.
  import { Icon } from '$lib/theme';
  import type { AiCommandDto } from '$lib/bindings';
  import { lineCount } from './aiText';

  let {
    command,
    capturing = false,
    blocked = false,
    onRun,
    onInsert,
    onSkip,
    onStopWaiting
  }: {
    command: AiCommandDto;
    /** This card's command is running and its output is being captured. */
    capturing?: boolean;
    /** Another command is running, or the terminal is not ready. */
    blocked?: boolean;
    onRun: () => void;
    onInsert: () => void;
    onSkip: () => void;
    onStopWaiting: () => void;
  } = $props();

  let confirming = $state(false);
  let showOutput = $state(false);
  let copied = $state(false);

  const RISK = {
    safe: { label: 'reads only', cls: 'text-status-ok' },
    caution: { label: 'changes something', cls: 'text-status-warn' },
    danger: { label: 'dangerous', cls: 'text-status-crit' }
  } as const;

  function run(): void {
    if (command.risk === 'danger' && !confirming) {
      confirming = true;
      return;
    }
    confirming = false;
    onRun();
  }

  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(command.command);
    copied = true;
    setTimeout(() => (copied = false), 1200);
  }

  const btn =
    'inline-flex items-center gap-1 rounded-full border border-default px-2.5 py-1 text-xs font-medium text-muted transition ' +
    'hover:border-strong hover:bg-accent hover:text-accent-fg disabled:pointer-events-none disabled:opacity-40 ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
</script>

<div
  class="rounded-xl border bg-surface p-2.5 {command.risk === 'danger' && command.state === 'proposed' ? 'border-[var(--status-crit)]' : 'border-default'}"
  data-testid="ai-command"
>
  <pre class="select-text overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-surface-inset px-2.5 py-2 font-mono text-xs text-fg">{command.command}</pre>
  {#if command.explanation}
    <p class="mt-1.5 select-text text-xs text-muted">{command.explanation}</p>
  {/if}

  <div class="mt-2 flex flex-wrap items-center gap-1.5">
    {#if command.state === 'proposed'}
      {#if capturing}
        <span class="inline-flex items-center gap-1.5 text-xs text-muted">
          <span class="spinner h-3 w-3 rounded-full border-2 border-[var(--border)] border-t-[var(--accent)]"></span>
          Running…
        </span>
        <button type="button" class={btn} onclick={onStopWaiting} title="Send the output so far">Done</button>
      {:else}
        <button
          type="button"
          class="{btn} {confirming ? '!border-[var(--status-crit)] !text-status-crit' : ''}"
          disabled={blocked}
          onclick={run}
          title="Run it in the terminal; the output goes back to the AI"
        >
          <Icon name="play" size={11} />
          {confirming ? 'Really run?' : 'Run'}
        </button>
        <button type="button" class={btn} disabled={blocked} onclick={onInsert} title="Put it on the prompt to edit it first">
          <Icon name="edit" size={11} />
          Insert
        </button>
        <button type="button" class={btn} onclick={() => void copy()} title="Copy to the clipboard">{copied ? 'Copied' : 'Copy'}</button>
        <button type="button" class={btn} onclick={onSkip} title="Tell the AI you won't run it">Skip</button>
      {/if}
      <span class="ml-auto text-[11px] {RISK[command.risk].cls}">{RISK[command.risk].label}</span>
    {:else if command.state === 'ran'}
      <button type="button" class="inline-flex items-center gap-1 text-xs text-muted hover:text-fg" onclick={() => (showOutput = !showOutput)}>
        <span class="text-status-ok"><Icon name="check" size={12} /></span>
        Ran · {lineCount(command.output)}{command.omittedLines ? ` (+${command.omittedLines} left out)` : ''}
        <Icon name={showOutput ? 'collapse' : 'expand'} size={11} />
      </button>
      <button type="button" class="ml-auto text-xs text-faint hover:text-fg" onclick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
    {:else if command.state === 'skipped'}
      <span class="text-xs text-faint">Skipped{command.note ? ` — ${command.note}` : ''}</span>
    {/if}
  </div>

  {#if command.state === 'ran' && showOutput}
    <pre class="mt-2 max-h-60 select-text overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface-inset px-2.5 py-2 font-mono text-[11px] text-muted">{command.output || '(no output)'}</pre>
    {#if command.note}<p class="mt-1 text-[11px] text-faint">{command.note}</p>{/if}
  {/if}
</div>

<style>
  .spinner {
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
</style>
