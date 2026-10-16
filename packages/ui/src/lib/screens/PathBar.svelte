<script lang="ts">
  // A pane's current path, clickable: it opens a field to type a path into (Enter goes
  // there) with suggestions under it — what this pane shows (this computer or the
  // server, for the left one), favorites, the folders in this one, the ones above, and
  // recent ones (pathSuggestions.ts). Esc or a click outside closes it. The star in
  // front makes the current folder a favorite, or no longer one.
  import { tick } from 'svelte';
  import { Icon } from '$lib/theme';
  import { pathSuggestions } from './pathSuggestions';

  let {
    path,
    subfolders,
    recent,
    shortcuts = [],
    sources = [],
    onGo,
    onToggleFavorite,
    onShortcutContextMenu,
    onContextMenu
  }: {
    path: string;
    subfolders: string[];
    recent: string[];
    shortcuts?: Array<{ id: string; name: string; path: string }>;
    /** What the pane can show (the left one: this computer, or the server). */
    sources?: Array<{ label: string; active: boolean; onSelect: () => void }>;
    onGo: (path: string) => void;
    /** Stars or unstars the current folder. */
    onToggleFavorite?: () => void;
    onShortcutContextMenu?: (id: string, event: MouseEvent) => void;
    /** Right-click on the closed bar (copy / paste / set as default). */
    onContextMenu?: (event: MouseEvent) => void;
  } = $props();

  let open = $state(false);
  let typed = $state('');
  let inputEl = $state<HTMLInputElement>();
  const favorite = $derived(shortcuts.some((s) => s.path === path));
  const groups = $derived(open ? pathSuggestions({ path, typed, subfolders, recent, shortcuts }) : []);

  async function show(): Promise<void> {
    typed = path;
    open = true;
    await tick();
    inputEl?.select();
  }

  function go(to: string): void {
    open = false;
    const target = to.trim();
    if (target && target !== path) onGo(target);
  }

  const row =
    'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition hover:bg-surface-inset ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
</script>

<div class="relative mt-1 flex items-center gap-1">
  {#if onToggleFavorite}
    <button
      type="button"
      class="-ml-1 shrink-0 rounded-md p-0.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus
        {favorite ? 'text-status-warn [&_svg]:fill-current' : 'text-faint hover:text-fg'}"
      title={favorite ? 'Remove from favorites' : 'Add to favorites'}
      aria-label={favorite ? 'Remove from favorites' : 'Add to favorites'}
      aria-pressed={favorite}
      disabled={!path}
      onclick={onToggleFavorite}
    >
      <Icon name="star" size={12} />
    </button>
  {/if}
  <button
    type="button"
    class="group flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-0.5 {onToggleFavorite ? '' : '-ml-1'} -mr-1 text-left font-mono text-xs text-faint transition hover:bg-surface-inset hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    title="{path} — click to go elsewhere"
    aria-label="Path {path} — go elsewhere"
    aria-expanded={open}
    data-testid="pane-path"
    onclick={() => void show()}
    oncontextmenu={(event) => {
      if (!onContextMenu) return;
      event.preventDefault();
      onContextMenu(event);
    }}
  >
    <span class="min-w-0 flex-1 truncate">{path || '—'}</span>
    <span class="shrink-0 opacity-50 group-hover:opacity-100"><Icon name="search" size={11} /></span>
  </button>

  {#if open}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -- closes on Esc in the field too -->
    <div class="fixed inset-0 z-30" onclick={() => (open = false)}></div>
    <div class="absolute inset-x-0 top-0 z-40 rounded-lg border border-default bg-surface-raised shadow-soft" role="dialog" aria-label="Go to a folder">
      <input
        bind:this={inputEl}
        bind:value={typed}
        class="w-full rounded-t-lg border-b border-default bg-transparent px-2.5 py-2 font-mono text-xs text-fg outline-none placeholder:text-faint"
        placeholder="Type a path, or pick one below"
        aria-label="Path to go to"
        spellcheck="false"
        onkeydown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            go(typed);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            open = false;
          }
        }}
      />
      <div class="max-h-80 overflow-y-auto p-1.5">
        {#if sources.length > 0}
          <p class="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-faint">Show</p>
          <div class="flex gap-1 px-1 pb-1.5">
            {#each sources as source (source.label)}
              <button
                type="button"
                class="min-w-0 flex-1 truncate rounded-md border px-2 py-1 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus
                  {source.active ? 'border-accent text-fg' : 'border-default text-muted hover:text-fg'}"
                aria-pressed={source.active}
                onclick={() => {
                  open = false;
                  if (!source.active) source.onSelect();
                }}
              >
                {source.label}
              </button>
            {/each}
          </div>
        {/if}
        {#each groups as group (group.title)}
          <p class="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-faint">{group.title}</p>
          {#each group.items as item (item.path)}
            {@const shortcut = group.title === 'Favorites' ? shortcuts.find((s) => s.path === item.path) : undefined}
            <button
              type="button"
              class={row}
              title={item.path}
              onclick={() => go(item.path)}
              oncontextmenu={(event) => {
                if (!shortcut || !onShortcutContextMenu) return;
                event.preventDefault();
                open = false;
                onShortcutContextMenu(shortcut.id, event);
              }}
            >
              <Icon name={shortcut ? 'star' : 'folder'} size={12} />
              <span class="min-w-0 flex-1 truncate {group.title === 'In this folder' || shortcut ? '' : 'font-mono'}">{item.label}</span>
            </button>
          {/each}
        {/each}
      </div>
    </div>
  {/if}
</div>
