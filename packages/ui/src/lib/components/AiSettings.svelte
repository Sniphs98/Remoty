<script lang="ts">
  // Settings → AI: the provider the terminal's AI helper uses and its API key — a
  // 1Password reference when switched on, else a key kept in the app, encrypted like host
  // passwords. The key never comes back from the app, only whether one is stored. "Test
  // connection" checks the key and the model against the provider.
  import { onMount } from 'svelte';
  import { Surface, Icon } from '$lib/theme';
  import OnePasswordToggle from './OnePasswordToggle.svelte';
  import OnePasswordCliHint from './OnePasswordCliHint.svelte';
  import Switch from './Switch.svelte';
  import { aiSaveSettings, aiSettings, aiTest } from '$lib/ipc/commands';
  import { openExternal } from '$lib/ipc/openExternal';
  import type { AiProviderDto } from '$lib/bindings';

  type Form = { hasKey: boolean; from1P: boolean; keyRef: string; key: string; model: string; defaultModel: string };
  const empty = (defaultModel: string): Form => ({ hasKey: false, from1P: false, keyRef: '', key: '', model: '', defaultModel });

  const PROVIDERS: { id: AiProviderDto; label: string; keyHint: string; keyUrl: string }[] = [
    { id: 'anthropic', label: 'Claude', keyHint: 'sk-ant-…', keyUrl: 'https://platform.claude.com/settings/keys' },
    { id: 'openai', label: 'OpenAI', keyHint: 'sk-…', keyUrl: 'https://platform.openai.com/api-keys' }
  ];

  let loaded = $state(false);
  let provider = $state<AiProviderDto>('anthropic');
  let replyToResult = $state(true);
  let forms = $state<Record<AiProviderDto, Form>>({ anthropic: empty('claude-opus-5-5'), openai: empty('gpt-5.5') });
  let saving = $state(false);
  let status = $state<{ kind: 'idle' } | { kind: 'busy' } | { kind: 'ok'; text: string } | { kind: 'error'; text: string }>({ kind: 'idle' });

  const current = $derived(PROVIDERS.find((p) => p.id === provider)!);
  const form = $derived(forms[provider]);

  onMount(async () => {
    try {
      const s = await aiSettings();
      provider = s.provider;
      replyToResult = s.replyToResult;
      for (const id of ['anthropic', 'openai'] as const) {
        const p = s[id];
        forms[id] = { hasKey: p.hasKey, from1P: Boolean(p.keyRef), keyRef: p.keyRef ?? '', key: '', model: p.model ?? '', defaultModel: p.defaultModel };
      }
    } catch {
      // Not under Electron: the section shows, empty.
    }
    loaded = true;
  });

  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  function input(id: AiProviderDto) {
    const f = forms[id];
    return f.from1P ? { keyRef: f.keyRef, model: f.model } : { key: f.key || undefined, keyRef: '', model: f.model };
  }

  async function save(): Promise<void> {
    saving = true;
    status = { kind: 'idle' };
    try {
      await aiSaveSettings({ provider, replyToResult, anthropic: input('anthropic'), openai: input('openai') });
      for (const id of ['anthropic', 'openai'] as const) {
        const f = forms[id];
        if (!f.from1P && f.key) f.hasKey = true;
        f.key = '';
      }
      if (form.hasKey || (form.from1P && form.keyRef.trim())) await test();
    } catch (e) {
      status = { kind: 'error', text: message(e) };
    } finally {
      saving = false;
    }
  }

  async function forgetKey(): Promise<void> {
    await aiSaveSettings({ provider, replyToResult, [provider]: { clearKey: true, keyRef: form.from1P ? form.keyRef : '' } });
    forms[provider].hasKey = false;
    status = { kind: 'idle' };
  }

  async function test(): Promise<void> {
    status = { kind: 'busy' };
    try {
      const model = await aiTest(provider);
      status = { kind: 'ok', text: `Connected — using ${model}.` };
    } catch (e) {
      status = { kind: 'error', text: message(e) };
    }
  }

  const field =
    'w-full rounded-lg bg-surface-inset px-3 py-2 text-sm text-fg outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-focus';
  const pill =
    'inline-flex shrink-0 items-center gap-1.5 rounded-full border border-strong px-4 py-1.5 text-sm text-fg transition hover:bg-accent hover:text-accent-fg disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
  const seg =
    'rounded-lg px-3 py-1.5 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
  const segState = (on: boolean): string => (on ? 'bg-surface text-fg shadow-soft' : 'text-muted hover:text-fg');
