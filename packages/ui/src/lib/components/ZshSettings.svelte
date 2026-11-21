<script lang="ts">
  import { onMount } from 'svelte';
  import { Icon } from '$lib/theme';
  import type { ZshProfileInputDto } from '$lib/bindings';
  import { zshProfileLoad, zshProfileOpenFolder, zshProfileSave } from '$lib/ipc/commands';

  let loaded = $state(false);
  let zshrc = $state('');
  let plugins = $state('');
  let theme = $state('');
  let folder = $state('');
  let homeFiles = $state<string[]>([]);
  let defaults = $state<ZshProfileInputDto | null>(null);
  let saving = $state(false);
  let status = $state<{ kind: 'idle' } | { kind: 'ok'; text: string } | { kind: 'error'; text: string }>({ kind: 'idle' });

  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  async function load(): Promise<void> {
    try {
      const p = await zshProfileLoad();
      zshrc = p.zshrc;
      plugins = p.plugins;
      theme = p.theme;
      folder = p.folder;
      homeFiles = p.homeFiles;
      defaults = p.defaults;
    } catch {
      status = { kind: 'idle' };
    }
    loaded = true;
  }

  onMount(load);

  async function save(): Promise<void> {
    saving = true;
    status = { kind: 'idle' };
    try {
      await zshProfileSave({ zshrc, plugins, theme });
      status = { kind: 'ok', text: 'Saved. The next install on a server uses it.' };
    } catch (e) {
      status = { kind: 'error', text: message(e) };
    } finally {
      saving = false;
    }
  }

  function restoreDefaults(): void {
    if (!defaults) return;
    zshrc = defaults.zshrc;
    plugins = defaults.plugins;
    theme = defaults.theme;
    status = { kind: 'idle' };
  }

  async function openFolder(): Promise<void> {
    try {
      await zshProfileOpenFolder();
      await load();
    } catch (e) {
      status = { kind: 'error', text: message(e) };
    }
  }

  const field =
    'w-full rounded-lg bg-surface-inset px-3 py-2 text-sm text-fg outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-focus';
  const pill =
    'inline-flex shrink-0 items-center gap-1.5 rounded-full border border-strong px-4 py-1.5 text-sm text-fg transition hover:bg-accent hover:text-accent-fg disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
</script>

<div>
  <p class="mb-5 text-xs text-muted">
    What the <span class="text-fg">Install zsh</span> button on a host's card puts on the server. Plugins and zsh itself
    are downloaded on this computer and copied over, so the server needs no internet. Each download is kept, so later
    installs work without internet here too.
  </p>

  <div class="space-y-4">
    <div class="space-y-1 text-xs font-medium text-muted">
      <label for="zsh-zshrc" class="block">.zshrc</label>
      <textarea
        id="zsh-zshrc"
        aria-describedby="zsh-zshrc-hint"
        bind:value={zshrc}
        rows="16"
        class="{field} font-mono text-xs leading-relaxed"
        spellcheck="false"
      ></textarea>
      <p id="zsh-zshrc-hint" class="font-normal text-faint">
        The plugins load where it says <span class="font-mono">source ~/.zsh/plugins.zsh</span>; without that line they
        load at the end.
      </p>
    </div>

    <div class="space-y-1 text-xs font-medium text-muted">
      <label for="zsh-plugins" class="block">Plugins</label>
      <textarea
        id="zsh-plugins"
        aria-describedby="zsh-plugins-hint"
        bind:value={plugins}
        rows="5"
        class="{field} font-mono text-xs leading-relaxed"
        spellcheck="false"
        placeholder="zsh-users/zsh-autosuggestions"
      ></textarea>
      <p id="zsh-plugins-hint" class="font-normal text-faint">
        One GitHub repository per line, as owner/repo or owner/repo@branch. They load in this order, so keep
        zsh-syntax-highlighting last.
      </p>
    </div>

    <div class="space-y-1 text-xs font-medium text-muted">
      <label for="zsh-theme" class="block">Theme (optional)</label>
      <input
        id="zsh-theme"
        aria-describedby="zsh-theme-hint"
        bind:value={theme}
        class="{field} font-mono"
        placeholder="romkatv/powerlevel10k"
        spellcheck="false"
      />
      <p id="zsh-theme-hint" class="font-normal text-faint">A GitHub repository too, loaded before the plugins.</p>
    </div>

    <div class="space-y-1 text-xs text-muted">
      <p class="font-medium">Extra files</p>
      <p class="text-faint">
        Everything in the <span class="font-mono">home</span> folder of the profile is copied into the home folder on
        the server, such as a <span class="font-mono">.p10k.zsh</span> for powerlevel10k.
      </p>
      {#if homeFiles.length}
        <p class="font-mono text-muted">{homeFiles.join(', ')}</p>
      {/if}
      {#if folder}
        <p class="break-all font-mono text-faint">{folder}</p>
      {/if}
    </div>

    <div class="flex flex-wrap items-center gap-2 pt-1">
      <button type="button" class={pill} disabled={!loaded || saving} onclick={save}>
        <Icon name="check" size={14} />
        Save
      </button>
      <button type="button" class={pill} disabled={!loaded} onclick={openFolder}>
        <Icon name="folder" size={14} />
        Open profile folder
      </button>
      <button
        type="button"
        class="text-xs text-muted underline decoration-dotted hover:text-fg disabled:opacity-50"
        disabled={!defaults}
        onclick={restoreDefaults}
      >
        Back to the defaults
      </button>
    </div>

    {#if status.kind === 'ok'}
      <p class="flex items-center gap-1.5 text-xs text-status-ok"><Icon name="check" size={12} />{status.text}</p>
    {:else if status.kind === 'error'}
      <p class="text-xs text-status-crit">{status.text}</p>
    {/if}
  </div>
</div>
