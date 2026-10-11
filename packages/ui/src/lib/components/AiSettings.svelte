<script lang="ts">
  // Settings → AI: which AI the terminal's AI helper uses and how it signs in. With an
  // API key — a 1Password reference when switched on, else a key kept in the app,
  // encrypted like host passwords; the key never comes back from the app, only whether
  // one is stored. Or with the user's subscription, through the Claude Code or Codex CLI
  // they installed and signed in to; Remoty only shows whether that worked. Or, for
  // OpenAI, by signing in to ChatGPT right here (experimental: the sign-in the Codex CLI
  // uses, which OpenAI does not document for other apps). "Test connection" checks the
  // key and the model, or that the CLI or ChatGPT is signed in.
  import { onMount } from 'svelte';
  import { Surface, Icon } from '$lib/theme';
  import OnePasswordToggle from './OnePasswordToggle.svelte';
  import OnePasswordCliHint from './OnePasswordCliHint.svelte';
  import Switch from './Switch.svelte';
  import { aiChatgptCancelLogin, aiChatgptLogin, aiChatgptLogout, aiCliStatus, aiSaveSettings, aiSettings, aiTest } from '$lib/ipc/commands';
  import { openExternal } from '$lib/ipc/openExternal';
  import type { AiChatgptAccountDto, AiCliProviderDto, AiCliStatusDto, AiProviderDto } from '$lib/bindings';

  type Form = { hasKey: boolean; from1P: boolean; keyRef: string; key: string; model: string; defaultModel: string; path: string };
  const empty = (defaultModel: string): Form => ({ hasKey: false, from1P: false, keyRef: '', key: '', model: '', defaultModel, path: '' });

  type Family = 'claude' | 'openai';
  type Access = 'key' | 'subscription' | 'login';
  const FAMILIES: { id: Family; label: string; keyHint: string; keyUrl: string }[] = [
    { id: 'claude', label: 'Claude', keyHint: 'sk-ant-…', keyUrl: 'https://platform.claude.com/settings/keys' },
    { id: 'openai', label: 'OpenAI', keyHint: 'sk-…', keyUrl: 'https://platform.openai.com/api-keys' }
  ];
  const PROVIDER: Record<Family, Partial<Record<Access, AiProviderDto>>> = {
    claude: { key: 'anthropic', subscription: 'claude-cli' },
    openai: { key: 'openai', subscription: 'codex-cli', login: 'chatgpt' }
  };
  const ACCESS: { id: Access; label: string }[] = [
    { id: 'key', label: 'API key' },
    { id: 'subscription', label: 'Subscription' },
    { id: 'login', label: 'ChatGPT login' }
  ];
  const CLI: Record<AiCliProviderDto, { name: string; plan: string; program: string; signIn: string; installUrl: string }> = {
    'claude-cli': {
      name: 'Claude Code',
      plan: 'Claude Pro or Max',
      program: 'claude',
      signIn: 'claude auth login',
      installUrl: 'https://code.claude.com/docs/en/setup'
    },
    'codex-cli': {
      name: 'the Codex CLI',
      plan: 'ChatGPT',
      program: 'codex',
      signIn: 'codex login',
      installUrl: 'https://developers.openai.com/codex/cli'
    }
  };
  const ALL: AiProviderDto[] = ['anthropic', 'openai', 'claude-cli', 'codex-cli', 'chatgpt'];
  const isCli = (id: AiProviderDto): id is AiCliProviderDto => id === 'claude-cli' || id === 'codex-cli';

  let loaded = $state(false);
  let provider = $state<AiProviderDto>('anthropic');
  let replyToResult = $state(true);
  let forms = $state<Record<AiProviderDto, Form>>({
    anthropic: empty('claude-opus-5-5'),
    openai: empty('gpt-5.5'),
    'claude-cli': empty(''),
    'codex-cli': empty(''),
    chatgpt: empty('gpt-5.5')
  });
  let chatgptAccount = $state<AiChatgptAccountDto | undefined>(undefined);
  let signingIn = $state(false);
  let saving = $state(false);
  let status = $state<{ kind: 'idle' } | { kind: 'busy' } | { kind: 'ok'; text: string } | { kind: 'error'; text: string }>({ kind: 'idle' });
  let cliStatus = $state<Partial<Record<AiCliProviderDto, AiCliStatusDto | 'checking'>>>({});

  const family = $derived<Family>(provider === 'anthropic' || provider === 'claude-cli' ? 'claude' : 'openai');
  const access = $derived<Access>(isCli(provider) ? 'subscription' : provider === 'chatgpt' ? 'login' : 'key');
  const current = $derived(FAMILIES.find((f) => f.id === family)!);
  const form = $derived(forms[provider]);
  const cli = $derived(isCli(provider) ? CLI[provider] : undefined);
  const cliState = $derived(isCli(provider) ? cliStatus[provider] : undefined);

  function choose(next: AiProviderDto): void {
    provider = next;
    status = { kind: 'idle' };
    if (isCli(next) && !cliStatus[next]) void checkCli(next);
  }

  async function checkCli(id: AiCliProviderDto): Promise<void> {
    cliStatus[id] = 'checking';
    try {
      cliStatus[id] = await aiCliStatus(id);
    } catch (e) {
      cliStatus[id] = { installed: false, loggedIn: false, detail: message(e) };
    }
  }

  onMount(async () => {
    try {
      const s = await aiSettings();
      provider = s.provider;
      replyToResult = s.replyToResult;
      for (const id of ALL) {
        const p = s[id];
        if (!p) continue;
        forms[id] = {
          hasKey: p.hasKey,
          from1P: Boolean(p.keyRef),
          keyRef: p.keyRef ?? '',
          key: '',
          model: p.model ?? '',
          defaultModel: p.defaultModel,
          path: p.path ?? ''
        };
      }
      if (s.chatgpt?.account) chatgptAccount = s.chatgpt.account;
      if (isCli(provider)) void checkCli(provider);
    } catch {
      // Not under Electron: the section shows, empty.
    }
    loaded = true;
  });

  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  function input(id: AiProviderDto) {
    const f = forms[id];
    if (isCli(id)) return { model: f.model, path: f.path };
    if (id === 'chatgpt') return { model: f.model };
    return f.from1P ? { keyRef: f.keyRef, model: f.model } : { key: f.key || undefined, keyRef: '', model: f.model };
  }

  async function save(): Promise<void> {
    saving = true;
    status = { kind: 'idle' };
    try {
      await aiSaveSettings({ provider, replyToResult, ...Object.fromEntries(ALL.map((id) => [id, input(id)])) });
      for (const id of ALL) {
        const f = forms[id];
        if (!f.from1P && f.key) f.hasKey = true;
        f.key = '';
      }
      if (isCli(provider)) {
        await checkCli(provider);
        await test();
      } else if (provider === 'chatgpt') {
        if (chatgptAccount) await test();
      } else if (form.hasKey || (form.from1P && form.keyRef.trim())) await test();
    } catch (e) {
      status = { kind: 'error', text: message(e) };
    } finally {
      saving = false;
    }
  }

  async function signInChatgpt(): Promise<void> {
    signingIn = true;
    status = { kind: 'idle' };
    try {
      chatgptAccount = await aiChatgptLogin();
      // Signing in is choosing it.
      await aiSaveSettings({ provider: 'chatgpt', replyToResult, chatgpt: input('chatgpt') });
      status = { kind: 'ok', text: `Signed in to ChatGPT${chatgptAccount.email ? ` as ${chatgptAccount.email}` : ''}.` };
    } catch (e) {
      const text = message(e);
      if (text !== 'stopped') status = { kind: 'error', text };
    } finally {
      signingIn = false;
    }
  }

  async function signOutChatgpt(): Promise<void> {
    try {
      await aiChatgptLogout();
      chatgptAccount = undefined;
      status = { kind: 'idle' };
    } catch (e) {
      status = { kind: 'error', text: message(e) };
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
      status = {
        kind: 'ok',
        text: isCli(provider)
          ? `Ready — ${CLI[provider].name} is signed in.`
          : provider === 'chatgpt'
            ? `Signed in to ChatGPT — using ${model}.`
            : `Connected — using ${model}.`
      };
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
  <p class="mb-4 text-xs text-muted">
    A chat next to each terminal (<span class="text-fg">Ctrl+Shift+A</span>) that proposes commands you run with one
    click; their output goes back to the AI by itself. It never runs anything on its own. Uses your own API key —
    each request is billed by the provider — or your Claude or ChatGPT subscription, through Claude Code or the Codex
    CLI installed on this computer.
  </p>

  <div class="space-y-3">
    <div class="flex items-center justify-between gap-4">
      <p class="text-sm">Provider</p>
      <div class="flex gap-1 rounded-xl bg-surface-inset p-1">
        {#each FAMILIES as f (f.id)}
          <button
            type="button"
            class="{seg} {segState(family === f.id)}"
            aria-pressed={family === f.id}
            onclick={() => choose(PROVIDER[f.id][access] ?? PROVIDER[f.id].key!)}
          >
            {f.label}
          </button>
        {/each}
      </div>
    </div>

    <div class="flex items-center justify-between gap-4">
      <p class="text-sm">Sign in with</p>
      <div class="flex gap-1 rounded-xl bg-surface-inset p-1">
        {#each ACCESS.filter((a) => PROVIDER[family][a.id]) as a (a.id)}
          <button type="button" class="{seg} {segState(access === a.id)}" aria-pressed={access === a.id} onclick={() => choose(PROVIDER[family][a.id]!)}>
            {a.label}
          </button>
        {/each}
      </div>
    </div>

    {#if cli && isCli(provider)}
      <div class="space-y-2 rounded-lg bg-surface-inset px-3 py-2 text-xs text-muted" data-testid="ai-cli-status">
        <p>
          Uses your {cli.plan} plan through {cli.name} on this computer — Remoty starts it for each answer, with no tools of
          its own, and never sees your sign-in.
        </p>
        {#if cliState === 'checking' || cliState === undefined}
          <p>Looking for {cli.name}…</p>
        {:else if !cliState.installed}
          <p class="text-status-crit">{cliState.detail}</p>
          <button type="button" class="underline decoration-dotted hover:text-fg" onclick={() => void openExternal(cli.installUrl)}>
            How to install {cli.name}
          </button>
        {:else if !cliState.loggedIn}
          <p class="text-status-crit">
            {cliState.version ?? cli.name} is installed but not signed in. Run
            <code class="rounded bg-surface px-1 font-mono text-fg">{cli.signIn}</code> in a terminal, then check again.
          </p>
        {:else}
          <p class="flex items-center gap-1.5 text-status-ok">
            <Icon name="check" size={12} />{cliState.version ?? cli.name} — {cliState.detail}
          </p>
        {/if}
        <button
          type="button"
          class="underline decoration-dotted hover:text-fg disabled:opacity-50"
          disabled={cliState === 'checking'}
          onclick={() => void checkCli(provider as AiCliProviderDto)}
        >
          Check again
        </button>
      </div>

      <label class="block space-y-1 text-xs font-medium text-muted">
        <span>Program</span>
        <input
          bind:value={forms[provider].path}
          class="{field} font-mono"
          placeholder={cliState && cliState !== 'checking' && cliState.path ? cliState.path : `${cli.program} (found on PATH)`}
          spellcheck="false"
          autocomplete="off"
        />
      </label>
    {:else if provider === 'chatgpt'}
      <div class="space-y-2 rounded-lg bg-surface-inset px-3 py-2 text-xs text-muted" data-testid="ai-chatgpt-login">
        <p>
          <span class="font-medium text-status-warn">Experimental.</span> Signs in to your ChatGPT plan right here, the
          way the Codex CLI does. OpenAI does not document this for other apps, so it may stop working at any time —
          <span class="text-fg">Subscription</span> (through the Codex CLI) is the supported way to the same plan.
        </p>
        {#if chatgptAccount}
          <p class="flex items-center gap-1.5 text-status-ok">
            <Icon name="check" size={12} />Signed in{chatgptAccount.email ? ` as ${chatgptAccount.email}` : ''}{chatgptAccount.plan
              ? ` (${chatgptAccount.plan})`
              : ''}
          </p>
        {:else if signingIn}
          <p>Finish signing in in your browser…</p>
        {:else}
          <p>Not signed in.</p>
        {/if}
        <div class="flex flex-wrap items-center gap-2 pt-1">
          {#if signingIn}
            <button type="button" class={pill} onclick={() => void aiChatgptCancelLogin()}>Cancel sign-in</button>
          {:else if chatgptAccount}
            <button type="button" class="text-xs underline decoration-dotted hover:text-fg" onclick={() => void signOutChatgpt()}>Sign out</button>
          {:else}
            <button type="button" class={pill} disabled={!loaded} onclick={() => void signInChatgpt()}>Sign in with ChatGPT</button>
          {/if}
        </div>
      </div>
    {:else}
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
    {/if}

    <label class="block space-y-1 text-xs font-medium text-muted">
      <span>Model</span>
      <input
        bind:value={forms[provider].model}
        class="{field} font-mono"
        placeholder={form.defaultModel || `${cli?.name ?? 'The CLI'}'s default`}
        spellcheck="false"
        autocomplete="off"
      />
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
      {#if !cli && form.hasKey && !form.from1P}
        <button type="button" class="text-xs text-muted underline decoration-dotted hover:text-fg" onclick={forgetKey}>
          Forget the saved key
        </button>
      {/if}
    </div>

    {#if status.kind === 'busy'}
      <p class="text-xs text-muted">{cli ? `Checking ${cli.name}…` : `Asking ${current.label}…`}</p>
    {:else if status.kind === 'ok'}
      <p class="flex items-center gap-1.5 text-xs text-status-ok"><Icon name="check" size={12} />{status.text}</p>
    {:else if status.kind === 'error'}
      <p class="text-xs text-status-crit">{status.text}</p>
    {/if}
  </div>
</Surface>
