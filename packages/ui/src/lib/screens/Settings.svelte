<script lang="ts">
  // Settings (tech-gui.md §4.3) as one window in the middle of the page: the parts on its
  // left (across its top on a narrow window), the chosen part beside them. Every control
  // sits with its label — a switch before it, a choice below it — never at a far edge. General holds the
  // theme mirrored from the sidebar (§5.1), streamer mode and the metric auto-refresh
  // interval; Updates the update preferences (`check_on_startup`) and a manual check,
  // persisted to the shared config via `save_update_config`.
  import { onMount } from 'svelte';
  import type { UpdateConfigDto } from '$lib/bindings';
  import { Icon } from '$lib/theme';
  import { theme } from '$lib/stores/theme';
  import { streamerMode } from '$lib/stores/streamer';
  import { refreshInterval, REFRESH_OPTIONS } from '$lib/stores/settings';
  import { terminalCopyOnSelect, terminalGpu, terminalRightClick } from '$lib/stores/terminalPrefs';
  import { offerUpdate } from '$lib/stores/update';
  import { lastError } from '$lib/stores/notifications';
  import { checkUpdate, loadUpdateConfig, saveUpdateConfig } from '$lib/ipc/commands';
  import GitHubSettings from '$lib/components/GitHubSettings.svelte';
  import AiSettings from '$lib/components/AiSettings.svelte';
  import { settingsSection, type SettingsSection } from '$lib/stores/settingsSection';
  import type { IconName } from '$lib/theme/icons';

  const SECTIONS: { id: SettingsSection; label: string; icon: IconName; blurb: string }[] = [
    { id: 'general', label: 'General', icon: 'sun', blurb: 'Theme, privacy and the dashboard.' },
    { id: 'terminal', label: 'Terminal', icon: 'terminal', blurb: 'Mouse, clipboard and drawing in terminal tabs.' },
    { id: 'ai', label: 'AI', icon: 'sparkle', blurb: 'The AI helper next to each terminal.' },
    { id: 'github', label: 'GitHub', icon: 'branch', blurb: 'Sign-in for automations that use GitHub.' },
    { id: 'updates', label: 'Updates', icon: 'download', blurb: 'New versions of Remoty.' }
  ];
  const current = $derived(SECTIONS.find((s) => s.id === $settingsSection) ?? SECTIONS[0]);

  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  const formatInterval = (secs: number): string => (secs < 60 ? `${secs}s` : `${secs / 60}m`);

  let updateConfig = $state<UpdateConfigDto | null>(null);
  type CheckState =
    | { kind: 'idle' }
    | { kind: 'checking' }
    | { kind: 'upToDate' }
    | { kind: 'available'; version: string }
    | { kind: 'error'; message: string };
  let check = $state<CheckState>({ kind: 'idle' });

  onMount(async () => {
    try {
      updateConfig = await loadUpdateConfig();
    } catch (e) {
      lastError.set(message(e));
    }
  });

  // Persist immediately; revert the optimistic flip if the write fails. Read-modify-write
  // fresh rather than from the mount-time cache: the update banner may have written a
  // `skipVersion` out-of-band, and `save_update_config` replaces the whole [update]
  // section — writing a stale copy would clobber that skip.
  async function toggleCheckOnStartup(): Promise<void> {
    if (!updateConfig) return;
    const previous = updateConfig;
    const desired = !previous.checkOnStartup;
    updateConfig = { ...previous, checkOnStartup: desired };
    try {
      const current = await loadUpdateConfig();
      const next = { ...current, checkOnStartup: desired };
      await saveUpdateConfig(next);
      updateConfig = next;
    } catch (e) {
      updateConfig = previous;
      lastError.set(message(e));
    }
  }

  async function checkNow(): Promise<void> {
    check = { kind: 'checking' };
    try {
      const info = await checkUpdate();
      if (info) {
        offerUpdate(info); // raise the banner too
        check = { kind: 'available', version: info.version };
      } else {
        check = { kind: 'upToDate' };
      }
    } catch (e) {
      check = { kind: 'error', message: message(e) };
    }
  }

  const seg =
    'rounded-lg px-3 py-1.5 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
  const segState = (active: boolean): string =>
    active ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-surface-inset hover:text-fg';
  const navItem = (active: boolean): string =>
    `flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus md:w-full ${
      active ? 'bg-surface font-medium text-fg shadow-soft' : 'text-muted hover:bg-surface hover:text-fg'
    }`;
  const switchCls = (on: boolean): string =>
    `relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${on ? 'bg-accent' : 'bg-surface-inset'}`;
  const knob = (on: boolean): string =>
    `absolute top-0.5 h-5 w-5 rounded-full bg-surface shadow-soft transition-[left] ${on ? 'left-[1.375rem]' : 'left-0.5'}`;
  const group = 'border-t border-default pt-4 first:border-t-0 first:pt-0';
  const kicker = 'mb-2 text-[11px] font-medium uppercase tracking-wider text-faint';

  let appVersion = $state<string | null>(null);
  onMount(() => {
    (window as unknown as { remoty?: { appVersion?: () => Promise<string> } }).remoty
      ?.appVersion?.()
      .then((v) => (appVersion = v))
      .catch(() => {});
  });
