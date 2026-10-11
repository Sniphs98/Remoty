<script lang="ts">
  // The AI helper next to a terminal tab (docs/concepts/ai-integration.md). A chat about
  // one *problem* on this host, kept across sessions: the AI proposes commands as cards,
  // a click runs one in this terminal, and its output goes back to the AI by itself — no
  // copying between terminal and chat. Problems are listed per host; "New" starts another,
  // and an older one can be picked up again from the list at any time.
  import { onMount, tick } from 'svelte';
  import { Icon } from '$lib/theme';
  import { events, type AiCommandDto, type AiEntryDto, type AiProblemDto, type AiShellContextDto } from '$lib/bindings';
  import {
    aiCancel,
    aiContinue,
    aiProblem,
    aiProblemCreate,
    aiProblemDelete,
    aiProblemUpdate,
    aiProblems,
    aiReport,
    aiSend
  } from '$lib/ipc/commands';
  import { activeEntity } from '$lib/stores/activeEntity';
  import { settingsSection } from '$lib/stores/settingsSection';
  import AiCommandCard from './AiCommandCard.svelte';
  import type { CaptureResult } from './aiCapture';
  import { aiTextParts, relativeDay } from './aiText';

  let {
    hostKey,
    hostLabel,
    sessionKey,
    shell,
    runCommand,
    insertCommand,
    onClose
  }: {
    hostKey: string;
    hostLabel: string;
    /** This terminal session; a problem continued from another one gets a note. */
    sessionKey: string;
    /** Where the commands run, asked when a problem starts. */
    shell: () => AiShellContextDto;
    runCommand: (command: string, signal: AbortSignal) => Promise<CaptureResult>;
    insertCommand: (command: string) => void;
    onClose: () => void;
  } = $props();

  let problems = $state<AiProblemDto[]>([]);
  let problem = $state<AiProblemDto | null>(null);
  let entries = $state<AiEntryDto[]>([]);
  let commands = $state<AiCommandDto[]>([]);
  let running = $state(false);
  let streamed = $state('');
  let error = $state('');
  let view = $state<'chat' | 'list'>('chat');
  let draft = $state('');
  let sending = $state(false);
  let capturing = $state<{ commandId: string; controller: AbortController } | null>(null);
  let renaming = $state(false);
  let titleDraft = $state('');
  let resumedFrom = $state<number | null>(null);
  let scroller: HTMLDivElement | undefined = $state();
  let input: HTMLTextAreaElement | undefined = $state();

  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  const commandsOf = (entryId: string): AiCommandDto[] => commands.filter((c) => c.entryId === entryId && c.state !== 'invalid');
  const pending = $derived(commands.filter((c) => c.state === 'proposed'));
  const last = $derived(entries[entries.length - 1]);
  // Results (or a message) the AI has not answered: after a failed request, or when it
  // shouldn't answer right after a command ran.
  const canContinue = $derived(!running && !!last && last.kind !== 'assistant' && pending.length === 0);

  function openAiSettings(): void {
    settingsSection.set('ai');
    activeEntity.selectSettings();
  }

  async function scrollDown(): Promise<void> {
    await tick();
    scroller?.scrollTo({ top: scroller.scrollHeight });
  }

  async function refreshList(): Promise<void> {
    try {
      problems = await aiProblems(hostKey);
    } catch (e) {
      error = message(e);
    }
  }

  async function open(id: string): Promise<void> {
    try {
      const detail = await aiProblem(id);
      problem = detail.problem;
      entries = detail.entries;
      commands = detail.commands;
      running = detail.running;
      streamed = '';
      error = '';
      view = 'chat';
      resumedFrom = detail.problem.lastSessionKey && detail.problem.lastSessionKey !== sessionKey && entries.length ? detail.problem.updatedAt : null;
      await scrollDown();
    } catch (e) {
      error = message(e);
    }
  }

  function startNew(): void {
    problem = null;
    entries = [];
    commands = [];
    running = false;
    streamed = '';
    error = '';
    resumedFrom = null;
    view = 'chat';
    void tick().then(() => input?.focus());
  }

  onMount(() => {
    let off: (() => void) | undefined;
    let gone = false;
    events.aiEvent
      .listen(({ payload: e }) => {
        if (e.type === 'problem') {
          if (e.problem.hostKey === hostKey) {
            problems = [e.problem, ...problems.filter((p) => p.id !== e.problem.id)].sort((a, b) => b.updatedAt - a.updatedAt);
          }
          if (problem?.id === e.problem.id) problem = e.problem;
          return;
        }
        if (e.problemId !== problem?.id) return;
        switch (e.type) {
          case 'turnStart':
            running = true;
            streamed = '';
            error = '';
            break;
          case 'text':
            streamed += e.delta;
            void scrollDown();
            break;
          case 'entry':
            if (!entries.some((x) => x.id === e.entry.id)) entries = [...entries, e.entry];
            commands = [...commands.filter((c) => !e.commands.some((n) => n.id === c.id)), ...e.commands];
            if (e.entry.kind === 'assistant') streamed = '';
            void scrollDown();
            break;
          case 'command':
            commands = commands.map((c) => (c.id === e.command.id ? e.command : c));
            break;
          case 'turnEnd':
            running = false;
            streamed = '';
            break;
          case 'error':
            error = e.message;
            break;
        }
      })
      .then((u) => (gone ? u() : (off = u)))
      .catch(() => {
        // No Electron bridge (tests).
      });

    void (async () => {
      await refreshList();
      // Pick up where this host's most recent open problem left off.
      const recent = problems.find((p) => p.status === 'open');
      if (recent) await open(recent.id);
      else input?.focus();
    })();

    return () => {
      gone = true;
      off?.();
      capturing?.controller.abort();
    };
  });

  async function send(): Promise<void> {
    const text = draft.trim();
    if (!text || sending || running) return;
    sending = true;
    error = '';
    try {
      if (!problem) {
        problem = await aiProblemCreate(hostKey, shell());
        entries = [];
        commands = [];
      }
      await aiSend(problem.id, { text, sessionKey });
      draft = '';
      resumedFrom = null;
    } catch (e) {
      error = message(e);
    } finally {
      sending = false;
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  async function run(c: AiCommandDto): Promise<void> {
    if (capturing || !problem) return;
    const controller = new AbortController();
    capturing = { commandId: c.id, controller };
    const problemId = problem.id;
    try {
      const result = await runCommand(c.command, controller.signal);
      await aiReport(problemId, c.id, { state: 'ran', output: result.output, note: result.note });
    } catch (e) {
      error = message(e);
    } finally {
      capturing = null;
    }
  }

  async function skip(c: AiCommandDto): Promise<void> {
    if (!problem) return;
    try {
      await aiReport(problem.id, c.id, { state: 'skipped' });
    } catch (e) {
      error = message(e);
    }
  }

  async function insert(c: AiCommandDto): Promise<void> {
    insertCommand(c.command);
  }

  async function continueProblem(): Promise<void> {
    if (!problem) return;
    try {
      await aiContinue(problem.id);
    } catch (e) {
      error = message(e);
    }
  }

  async function stop(): Promise<void> {
    if (problem) await aiCancel(problem.id).catch(() => {});
  }

  async function setStatus(status: 'open' | 'solved'): Promise<void> {
    if (!problem) return;
    await aiProblemUpdate(problem.id, { status }).catch((e) => (error = message(e)));
  }

  async function rename(): Promise<void> {
    renaming = false;
    const title = titleDraft.trim();
    if (!problem || !title || title === problem.title) return;
    await aiProblemUpdate(problem.id, { title }).catch((e) => (error = message(e)));
  }

  async function remove(p: AiProblemDto): Promise<void> {
    try {
      await aiProblemDelete(p.id);
      problems = problems.filter((x) => x.id !== p.id);
      if (problem?.id === p.id) startNew();
    } catch (e) {
      error = message(e);
    }
  }

  const iconBtn =
    'grid h-7 w-7 place-items-center rounded-full text-muted transition hover:bg-surface-well hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
  const pill =
    'inline-flex items-center gap-1 rounded-full border border-default px-2.5 py-1 text-xs font-medium text-muted transition hover:border-strong hover:bg-accent hover:text-accent-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
</script>

<aside class="flex h-full w-full flex-col bg-surface-panel" aria-label="AI helper" data-testid="ai-panel">
  <header class="flex items-center gap-1 border-b border-default px-3 py-2" style="padding-top: max(var(--titlebar-h), 0.5rem);">
    <span class="text-accent"><Icon name="sparkle" size={15} /></span>
    {#if view === 'list'}
      <p class="min-w-0 flex-1 truncate text-sm font-medium">Problems on {hostLabel}</p>
    {:else if renaming && problem}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="min-w-0 flex-1 rounded-md bg-surface-well px-2 py-0.5 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus"
        bind:value={titleDraft}
        autofocus
        onblur={() => void rename()}
        onkeydown={(e) => {
          if (e.key === 'Enter') void rename();
          if (e.key === 'Escape') renaming = false;
        }}
      />
    {:else}
      <button
        type="button"
        class="min-w-0 flex-1 truncate text-left text-sm font-medium"
        title={problem ? 'Rename' : undefined}
        disabled={!problem}
        onclick={() => {
          titleDraft = problem?.title ?? '';
          renaming = true;
        }}
      >
        {problem?.title ?? 'New problem'}
      </button>
    {/if}
    <button type="button" class={iconBtn} title="New problem" aria-label="New problem" onclick={startNew}><Icon name="plus" size={15} /></button>
    <button
      type="button"
      class="{iconBtn} {view === 'list' ? 'bg-surface-well text-fg' : ''}"
      title="Problems on this host"
      aria-label="Problems on this host"
      aria-pressed={view === 'list'}
      onclick={() => {
        view = view === 'list' ? 'chat' : 'list';
        if (view === 'list') void refreshList();
      }}><Icon name="list" size={15} /></button
    >
    <button type="button" class={iconBtn} title="Close (Ctrl+Shift+A)" aria-label="Close the AI helper" onclick={onClose}><Icon name="close" size={15} /></button>
  </header>

  {#if view === 'list'}
    <div class="min-h-0 flex-1 overflow-y-auto p-2">
      {#if problems.length === 0}
        <p class="p-3 text-sm text-muted">No problems on {hostLabel} yet.</p>
      {/if}
      <ul class="space-y-1">
        {#each problems as p (p.id)}
          <li class="group flex items-center gap-1 rounded-lg hover:bg-surface-well {problem?.id === p.id ? 'bg-surface-well' : ''}">
            <button type="button" class="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left" onclick={() => void open(p.id)}>
              <span class={p.status === 'solved' ? 'text-status-ok' : 'text-accent'}>
                {#if p.status === 'solved'}<Icon name="check" size={13} />{:else}<span class="mx-1 inline-block h-1.5 w-1.5 rounded-full bg-current"></span>{/if}
              </span>
              <span class="min-w-0 flex-1 truncate text-sm">{p.title}</span>
              <span class="shrink-0 text-[11px] text-faint">{relativeDay(p.updatedAt)}</span>
            </button>
            <button
              type="button"
              class="{iconBtn} mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              title="Delete"
              aria-label="Delete {p.title}"
              onclick={() => void remove(p)}><Icon name="trash" size={13} /></button
            >
          </li>
        {/each}
      </ul>
    </div>
  {:else}
    <div bind:this={scroller} class="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
      {#if !problem && entries.length === 0}
        <div class="space-y-2 px-1 pt-2 text-sm text-muted">
          <p class="text-fg">What are you trying to fix on {hostLabel}?</p>
          <p class="text-xs">
            The AI proposes commands as cards. <span class="text-fg">Run</span> types one into this terminal and sends its
            output back — nothing runs without your click.
          </p>
        </div>
      {/if}
      {#if resumedFrom}
        <p class="rounded-lg bg-surface-well px-2.5 py-1.5 text-xs text-muted">
          Continuing from {relativeDay(resumedFrom)}. The AI will be told this is a new session.
        </p>
      {/if}

      {#each entries as entry (entry.id)}
        {#if entry.kind === 'user'}
          <div class="ml-8 select-text whitespace-pre-wrap break-words rounded-xl bg-surface-well px-3 py-2 text-sm text-fg">{entry.text}</div>
        {:else if entry.kind === 'assistant'}
          <div class="space-y-2">
            {#if entry.text.trim()}
              <div class="select-text whitespace-pre-wrap break-words text-sm text-fg">
                {#each aiTextParts(entry.text) as part, i (i)}
                  {#if part.kind === 'block'}
                    <pre class="my-1 overflow-x-auto rounded-lg bg-surface-well px-2.5 py-2 font-mono text-xs">{part.text}</pre>
                  {:else if part.kind === 'code'}
                    <code class="rounded bg-surface-well px-1 py-px font-mono text-xs">{part.text}</code>
                  {:else}{part.text}{/if}
                {/each}
              </div>
            {/if}
            {#if entry.notice}<p class="text-xs text-status-warn">{entry.notice}</p>{/if}
            {#each commandsOf(entry.id) as c (c.id)}
              <AiCommandCard
                command={c}
                capturing={capturing?.commandId === c.id}
                blocked={capturing !== null}
                onRun={() => void run(c)}
                onInsert={() => void insert(c)}
                onSkip={() => void skip(c)}
                onStopWaiting={() => capturing?.controller.abort()}
              />
            {/each}
          </div>
        {/if}
      {/each}

      {#if running}
        <div class="select-text whitespace-pre-wrap break-words text-sm text-fg">
          {streamed}<span class="ml-0.5 inline-block h-3 w-1.5 animate-pulse rounded-sm bg-[var(--accent)] align-middle"></span>
          <!-- Until the first words arrive; the Codex CLI sends its answer only when done. -->
          {#if !streamed}<span class="ml-1.5 text-xs text-faint">Thinking…</span>{/if}
        </div>
      {/if}
      {#if pending.length > 1 && !running}
        <p class="text-xs text-faint">Run or skip each card — the AI answers once all of them are done.</p>
      {/if}
      {#if error}
        <p class="select-text text-xs text-status-crit" role="alert">
          {error}
          {#if /Settings → AI/.test(error)}
            <button type="button" class="ml-1 underline decoration-dotted" onclick={openAiSettings}>Open Settings</button>
          {/if}
        </p>
      {/if}
      {#if canContinue}
        <button type="button" class={pill} onclick={() => void continueProblem()}>
          <Icon name="play" size={11} />
          Continue
        </button>
      {/if}
    </div>

    <div class="border-t border-default p-2">
      {#if problem}
        <div class="mb-1.5 flex items-center gap-2 px-1 text-[11px] text-faint">
          {#if problem.status === 'solved'}
            <span class="text-status-ok">Solved</span>
            <button type="button" class="underline decoration-dotted hover:text-fg" onclick={() => void setStatus('open')}>Reopen</button>
          {:else}
            <button type="button" class="underline decoration-dotted hover:text-fg" onclick={() => void setStatus('solved')}>Mark as solved</button>
          {/if}
          <span class="ml-auto" title="Tokens sent and received for this problem">
            {Math.round((problem.inputTokens + problem.outputTokens) / 1000)}k tokens
          </span>
        </div>
      {/if}
      <div class="flex items-end gap-1.5 rounded-xl bg-surface-well p-1.5 focus-within:ring-2 focus-within:ring-focus">
        <textarea
          bind:this={input}
          bind:value={draft}
          onkeydown={onKeydown}
          rows="2"
          placeholder={problem ? 'Reply…' : 'Describe the problem…'}
          class="max-h-40 min-h-[2.5rem] flex-1 resize-none bg-transparent px-1.5 py-1 text-sm text-fg outline-none placeholder:text-faint"
        ></textarea>
        {#if running}
          <button type="button" class={iconBtn} title="Stop" aria-label="Stop the answer" onclick={() => void stop()}><Icon name="stop" size={14} /></button>
        {:else}
          <button
            type="button"
            class="{iconBtn} disabled:opacity-40"
            title="Send (Enter)"
            aria-label="Send"
            disabled={!draft.trim() || sending}
            onclick={() => void send()}><Icon name="send" size={14} /></button
          >
        {/if}
      </div>
    </div>
  {/if}
</aside>
