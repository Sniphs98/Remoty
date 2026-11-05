<script lang="ts">
  // Settings → 1Password: how to set 1Password up for the app, step by step, for someone
  // who doesn't have it yet. The app, the CLI (with whether it's installed here, the
  // command that installs it and a check again), the CLI integration in the 1Password
  // app, then how a host, a remote desktop or the GitHub token uses it, and the SSH agent.
  // Nothing here is saved: 1Password itself holds every setting this needs.
  import { onMount } from 'svelte';
  import type { OnePasswordStatusDto } from '$lib/bindings';
  import { onePasswordStatus } from '$lib/ipc/commands';
  import { openExternal } from '$lib/ipc/openExternal';
  import { Icon } from '$lib/theme';
  import { cachedOnePasswordStatus, rememberOnePasswordStatus } from '$lib/stores/onePassword';

  const APP_DOWNLOAD = 'https://1password.com/downloads/';
  const CLI_DOCS = 'https://developer.1password.com/docs/cli/get-started/';
  const SSH_AGENT_DOCS = 'https://developer.1password.com/docs/ssh/agent/';
  const SECRET_REFERENCE_DOCS = 'https://developer.1password.com/docs/cli/secret-reference-syntax/';

  let status = $state<OnePasswordStatusDto | null>(cachedOnePasswordStatus());
  let checking = $state(false);
  let checkFailed = $state(false);
  let copied = $state(false);

  async function check(): Promise<void> {
    checking = true;
    checkFailed = false;
    try {
      status = await onePasswordStatus();
      rememberOnePasswordStatus(status);
    } catch {
      // Not under Electron, or the check itself failed: the steps still show.
      status = null;
      checkFailed = true;
    } finally {
      checking = false;
    }
  }

  async function copyCommand(): Promise<void> {
    if (!status?.command) return;
    try {
      await navigator.clipboard.writeText(status.command);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // Clipboard unavailable: the command is shown to select by hand.
    }
  }

  onMount(() => {
    if (!status) void check();
  });

  const group = 'border-t border-default pt-4 first:border-t-0 first:pt-0';
  const kicker = 'mb-2 text-[11px] font-medium uppercase tracking-wider text-faint';
  const step = 'flex gap-3';
  const num =
    'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-inset text-[11px] font-medium tabular-nums text-muted';
  const small =
    'inline-flex items-center gap-1 rounded-full border border-default px-2 py-0.5 text-[11px] font-medium text-muted ' +
    'transition hover:border-strong hover:bg-accent hover:text-accent-fg disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
  const link = 'underline decoration-dotted hover:text-fg';
  const path = 'text-fg';
</script>

<div class="space-y-6">
  <p class="text-xs text-muted">
    With 1Password, a host or a remote desktop connection keeps a reference to the 1Password item instead of the
    address, user or password itself. The app reads the value when it connects, keeps it in memory for 10 minutes and
    never writes it to disk. Only needed if you want to use 1Password — everything works without it.
  </p>

  <div class={group}>
    <h3 class={kicker}>Status</h3>
    {#if checking}
      <p class="text-sm text-muted">Looking for the 1Password CLI…</p>
    {:else if status?.installed}
      <p class="flex items-center gap-1.5 text-sm text-status-ok" role="status">
        <Icon name="check" size={14} />
        1Password CLI {status.version ?? ''} found. If a connection still can't read from 1Password, check step 3.
      </p>
    {:else if status}
      <p class="text-sm" role="status">The 1Password CLI isn't installed yet. Follow the steps below.</p>
    {:else if checkFailed}
      <p class="text-sm text-muted" role="status">Couldn't check for the 1Password CLI here. The steps below still apply.</p>
    {/if}
    <button type="button" class="{small} mt-2" disabled={checking} onclick={check}>
      <Icon name="refresh" size={11} />
      {checking ? 'Checking…' : 'Check again'}
    </button>
  </div>

  <div class={group}>
    <h3 class={kicker}>Set up</h3>
    <ol class="space-y-4">
      <li class={step}>
        <span class={num}>1</span>
        <div class="min-w-0 space-y-1">
          <p class="text-sm">Install the 1Password app and sign in</p>
          <p class="text-xs text-muted">
            You need a 1Password account. The desktop app unlocks the CLI and the SSH agent, with Windows Hello or Touch
            ID if you like.
            <button type="button" class={link} onclick={() => void openExternal(APP_DOWNLOAD)}>Download 1Password</button>
          </p>
        </div>
      </li>

      <li class={step}>
        <span class={num}>2</span>
        <div class="min-w-0 space-y-1.5">
          <p class="text-sm">Install the 1Password CLI</p>
          <p class="text-xs text-muted">
            The app reads the values through it (<code class="font-mono">op</code>).{#if status?.command}{' '}Install it
              with:{:else}{' '}The guide shows how to install it on your system.{/if}
          </p>
          {#if status?.command}
            <div class="flex items-center gap-2">
              <code class="min-w-0 flex-1 select-text truncate rounded-md bg-surface-inset px-2 py-1 font-mono text-xs text-fg">{status.command}</code>
              <button type="button" class={small} onclick={copyCommand}>
                <Icon name={copied ? 'check' : 'file'} size={11} />
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          {/if}
          <button type="button" class="{link} text-xs text-muted" onclick={() => void openExternal(status?.docsUrl ?? CLI_DOCS)}>
            CLI setup guide
          </button>
        </div>
      </li>

      <li class={step}>
        <span class={num}>3</span>
        <div class="min-w-0 space-y-1">
          <p class="text-sm">Connect the CLI to the app</p>
          <p class="text-xs text-muted">
            In the 1Password app, turn on <span class={path}>Settings → Developer → Integrate with 1Password CLI</span>.
            Then click <span class={path}>Check again</span> above.
          </p>
        </div>
      </li>

      <li class={step}>
        <span class={num}>4</span>
        <div class="min-w-0 space-y-1">
          <p class="text-sm">Use it in a host or remote desktop connection</p>
          <p class="text-xs text-muted">
            In 1Password, right-click a field of the item and choose <span class={path}>Copy Secret Reference</span>
            (e.g. <code class="font-mono text-fg">op://Servers/web-1/password</code>). In the app, click the
            <span class={path}>1Password</span> button next to the hostname, port, user, password, domain or default
            path, and paste the reference. The GitHub token in <span class={path}>Settings → GitHub</span> works the
            same way.
            <button type="button" class={link} onclick={() => void openExternal(SECRET_REFERENCE_DOCS)}>About references</button>
          </p>
        </div>
      </li>
    </ol>
  </div>

  <div class={group}>
    <h3 class={kicker}>SSH keys (optional)</h3>
    <p class="text-sm">Use the 1Password SSH agent</p>
    <p class="mt-1 text-xs text-muted">
      In the 1Password app, turn on <span class={path}>Settings → Developer → Use the SSH agent</span>. The app asks
      the SSH agent for keys before anything else, so your keys in 1Password just work — no key file needed on the host.
    </p>
    <p class="mt-1 text-xs text-muted">
      On Windows, stop and disable the <span class={path}>OpenSSH Authentication Agent</span> service first (Services
      app, or <code class="font-mono text-fg">Stop-Service ssh-agent; Set-Service ssh-agent -StartupType Disabled</code>
      in an admin PowerShell), since 1Password's agent takes its place.
      <button type="button" class={link} onclick={() => void openExternal(SSH_AGENT_DOCS)}>SSH agent guide</button>
    </p>
  </div>
</div>