</script>

<section class="flex h-full min-h-0 items-start justify-center overflow-hidden p-0 md:p-8 lg:p-12">
  <div
    class="flex h-full min-h-0 w-full max-w-5xl flex-col overflow-hidden bg-surface md:max-h-[52rem] md:flex-row md:rounded-2xl md:border md:border-default md:shadow-soft"
  >
    <nav
      class="flex shrink-0 gap-1 overflow-x-auto border-b border-default bg-bg p-3 md:w-60 md:flex-col md:overflow-visible md:border-b-0 md:border-r md:p-4"
      aria-label="Settings sections"
    >
      <h1 class="mb-4 hidden px-3 pt-1 text-xl font-semibold tracking-tight md:block">Settings</h1>
      {#each SECTIONS as s (s.id)}
        <button type="button" class={navItem(s.id === current.id)} aria-current={s.id === current.id ? 'page' : undefined} onclick={() => settingsSection.set(s.id)}>
          <Icon name={s.icon} size={15} />
          {s.label}
        </button>
      {/each}
      {#if appVersion}<p class="mt-auto hidden px-3 pt-4 text-xs text-faint md:block">Remoty {appVersion}</p>{/if}
    </nav>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="max-w-3xl px-6 py-6 md:px-10 md:py-8">
        <h1 class="sr-only md:hidden">Settings</h1>
        <header class="mb-6">
          <h2 class="text-xl font-semibold tracking-tight">{current.label}</h2>
          <p class="text-sm text-muted">{current.blurb}</p>
        </header>

        {#if current.id === 'general'}
          <div class="space-y-6">
            <div class={group}>
              <h3 class={kicker}>Appearance</h3>
              <p class="text-sm">Theme</p>
              <p class="text-xs text-muted">Also switches with the sun/moon button in the sidebar.</p>
              <div class="mt-2.5 inline-flex gap-1 rounded-xl bg-surface-inset p-1">
                <button type="button" class="{seg} {segState($theme === 'light')}" aria-pressed={$theme === 'light'} onclick={() => theme.set('light')}>
                  <span class="flex items-center gap-1.5"><Icon name="sun" size={14} /> Light</span>
                </button>
                <button type="button" class="{seg} {segState($theme === 'dark')}" aria-pressed={$theme === 'dark'} onclick={() => theme.set('dark')}>
                  <span class="flex items-center gap-1.5"><Icon name="moon" size={14} /> Dark</span>
                </button>
              </div>
            </div>

            <div class={group}>
              <h3 class={kicker}>Privacy</h3>
              <div class="flex items-start gap-3">
                <button
                  type="button"
                  role="switch"
                  aria-checked={$streamerMode}
                  aria-label="Streamer mode"
                  onclick={() => streamerMode.toggle()}
                  class={switchCls($streamerMode)}
                >
                  <span class={knob($streamerMode)}></span>
                </button>
                <div class="min-w-0">
                  <p class="text-sm">Streamer mode</p>
                  <p class="text-xs text-muted">Mask host addresses with realistic fakes, so real IPs stay off-screen while recording.</p>
                </div>
              </div>
            </div>

            <div class={group}>
              <h3 class={kicker}>Dashboard</h3>
              <p class="text-sm">Auto-refresh interval</p>
              <p class="text-xs text-muted">How often the dashboard forces a metric refresh.</p>
              <div class="mt-2.5 inline-flex flex-wrap gap-1 rounded-xl bg-surface-inset p-1">
                {#each REFRESH_OPTIONS as secs (secs)}
                  <button
                    type="button"
                    class="{seg} tabular-nums {segState($refreshInterval === secs)}"
                    aria-pressed={$refreshInterval === secs}
                    onclick={() => refreshInterval.set(secs)}
                  >
                    {formatInterval(secs)}
                  </button>
                {/each}
              </div>
            </div>
          </div>
        {:else if current.id === 'terminal'}
          <div class="space-y-6">
            <div class={group}>
              <h3 class={kicker}>Mouse</h3>
              <p class="text-sm">Right-click</p>
              <p class="text-xs text-muted">
                Open a menu with Copy and Paste, paste immediately the way PuTTY does, or copy the selection and paste when
                nothing is selected, like Windows Terminal.
              </p>
              <div class="mt-2.5 inline-flex gap-1 rounded-xl bg-surface-inset p-1">
                <button type="button" class="{seg} {segState($terminalRightClick === 'menu')}" aria-pressed={$terminalRightClick === 'menu'} onclick={() => terminalRightClick.set('menu')}>
                  Menu
                </button>
                <button type="button" class="{seg} {segState($terminalRightClick === 'paste')}" aria-pressed={$terminalRightClick === 'paste'} onclick={() => terminalRightClick.set('paste')}>
                  Paste
                </button>
                <button
                  type="button"
                  class="{seg} {segState($terminalRightClick === 'copyPaste')}"
                  aria-pressed={$terminalRightClick === 'copyPaste'}
                  onclick={() => terminalRightClick.set('copyPaste')}
                >
                  Copy / Paste
                </button>
              </div>
            </div>

            <div class="{group} space-y-4">
              <h3 class={kicker}>Clipboard and drawing</h3>
              <div class="flex items-start gap-3">
                <button
                  type="button"
                  role="switch"
                  aria-checked={$terminalCopyOnSelect}
                  aria-label="Copy on selection"
                  onclick={() => terminalCopyOnSelect.set(!$terminalCopyOnSelect)}
                  class={switchCls($terminalCopyOnSelect)}
                >
                  <span class={knob($terminalCopyOnSelect)}></span>
                </button>
                <div class="min-w-0">
                  <p class="text-sm">Copy on selection</p>
                  <p class="text-xs text-muted">Selecting text copies it straight away. Ctrl+Shift+C and Ctrl+Shift+V always work either way.</p>
                </div>
              </div>
              <div class="flex items-start gap-3">
                <button
                  type="button"
                  role="switch"
                  aria-checked={$terminalGpu}
                  aria-label="GPU acceleration"
                  onclick={() => terminalGpu.set(!$terminalGpu)}
                  class={switchCls($terminalGpu)}
                >
                  <span class={knob($terminalGpu)}></span>
                </button>
                <div class="min-w-0">
                  <p class="text-sm">GPU acceleration</p>
                  <p class="text-xs text-muted">Draw terminals with WebGL, much faster under heavy output. Turn off if text renders garbled.</p>
                </div>
              </div>
            </div>
          </div>
        {:else if current.id === 'ai'}
          <AiSettings />
        {:else if current.id === 'github'}
          <GitHubSettings />
        {:else}
          <div class="space-y-6">
            <div class={group}>
              <h3 class={kicker}>Automatic</h3>
              <div class="flex items-start gap-3">
                <button
                  type="button"
                  role="switch"
                  aria-checked={updateConfig?.checkOnStartup ?? false}
                  aria-label="Check for updates on startup"
                  disabled={!updateConfig}
                  onclick={toggleCheckOnStartup}
                  class={switchCls(updateConfig?.checkOnStartup ?? false)}
                >
                  <span class={knob(updateConfig?.checkOnStartup ?? false)}></span>
                </button>
                <div class="min-w-0">
                  <p class="text-sm">Check for updates on startup</p>
                  <p class="text-xs text-muted">Look for a newer release when the app launches.</p>
                </div>
              </div>
            </div>

            <div class={group}>
              <h3 class={kicker}>Now</h3>
              <p class="text-sm">Manual check</p>
              <p class="text-xs text-muted">
                {#if check.kind === 'checking'}Checking…
                {:else if check.kind === 'upToDate'}You're on the latest version.
                {:else if check.kind === 'available'}Version {check.version} is available.
                {:else if check.kind === 'error'}{check.message}
                {:else}Check GitHub for a newer release.
                {/if}
              </p>
              <button
                type="button"
                class="mt-2.5 inline-flex items-center gap-1.5 rounded-full border border-strong px-4 py-1.5 text-sm text-fg transition hover:bg-accent hover:text-accent-fg disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                disabled={check.kind === 'checking'}
                onclick={checkNow}
              >
                <Icon name="refresh" size={14} />
                Check now
              </button>
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>
</section>
