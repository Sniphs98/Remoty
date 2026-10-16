<script lang="ts">
  // A small right-click menu positioned at the cursor (SFTP panes, tech-gui.md §3.2).
  // Same dismiss language as Modal (scrim click, Escape) but no backdrop dimming and no
  // centering — it opens exactly where the click happened, clamped to stay on-screen.
  // An item with `children` is a submenu: it opens beside the item on hover, a click,
  // or →, and flips to the left when there's no room on the right.
  import type { IconName } from '$lib/theme';
  import { Icon } from '$lib/theme';

  export interface ContextMenuItem {
    label: string;
    icon?: IconName;
    /** Not called for an item with `children`: that one opens them instead. */
    onSelect?: () => void;
    children?: ContextMenuItem[];
    /** A thin line above the item, to set a group apart. */
    separatorBefore?: boolean;
    disabled?: boolean;
    /** Destructive actions (Delete) render in the critical-status colour. */
    danger?: boolean;
    /** Shown on hover — why a disabled item can't be used, say. */
    hint?: string;
  }

  let { x, y, items, onClose }: { x: number; y: number; items: ContextMenuItem[]; onClose: () => void } =
    $props();

  let menuEl = $state<HTMLDivElement | undefined>();
  // Clamped so the menu never opens off the edge of the window, especially in a narrow
  // pane near the right side of the app. Undefined until the first measurement — the
  // template falls back to the raw click position for that first paint.
  let pos = $state<{ left: number; top: number } | undefined>(undefined);

  $effect(() => {
    const el = menuEl;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.min(x, Math.max(8, window.innerWidth - rect.width - 8));
    const top = Math.min(y, Math.max(8, window.innerHeight - rect.height - 8));
    pos = { left, top };
  });

  // The open submenu (by index), and whether it has to open to the left.
  let openSub = $state<number | null>(null);
  let subEl = $state<HTMLDivElement | undefined>();
  let subLeft = $state(false);
  $effect(() => {
    const el = subEl;
    if (!el) return;
    subLeft = false;
    requestAnimationFrame(() => {
      if (el.getBoundingClientRect().right > window.innerWidth - 8) subLeft = true;
    });
  });

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'ArrowLeft' && openSub !== null) {
      e.preventDefault();
      openSub = null;
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  function activate(item: ContextMenuItem): void {
    if (item.disabled) return;
    if (item.children) return;
    onClose();
    item.onSelect?.();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- Full-screen scrim, invisible: any click or a second right-click outside the menu
     dismisses it, matching how a native context menu behaves. -->
<button
  type="button"
  tabindex="-1"
  aria-label="Dismiss menu"
  class="fixed inset-0 z-40 cursor-default"
  onclick={onClose}
  oncontextmenu={(e) => {
    e.preventDefault();
    onClose();
  }}
></button>

<div
  bind:this={menuEl}
  role="menu"
  class="fixed z-50 min-w-[11rem] rounded-lg border border-default bg-surface-raised py-1 shadow-soft"
  style="left: {pos?.left ?? x}px; top: {pos?.top ?? y}px;"
>
  {#each items as item, i (i)}
    {#if item.separatorBefore}<div class="my-1 border-t border-default" role="separator"></div>{/if}
    <!-- svelte-ignore a11y_no_static_element_interactions -- hover only opens the submenu; click and → do too -->
    <div class="relative" onmouseenter={() => (openSub = item.children ? i : null)}>
      <button
        type="button"
        role="menuitem"
        disabled={item.disabled}
        title={item.hint}
        aria-haspopup={item.children ? 'menu' : undefined}
        aria-expanded={item.children ? openSub === i : undefined}
        class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm transition
          disabled:cursor-not-allowed disabled:opacity-40
          {item.danger ? 'text-status-crit hover:bg-status-crit/10' : 'text-fg hover:bg-surface-inset'}
          {item.children && openSub === i ? 'bg-surface-inset' : ''}"
        onclick={() => (item.children ? (openSub = i) : activate(item))}
        onkeydown={(e) => {
          if (item.children && e.key === 'ArrowRight') {
            e.preventDefault();
            openSub = i;
          }
        }}
      >
        {#if item.icon}<Icon name={item.icon} size={14} />{/if}
        <span class="min-w-0 flex-1 truncate">{item.label}</span>
        {#if item.children}<span class="-mr-1 inline-flex rotate-180 text-faint"><Icon name="arrow-left" size={12} /></span>{/if}
      </button>
      {#if item.children && openSub === i}
        <div
          bind:this={subEl}
          role="menu"
          aria-label={item.label}
          class="absolute top-0 z-50 -mt-1 min-w-[11rem] max-w-[22rem] rounded-lg border border-default bg-surface-raised py-1 shadow-soft
            {subLeft ? 'right-full mr-1' : 'left-full ml-1'}"
        >
          {#each item.children as child, j (j)}
            <button
              type="button"
              role="menuitem"
              disabled={child.disabled}
              title={child.hint}
              class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm text-fg transition hover:bg-surface-inset disabled:cursor-not-allowed disabled:opacity-40"
              onclick={() => activate(child)}
            >
              {#if child.icon}<Icon name={child.icon} size={14} />{/if}
              <span class="min-w-0 flex-1 truncate">{child.label}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
</div>