</script>

<Surface class="p-5">
  <h2 class="mb-1 text-sm font-semibold">AI</h2>
  <p class="mb-4 text-xs text-muted">
    A chat next to each terminal (<span class="text-fg">Ctrl+Shift+A</span>) that proposes commands you run with one
    click; their output goes back to the AI by itself. It never runs anything on its own. Uses your own API key —
    each request is billed by the provider.
  </p>

  <div class="space-y-3">
    <div class="flex items-center justify-between gap-4">
      <p class="text-sm">Provider</p>
      <div class="flex gap-1 rounded-xl bg-surface-inset p-1">
        {#each PROVIDERS as p (p.id)}
          <button type="button" class="{seg} {segState(provider === p.id)}" aria-pressed={provider === p.id} onclick={() => ((provider = p.id), (status = { kind: 'idle' }))}>
            {p.label}
          </button>
        {/each}
      </div>
    </div>

    <div class="block space-y-1 text-xs font-medium text-muted">
      <div class="flex items-center justify-between gap-2">
        <label for="ai-key">{current.label} API key</label>
        <OnePasswordToggle bind:on={forms[provider].from1P} field="API key" />
      </div>
      {#if form.from1P}
        <input id="ai-key" bind:value={forms[provider].keyRef} class="{field} font-mono" placeholder="op://Private/{current.label}/credential" spellcheck="false" autocomplete="off" />
      {:else}
        <input
          id="ai-key"
          type="password"
          bind:value={forms[provider].key}
          class={field}
          placeholder={form.hasKey ? 'Saved — leave blank to keep it' : current.keyHint}
          autocomplete="off"
        />
      {/if}
      <button type="button" class="font-normal underline decoration-dotted hover:text-fg" onclick={() => void openExternal(current.keyUrl)}>
        Create a key
      </button>
    </div>
    {#if form.from1P && form.keyRef.trim()}
      <OnePasswordCliHint />
    {/if}

    <label class="block space-y-1 text-xs font-medium text-muted">
      <span>Model</span>
      <input bind:value={forms[provider].model} class="{field} font-mono" placeholder={form.defaultModel} spellcheck="false" autocomplete="off" />
    </label>

    <div class="flex items-center justify-between gap-4 pt-1">
      <div class="min-w-0">
        <p class="text-sm">Answer right after a command ran</p>
        <p class="text-xs text-muted">
          Off: the output waits on the card until you write something or press Continue.
        </p>
      </div>
      <Switch bind:checked={replyToResult} label="Answer right after a command ran" />
    </div>

    <div class="flex flex-wrap items-center gap-2 pt-1">
      <button type="button" class={pill} disabled={!loaded || saving} onclick={save} aria-label="Save AI settings and test">
        <Icon name="check" size={14} />
        Save and test
      </button>
      <button type="button" class={pill} disabled={!loaded || status.kind === 'busy'} onclick={test} aria-label="Test the AI connection">
        <Icon name="refresh" size={14} />
        Test connection
      </button>
      {#if form.hasKey && !form.from1P}
        <button type="button" class="text-xs text-muted underline decoration-dotted hover:text-fg" onclick={forgetKey}>
          Forget the saved key
        </button>
      {/if}
    </div>

    {#if status.kind === 'busy'}
      <p class="text-xs text-muted">Asking {current.label}…</p>
    {:else if status.kind === 'ok'}
      <p class="flex items-center gap-1.5 text-xs text-status-ok"><Icon name="check" size={12} />{status.text}</p>
    {:else if status.kind === 'error'}
      <p class="text-xs text-status-crit">{status.text}</p>
    {/if}
  </div>
</Surface>
