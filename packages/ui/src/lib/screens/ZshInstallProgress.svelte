<script lang="ts">
  import Modal from '$lib/components/Modal.svelte';
  import { Button, Icon, StatusDot } from '$lib/theme';
  import { zshInstall, dismissZshInstall, shellOutcome } from '$lib/stores/zshInstall';
</script>

{#if $zshInstall}
  {@const run = $zshInstall}
  {@const phase = run.phase}
  <Modal label="Install zsh" onClose={dismissZshInstall}>
    <div class="space-y-4 px-5 py-4">
      <div class="flex items-center gap-2.5">
        <Icon name="terminal" size={16} />
        <h2 class="min-w-0 truncate text-sm font-semibold">Install zsh — {run.hostName}</h2>
      </div>

      {#if phase.kind === 'running'}
        {@const index = phase.step?.index ?? 0}
        {@const total = phase.step?.total ?? 4}
        <div class="space-y-2">
          <div class="flex items-center justify-between gap-3 text-xs">
            <span class="min-w-0 truncate text-muted">{phase.step?.description ?? 'Connecting…'}</span>
            <span class="shrink-0 tabular-nums text-faint">{index}/{total}</span>
          </div>
          <div class="h-1.5 overflow-hidden rounded-full bg-surface-inset">
            <div
              class="h-full rounded-full bg-accent transition-[width] duration-300"
              style="width: {total ? Math.round((index / total) * 100) : 0}%"
            ></div>
          </div>
        </div>
        <p class="text-xs text-faint">
          Everything is downloaded on this computer and copied over, so the server needs no internet. An existing
          .zshrc is kept as a backup.
        </p>
      {:else if phase.kind === 'complete'}
        {@const r = phase.result}
        <div class="flex items-start gap-2.5">
          <span class="mt-0.5 shrink-0"><StatusDot status="ok" size={9} /></span>
          <div class="min-w-0 space-y-1.5">
            <p class="text-sm font-medium">zsh {r.zshVersion} is set up</p>
            <p class="break-all font-mono text-xs text-muted">{r.zshPath}{r.bundledZsh ? ' (brought along, no root needed)' : ''}</p>
            {#if r.plugins.length}
              <p class="text-xs text-muted">Plugins: {r.plugins.join(', ')}</p>
            {/if}
            {#if r.homeFiles.length}
              <p class="text-xs text-muted">Files: {r.homeFiles.join(', ')}</p>
            {/if}
            {#if r.backups.length}
              <p class="break-all text-xs text-muted">Backed up: {r.backups.join(', ')}</p>
            {/if}
            {#if r.offlineCopies.length}
              <p class="text-xs text-status-warn">
                No internet here, so the copies kept from last time were used for: {r.offlineCopies.join(', ')}
              </p>
            {/if}
            <p class="text-xs text-muted">{shellOutcome(r)}</p>
          </div>
        </div>
        <div class="flex justify-end">
          <Button variant="primary" onclick={dismissZshInstall}>Done</Button>
        </div>
      {:else}
        <div class="flex items-start gap-2.5">
          <span class="mt-0.5 shrink-0"><StatusDot status="crit" size={9} /></span>
          <div class="min-w-0 space-y-1">
            <p class="text-sm font-medium">zsh could not be installed</p>
            <p class="break-words text-xs text-muted">{phase.error}</p>
            <p class="text-xs text-faint">The login shell was not changed.</p>
          </div>
        </div>
        <div class="flex justify-end">
          <Button variant="ghost" onclick={dismissZshInstall}>Close</Button>
        </div>
      {/if}
    </div>
  </Modal>
{/if}
